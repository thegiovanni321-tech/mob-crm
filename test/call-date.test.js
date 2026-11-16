const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CallDate = require('../public/call-date.js');

function input(value, manual) {
  const attrs = { 'data-call-date': manual ? 'manual' : 'auto' };
  return {
    value,
    form: null,
    getAttribute(k) { return attrs[k] || ''; },
    setAttribute(k, v) { attrs[k] = v; },
  };
}

test('an untouched stale call date becomes today, and a picked date stays', () => {
  const logged = new Date('2026-11-11T16:27:00Z');
  assert.equal(CallDate.today(logged), '2026-11-11');
  const stale = input('2026-11-10', false);
  assert.equal(CallDate.submitValue(stale, logged), '2026-11-11');
  assert.equal(stale.value, '2026-11-11');
  const leftOpen = input('2026-11-10', false);
  assert.equal(CallDate.refresh(leftOpen, logged), '2026-11-11');
  assert.equal(leftOpen.getAttribute('data-call-date'), 'auto');

  const backdated = input('2026-11-10', false);
  backdated.value = '2026-11-01';
  CallDate.noteChange(backdated);
  assert.equal(backdated.getAttribute('data-call-date'), 'manual');
  assert.equal(CallDate.refresh(backdated, logged), '2026-11-01');
  assert.equal(CallDate.submitValue(backdated, logged), '2026-11-01');

  const beforeMidnight = new Date('2026-11-11T04:59:00Z');
  const afterMidnight = new Date('2026-11-11T05:00:00Z');
  assert.equal(CallDate.today(beforeMidnight), '2026-11-10');
  assert.equal(CallDate.today(afterMidnight), '2026-11-11');
});

const PASSWORD = 'synthetic-test-password';
const PORT = 3472;
const BASE = `http://127.0.0.1:${PORT}`;

function seed(dataDir, dates) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `
      const { migrate } = require('./src/db');
      (async () => {
        const db = await migrate();
        const [p] = await db.query("INSERT INTO properties (address, city, state, status, last_contacted, source) VALUES ('1 Synthetic Plaza', 'Sampleville', 'FL', 'Attempted', $1, 'synthetic') RETURNING id", [process.env.SEED_YESTERDAY]);
        const [call] = await db.query("INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1, 'call', 'Left voicemail', 'Left a message', $2) RETURNING id", [p.id, process.env.SEED_YESTERDAY]);
        const [imp] = await db.query("INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1, 'import', 'Called', 'Imported row', $2) RETURNING id", [p.id, process.env.SEED_IMPORT]);
        const [note] = await db.query("INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1, 'note', 'Note', 'Just a note', $2) RETURNING id", [p.id, process.env.SEED_NOTE]);
        console.log(JSON.stringify({ property: p.id, call: call.id, imp: imp.id, note: note.id }));
      })().catch((e) => { console.error(e); process.exit(1); });
    `], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR: dataDir, DATABASE_URL: '', SEED_YESTERDAY: dates.yesterday, SEED_IMPORT: dates.imported, SEED_NOTE: dates.note },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('exit', (code) => code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(err || out)));
  });
}
function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: 'test', DELTA_WATCH: '0', APP_PASSWORD: PASSWORD, SESSION_SECRET: 'synthetic-test-secret-value', DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const onData = (buf) => { log += buf.toString(); if (log.includes('MOB CRM on')) resolve(child); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited ' + code + '\n' + log)));
    setTimeout(() => reject(new Error('timeout\n' + log)), 30000);
  });
}
async function login() {
  const res = await fetch(BASE + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }, body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual' });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function shift(day, n) {
  const x = new Date(day + 'T12:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function shown(day) {
  const [y, m, d] = day.split('-');
  return `${m}/${d}/${y}`;
}
function countOf(html) {
  const m = html.match(/(\d+) calls? today/);
  if (!m) throw new Error('no call count');
  return Number(m[1]);
}

test('voicemail and text are logged calls, and only a call date can be edited', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-call-date-'));
  const today = CallDate.today();
  const yesterday = shift(today, -1);
  const ids = await seed(dataDir, { yesterday, imported: '2026-01-02', note: '2026-01-03' });
  const child = await startServer(dataDir);
  try {
    const denied = await fetch(`${BASE}/properties/${ids.property}/activities/${ids.call}/date`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: new URLSearchParams({ activity_date: today }), redirect: 'manual',
    });
    assert.equal(denied.status, 401);

    const cookie = await login();
    const before = countOf(await (await fetch(BASE + '/', { headers: { cookie } })).text());
    const page = await (await fetch(`${BASE}/properties/${ids.property}?from=cb&cb_at=0`, { headers: { cookie } })).text();
    assert.match(page, /data-call-date="auto"/);
    assert.match(page, /src="\/static\/call-date\.js"/);
    assert.match(page, new RegExp(`action="/properties/${ids.property}/activities/${ids.call}/date"`));
    assert.doesNotMatch(page, new RegExp(`activities/${ids.imp}/date`));
    assert.doesNotMatch(page, new RegExp(`activities/${ids.note}/date`));
    assert.match(page, /name="from" value="cb"/);
    assert.equal(countOf(page), before);

    const saved = await fetch(`${BASE}/properties/${ids.property}/activities/${ids.call}/date`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
      body: new URLSearchParams({ activity_date: today, from: 'cb', cb_at: '0' }), redirect: 'manual',
    });
    assert.equal(saved.status, 302);
    assert.match(saved.headers.get('location') || '', /from=cb/);
    const after = await (await fetch(BASE + saved.headers.get('location'), { headers: { cookie } })).text();
    assert.match(after, /<b>Left voicemail<\/b>/);
    assert.match(after, new RegExp(`value="${today}"`));
    assert.ok(after.includes(shown(today)));
    const fact = after.match(/<dt>Last contacted<\/dt><dd>([^<]+)<\/dd>/);
    assert.ok(fact, 'last contacted fact');
    assert.equal(fact[1], shown(yesterday));
    assert.equal(countOf(after), before + 1);

    const blocked = await fetch(`${BASE}/properties/${ids.property}/activities/${ids.imp}/date`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
      body: new URLSearchParams({ activity_date: today }), redirect: 'manual',
    });
    assert.equal(blocked.status, 400);
    const noteBlocked = await fetch(`${BASE}/properties/${ids.property}/activities/${ids.note}/date`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
      body: new URLSearchParams({ activity_date: today }), redirect: 'manual',
    });
    assert.equal(noteBlocked.status, 400);
    const still = await (await fetch(`${BASE}/properties/${ids.property}`, { headers: { cookie } })).text();
    assert.match(still, /01\/02\/2026/);
    assert.match(still, /01\/03\/2026/);
    assert.equal(countOf(still), before + 1);

    const texted = await fetch(`${BASE}/properties/${ids.property}/activities`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
      body: new URLSearchParams({ kind: 'call', outcome: 'Texted', activity_date: today, notes: 'Sent a text' }), redirect: 'manual',
    });
    const listed = await (await fetch(BASE + texted.headers.get('location'), { headers: { cookie } })).text();
    assert.match(listed, /<li class="k-call"><div><b>Texted<\/b>/);
    assert.match(listed, /<li class="k-call"><div><b>Left voicemail<\/b>/);
    assert.doesNotMatch(listed, /class="k-voicemail"|class="k-text"/);
    assert.equal(countOf(listed), before + 2);
  } finally {
    child.kill('SIGTERM');
  }
});
