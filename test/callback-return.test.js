const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { neighborsInCallbackList, listUrl, returnFromQuery } = require('../src/callback-return');

test('a dropped callbacks row keeps the neighboring position', () => {
  const rows = [{ id: 1, address: 'A' }, { id: 2, address: 'B' }, { id: 3, address: 'C' }];
  const mid = neighborsInCallbackList(rows, 2, 1);
  assert.equal(mid.prev.id, 1);
  assert.equal(mid.next.id, 3);
  assert.equal(mid.fellOut, false);
  assert.equal(mid.anchorId, 2);
  const dropped = neighborsInCallbackList([{ id: 1, address: 'A' }, { id: 3, address: 'C' }], 2, 1);
  assert.equal(dropped.fellOut, true);
  assert.equal(dropped.prev.id, 1);
  assert.equal(dropped.next.id, 3);
  assert.equal(dropped.anchorId, 3);
  const last = neighborsInCallbackList([{ id: 1, address: 'A' }], 2, 1);
  assert.equal(last.next, null);
  assert.equal(last.prev.id, 1);
  assert.equal(last.anchorId, 1);
  assert.equal(listUrl({ from: 'cb', fu_state: 'FL', cb_at: 1 }, 3), '/callbacks?fu_state=FL#p-3');
  assert.equal(returnFromQuery({ from: 'properties' }), null);
});

const PASSWORD = 'synthetic-test-password';
function startServer(dataDir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', DELTA_WATCH: '0', APP_PASSWORD: PASSWORD, SESSION_SECRET: 'synthetic-test-secret-value', DATABASE_URL: '' },
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
function client(port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async login() {
      const res = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual' });
      return (res.headers.get('set-cookie') || '').split(';')[0];
    },
    async post(cookie, url, fields) {
      const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
      return res.headers.get('location') || '';
    },
  };
}

test('Next from Callbacks follows ranked order, not state order, including after a call drops the row', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-cb-next-'));
  const api = client(3467);
  const child = await startServer(dataDir, 3467);
  try {
    const cookie = await api.login();
    const post = (cookie, url, fields) => api.post(cookie, url, fields);
    const BASE = api.base;
    const make = async (address, state, notes) => {
      const loc = await post(cookie, '/properties', { address, city: 'Sampleville', state, status: 'New', o_name: address.split(' ')[0] + ' Sample', o_entity: 'Sample LLC' });
      const id = loc.match(/\/properties\/(\d+)/)[1];
      const page = await (await fetch(`${BASE}/properties/${id}`, { headers: { cookie } })).text();
      const owner = page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/)[1];
      await post(cookie, `/properties/${id}/activities`, { kind: 'call', outcome: 'Talked', owner_id: owner, activity_date: '2020-01-15', notes });
      return id;
    };
    const alpha = await make('Alpha FL Sell', 'FL', 'She is interested in selling.');
    const bravo = await make('Bravo GA Later', 'GA', 'Please call back in 3 months.');
    const charlie = await make('Charlie FL Quiet', 'FL', 'Short hello.');
    const opened = await (await fetch(`${BASE}/properties/${alpha}?from=cb&cb_at=0`, { headers: { cookie } })).text();
    const next = opened.match(/<a class="prop-arrow" href="([^"]+)" rel="next"/);
    assert.ok(next, 'next arrow');
    assert.match(next[1], new RegExp(`/properties/${bravo}\\?`));
    assert.match(next[1], /from=cb/);
    assert.doesNotMatch(next[1], new RegExp(`/properties/${charlie}`));
    assert.doesNotMatch(next[1], /[?&]state=/);
    const after = await post(cookie, `/properties/${alpha}/activities`, {
      kind: 'call', outcome: 'No answer', activity_date: '2026-11-10', notes: '', from: 'cb', cb_at: '0',
    });
    const stayed = await (await fetch(BASE + after, { headers: { cookie } })).text();
    assert.match(stayed, /no longer in that list/);
    const nextAfter = stayed.match(/<a class="prop-arrow" href="([^"]+)" rel="next"/);
    assert.match(nextAfter[1], new RegExp(`/properties/${bravo}\\?`));
    assert.match(nextAfter[1], /from=cb/);
    assert.doesNotMatch(nextAfter[1], new RegExp(`/properties/${charlie}`));
  } finally {
    child.kill('SIGTERM');
  }
});

test('Back to Callbacks survives a saved call and properties-list navigation stays the same', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-back-'));
  const api = client(3466);
  const child = await startServer(dataDir, 3466);
  try {
    const cookie = await api.login();
    const post = (cookie, url, fields) => api.post(cookie, url, fields);
    const BASE = api.base;
    const make = async (address, notes, state) => {
      const loc = await post(cookie, '/properties', { address, city: 'Sampleville', state, status: 'New', o_name: address.split(' ')[0] + ' Sample', o_entity: 'Sample LLC' });
      const id = loc.match(/\/properties\/(\d+)/)[1];
      const page = await (await fetch(`${BASE}/properties/${id}`, { headers: { cookie } })).text();
      const owner = page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/)[1];
      await post(cookie, `/properties/${id}/activities`, { kind: 'call', outcome: 'Talked', owner_id: owner, activity_date: '2020-01-15', notes });
      return id;
    };
    const sell = await make('9 Synthetic Followup', 'She is interested in selling.', 'FL');
    const quiet = await make('3 Synthetic Quiet', 'Short hello.', 'GA');
    const list = await (await fetch(BASE + '/callbacks?fu_state=FL', { headers: { cookie } })).text();
    assert.match(list, new RegExp(`/properties/${sell}\\?from=cb&fu_state=FL&cb_at=0`));
    assert.doesNotMatch(list, new RegExp(`/properties/${quiet}\\?`));
    const opened = await (await fetch(`${BASE}/properties/${sell}?from=cb&fu_state=FL&cb_at=0`, { headers: { cookie } })).text();
    assert.match(opened, /← Back to Callbacks/);
    assert.match(opened, new RegExp(`href="/callbacks\\?fu_state=FL#p-${sell}"`));
    assert.match(opened, /name="from" value="cb"/);
    assert.match(opened, /name="fu_state" value="FL"/);
    const plain = await (await fetch(`${BASE}/properties/${sell}?status=New&sort=added`, { headers: { cookie } })).text();
    assert.doesNotMatch(plain, /Back to Callbacks/);
    const after = await post(cookie, `/properties/${sell}/activities`, {
      kind: 'call', outcome: 'Talked', activity_date: '2026-11-10', notes: 'Still interested in selling.', from: 'cb', fu_state: 'FL', cb_at: '0',
    });
    assert.match(after, new RegExp(`/properties/${sell}\\?`));
    assert.match(after, /from=cb/);
    assert.match(after, /fu_state=FL/);
    const stayed = await (await fetch(BASE + after, { headers: { cookie } })).text();
    assert.match(stayed, /← Back to Callbacks/);
    assert.match(stayed, /Still interested in selling/);
    const dropped = await post(cookie, `/properties/${quiet}/activities`, {
      kind: 'call', outcome: 'No answer', activity_date: '2026-11-10', notes: '', from: 'cb', cb_at: '0',
    });
    const gone = await (await fetch(BASE + dropped, { headers: { cookie } })).text();
    assert.match(gone, /no longer in that list/);
    assert.match(gone, /← Back to Callbacks/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('a call logged from the Callbacks context increments today count', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-cb-count-'));
  const api = client(3468);
  const child = await startServer(dataDir, 3468);
  const countOf = (html) => {
    const m = html.match(/(\d+) calls? today/);
    if (!m) throw new Error('no call count');
    return Number(m[1]);
  };
  try {
    const cookie = await api.login();
    const before = countOf(await (await fetch(api.base + '/', { headers: { cookie } })).text());
    const loc = await api.post(cookie, '/properties', { address: '9 Synthetic Followup', city: 'Sampleville', state: 'FL', status: 'New', o_name: 'Ada Sample', o_entity: 'Sample LLC' });
    const id = loc.match(/\/properties\/(\d+)/)[1];
    const opened = await (await fetch(`${api.base}/properties/${id}?from=cb&cb_at=0`, { headers: { cookie } })).text();
    const day = opened.match(/name="activity_date" value="(\d{4}-\d{2}-\d{2})"/)[1];
    const saved = await api.post(cookie, `/properties/${id}/activities`, {
      kind: 'call', outcome: 'No answer', activity_date: day, notes: 'Rang once from Callbacks.', from: 'cb', cb_at: '0',
    });
    const after = await (await fetch(api.base + saved, { headers: { cookie } })).text();
    assert.equal(countOf(after), before + 1);
    const noted = await api.post(cookie, `/properties/${id}/activities`, { kind: 'note', notes: 'Not a call.', from: 'cb', cb_at: '0' });
    const still = await (await fetch(api.base + noted, { headers: { cookie } })).text();
    assert.equal(countOf(still), before + 1);
  } finally {
    child.kill('SIGTERM');
  }
});