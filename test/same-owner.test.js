const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const People = require('../src/same-person');

test('same person matches a shared phone, never a name or phone by itself', () => {
  const ada = { id: 1, name: 'Ada Sample', phone1: '(555) 010-1000' };
  const adaAgain = { id: 2, name: 'Ada Sample', phone1: '5550101000' };
  const nameOnly = { id: 3, name: 'Ada Sample', phone1: '555-010-2000' };
  const phoneOnly = { id: 4, name: 'Bea Sample', phone1: '555-010-1000' };
  const blank = { id: 5, name: '', phone1: '555-010-1000' };
  assert.equal(People.samePerson(ada, ada), true);
  assert.equal(People.samePerson(ada, adaAgain), true);
  assert.equal(People.samePerson(ada, nameOnly), false);
  assert.equal(People.samePerson(ada, phoneOnly), false);
  assert.equal(People.samePerson(ada, blank), false);
  const owners = [ada, adaAgain, nameOnly, phoneOnly];
  const rows = [
    { propertyId: 10, ownerId: 1, address: 'High', score: 100 },
    { propertyId: 11, ownerId: 2, address: 'Also', score: 10 },
    { propertyId: 12, ownerId: 3, address: 'Name only', score: 80 },
    { propertyId: 13, ownerId: 4, address: 'Phone only', score: 70 },
  ];
  const grouped = People.collapseByOwner(rows, owners);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].propertyId, 10);
  assert.equal(grouped[0].also.length, 1);
  assert.equal(grouped[0].also[0].address, 'Also');
  assert.deepEqual(grouped.map((row) => row.propertyId), [10, 12, 13]);
});

const PASSWORD = 'synthetic-test-password';
const PORT = 3473;
const BASE = `http://127.0.0.1:${PORT}`;

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
async function post(cookie, url, fields) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') || '' };
}
function countOf(html) {
  const match = html.match(/(\d+) calls? today/);
  if (!match) throw new Error('no call count');
  return Number(match[1]);
}

test('callbacks list each owner once, and one logged call covers their other properties', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-same-owner-'));
  const child = await startServer(dataDir);
  try {
    const cookie = await login();
    const make = async (address, owner) => {
      const created = await post(cookie, '/properties', { address, city: 'Sampleville', state: 'FL', status: 'New', ...owner });
      const id = created.location.match(/\/properties\/(\d+)/)[1];
      const page = await (await fetch(`${BASE}/properties/${id}`, { headers: { cookie } })).text();
      const ownerId = (page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/) || [])[1] || '';
      return { id, ownerId };
    };
    const high = await make('1 Ada High', { o_name: 'Ada Sample', o_entity: 'Ada LLC', o_phone1: '555-010-1000' });
    const low = await make('2 Ada Low', {});
    await post(cookie, `/properties/${low.id}/owners/${high.ownerId}/link`, {});
    const third = await make('3 Ada Unchecked', {});
    await post(cookie, `/properties/${third.id}/owners/${high.ownerId}/link`, {});
    const other = await make('4 Bea Later', { o_name: 'Bea Sample', o_entity: 'Bea LLC', o_phone1: '555-010-3000' });
    await post(cookie, `/properties/${high.id}/activities`, { kind: 'call', outcome: 'Talked', owner_id: high.ownerId, activity_date: '2020-01-15', notes: 'She is interested in selling.' });
    await post(cookie, `/properties/${low.id}/activities`, { kind: 'call', outcome: 'Talked', owner_id: high.ownerId, activity_date: '2020-01-20', notes: 'Short hello.' });
    await post(cookie, `/properties/${other.id}/activities`, { kind: 'call', outcome: 'Talked', owner_id: other.ownerId, activity_date: '2020-02-01', notes: 'Please call back in 3 months.' });

    const list = await (await fetch(BASE + '/callbacks', { headers: { cookie } })).text();
    assert.match(list, /Most likely to sell <span class="muted">\(2\)<\/span>/);
    assert.match(list, /Also owns: 1 property/);
    assert.match(list, /2 Ada Low/);
    assert.match(list, new RegExp(`/properties/${high.id}\\?from=cb`));
    assert.doesNotMatch(list, new RegExp(`/properties/${low.id}\\?from=cb`));
    const opened = await (await fetch(`${BASE}/properties/${high.id}?from=cb&cb_at=0`, { headers: { cookie } })).text();
    const next = opened.match(/<a class="prop-arrow" href="([^"]+)" rel="next"/);
    assert.ok(next, 'next owner');
    assert.match(next[1], new RegExp(`/properties/${other.id}\\?`));
    assert.match(next[1], /from=cb/);
    assert.doesNotMatch(next[1], new RegExp(`/properties/${low.id}`));
    assert.match(opened, new RegExp(`name="also_${low.id}"`));
    assert.match(opened, new RegExp(`name="also_${third.id}"`));
    assert.match(opened, /Copies on the other properties of this owner will be deleted too/);

    const dueA = await make('5 Due Ada', {});
    await post(cookie, `/properties/${dueA.id}/owners/${high.ownerId}/link`, {});
    const dueB = await make('6 Due Ada', {});
    await post(cookie, `/properties/${dueB.id}/owners/${high.ownerId}/link`, {});
    for (const id of [dueA.id, dueB.id]) {
      await post(cookie, '/properties/' + id, { address: id === dueA.id ? '5 Due Ada' : '6 Due Ada', city: 'Sampleville', state: 'FL', status: 'Attempted', callback_date: '2026-11-01' });
    }
    const duePage = await (await fetch(BASE + '/callbacks', { headers: { cookie } })).text();
    assert.match(duePage, /Due or overdue <span class="muted">\(1, most recent first\)<\/span>/);
    assert.match(duePage, /Also owns: 1 property/);

    const nameOnly = await make('7 Name Only', { o_name: 'Ada Sample', o_phone1: '555-010-7777' });
    const form = await (await fetch(`${BASE}/properties/${high.id}`, { headers: { cookie } })).text();
    assert.doesNotMatch(form, /7 Name Only/);

    const day = (form.match(/name="activity_date" value="(\d{4}-\d{2}-\d{2})"/) || [])[1];
    const before = countOf(form);
    const saved = await post(cookie, `/properties/${high.id}/activities`, {
      kind: 'call', outcome: 'Left voicemail', owner_id: high.ownerId, activity_date: day,
      notes: 'Left a private note', from: 'cb', cb_at: '0', ['also_' + third.id]: '1',
    });
    assert.match(saved.location, /from=cb/);
    const origin = await (await fetch(BASE + saved.location, { headers: { cookie } })).text();
    assert.match(origin, /Left a private note/);
    assert.equal(countOf(origin), before + 1);
    const copy = await (await fetch(`${BASE}/properties/${third.id}`, { headers: { cookie } })).text();
    assert.match(copy, new RegExp(`Logged via owner Ada Sample from property #${high.id}`));
    assert.match(copy, /<b>Left voicemail<\/b>/);
    assert.doesNotMatch(copy, /Left a private note/);
    assert.match(copy, /s-attempted/);
    const skipped = await (await fetch(`${BASE}/properties/${low.id}`, { headers: { cookie } })).text();
    assert.doesNotMatch(skipped, /Logged via owner Ada Sample from property/);

    const talked = await post(cookie, `/properties/${high.id}/activities`, {
      kind: 'call', outcome: 'Talked', owner_id: high.ownerId, activity_date: day,
      notes: 'Reached Ada', ['also_' + third.id]: '1',
    });
    const talkedCopy = await (await fetch(`${BASE}/properties/${third.id}`, { headers: { cookie } })).text();
    assert.match(talkedCopy, /s-talked/);
    const talkedOrigin = await (await fetch(BASE + talked.location, { headers: { cookie } })).text();
    assert.equal(countOf(talkedOrigin), before + 2);

    const callId = origin.match(new RegExp(`/properties/${high.id}/activities/(\\d+)/delete`))[1];
    const removed = await post(cookie, `/properties/${high.id}/activities/${callId}/delete`, { from: 'cb', cb_at: '0' });
    assert.match(removed.location, /from=cb/);
    const afterDelete = await (await fetch(`${BASE}/properties/${third.id}`, { headers: { cookie } })).text();
    assert.doesNotMatch(afterDelete, /<b>Left voicemail<\/b>/);
  } finally {
    child.kill('SIGTERM');
  }
});
