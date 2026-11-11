const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3463;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'synthetic-test-password';

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

test('deleting a property opens the next filtered record, the previous one at the end, or the filtered list when empty', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-del-'));
  const child = await startServer(dataDir);
  try {
    const cookie = await login();
    const ids = {};
    for (const address of ['Charlie Medical', 'Alpha Medical', 'Bravo Medical']) {
      const created = await post(cookie, '/properties', { address, city: 'Sampleville', state: 'FL', status: 'New' });
      ids[address] = created.location.match(/\/properties\/(\d+)/)[1];
    }
    const edit = await (await fetch(`${BASE}/properties/${ids['Bravo Medical']}/edit?sort=addr&status=New`, { headers: { cookie } })).text();
    assert.match(edit, /onsubmit="return confirm\('Delete this property and its activity log\? This cannot be undone\.'\)"/);
    assert.match(edit, /name="status" value="New"/);
    assert.match(edit, /name="sort" value="addr"/);

    const mid = await post(cookie, `/properties/${ids['Bravo Medical']}/delete`, { sort: 'addr', status: 'New' });
    assert.equal(mid.location, `/properties/${ids['Charlie Medical']}?status=New&sort=addr`);
    assert.equal((await fetch(BASE + `/properties/${ids['Bravo Medical']}`, { headers: { cookie } })).status, 404);

    const last = await post(cookie, `/properties/${ids['Charlie Medical']}/delete`, { sort: 'addr', status: 'New' });
    assert.equal(last.location, `/properties/${ids['Alpha Medical']}?status=New&sort=addr`);

    const only = await post(cookie, `/properties/${ids['Alpha Medical']}/delete`, { sort: 'addr', status: 'New' });
    assert.equal(only.location, '/properties?status=New&sort=addr');
    const list = await (await fetch(BASE + only.location, { headers: { cookie } })).text();
    assert.match(list, /Properties/);
    assert.doesNotMatch(list, /Alpha Medical|Bravo Medical|Charlie Medical/);
  } finally {
    child.kill('SIGTERM');
  }
});
