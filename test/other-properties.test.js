const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { returnFromQuery, returnQuery } = require('../src/callback-return');

test('a property return id rides along with the list context', () => {
  const ctx = returnFromQuery({ from: 'cb', cb_at: '2', ret: '15' });
  assert.equal(ctx.ret, 15);
  assert.equal(ctx.cb_at, 2);
  assert.deepEqual(returnQuery({ ...ctx, ret: null }), { from: 'cb', cb_at: '2' });
  assert.equal(returnFromQuery({ from: 'properties' }), null);
  assert.equal(returnFromQuery({ ret: '9' }).ret, 9);
});

const PASSWORD = 'synthetic-test-password';
const PORT = 3474;
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
  return res.headers.get('location') || '';
}

test('other owned properties link back to the record they were opened from', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-other-prop-'));
  const child = await startServer(dataDir);
  try {
    const cookie = await login();
    const make = async (address, owner) => {
      const loc = await post(cookie, '/properties', { address, city: 'Sampleville', state: 'FL', status: 'New', ...owner });
      const id = loc.match(/\/properties\/(\d+)/)[1];
      const page = await (await fetch(`${BASE}/properties/${id}`, { headers: { cookie } })).text();
      const ownerId = (page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/) || [])[1] || '';
      return { id, ownerId };
    };
    const home = await make('1 Ada Plaza', { o_name: 'Ada Sample', o_phone1: '555-010-1000' });
    const other = await make('2 Ada Annex', {});
    await post(cookie, `/properties/${other.id}/owners/${home.ownerId}/link`, {});
    const nameOnly = await make('3 Ada Name Only', { o_name: 'Ada Sample', o_phone1: '555-010-7777' });
    const shared = await make('4 Ada Shared Phone', { o_name: 'Ada Sample', o_phone1: '5550101000' });
    await post(cookie, `/properties/${home.id}/activities`, {
      kind: 'call', outcome: 'Talked', owner_id: home.ownerId, activity_date: '2020-01-15', notes: 'She is interested in selling.',
    });

    const page = await (await fetch(`${BASE}/properties/${home.id}?from=cb&cb_at=0`, { headers: { cookie } })).text();
    assert.match(page, /Other properties owned by Ada Sample/);
    assert.match(page, new RegExp(`/properties/${other.id}\\?[^"]*ret=${home.id}`));
    assert.match(page, new RegExp(`/properties/${other.id}\\?[^"]*from=cb`));
    assert.match(page, new RegExp(`/properties/${other.id}\\?[^"]*cb_at=0`));
    assert.match(page, new RegExp(`/properties/${shared.id}\\?[^"]*ret=${home.id}`));
    assert.doesNotMatch(page, new RegExp(`/properties/${nameOnly.id}\\?`));
    assert.match(page, /2 Ada Annex, Sampleville, FL/);
    assert.match(page, /4 Ada Shared Phone, Sampleville, FL/);

    const dest = await (await fetch(`${BASE}/properties/${other.id}?ret=${home.id}&from=cb&cb_at=0`, { headers: { cookie } })).text();
    assert.match(dest, new RegExp(`href="/properties/${home.id}\\?from=cb&(?:amp;)?cb_at=0"`));
    assert.match(dest, /← Back to 1 Ada Plaza/);
    assert.match(dest, /name="ret" value="1 Ada Plaza"|name="ret"/);
    assert.match(dest, new RegExp(`name="ret" value="${home.id}"`));
    assert.match(dest, /name="from" value="cb"/);

    const saved = await post(cookie, `/properties/${other.id}/activities`, {
      kind: 'call', outcome: 'Left voicemail', owner_id: home.ownerId, activity_date: '2026-11-11',
      notes: 'Called the annex', ret: home.id, from: 'cb', cb_at: '0',
    });
    assert.match(saved, new RegExp(`/properties/${other.id}\\?`));
    assert.match(saved, new RegExp(`ret=${home.id}`));
    assert.match(saved, /from=cb/);
    assert.match(saved, /cb_at=0/);
    const stayed = await (await fetch(BASE + saved, { headers: { cookie } })).text();
    assert.match(stayed, /← Back to 1 Ada Plaza/);
    assert.match(stayed, new RegExp(`href="/properties/${home.id}\\?from=cb&(?:amp;)?cb_at=0"`));

    const back = await (await fetch(`${BASE}/properties/${home.id}?from=cb&cb_at=0`, { headers: { cookie } })).text();
    assert.match(back, /← Back to Callbacks/);
    assert.match(back, /name="from" value="cb"/);
    assert.doesNotMatch(back, /← Back to 1 Ada Plaza/);
  } finally {
    child.kill('SIGTERM');
  }
});
