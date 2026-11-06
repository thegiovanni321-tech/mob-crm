const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3462;
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
  return res.headers.get('location') || '';
}

test('previous and next follow the filtered address sort, not id order, and survive a call that leaves the filter', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-nav-'));
  const child = await startServer(dataDir);
  try {
    const cookie = await login();
    const ids = {};
    for (const address of ['Charlie Medical', 'Alpha Medical', 'Bravo Medical']) {
      const loc = await post(cookie, '/properties', { address, city: 'Sampleville', state: 'FL', status: 'New' });
      ids[address] = loc.match(/\/properties\/(\d+)/)[1];
    }
    const page = await fetch(`${BASE}/properties/${ids['Bravo Medical']}?sort=addr&status=New`, { headers: { cookie } });
    const html = await page.text();
    const prev = html.match(/<a class="prop-arrow" href="([^"]+)" rel="prev"/);
    const next = html.match(/<a class="prop-arrow" href="([^"]+)" rel="next"/);
    assert.equal(prev[1], `/properties/${ids['Alpha Medical']}?status=New&sort=addr`);
    assert.equal(next[1], `/properties/${ids['Charlie Medical']}?status=New&sort=addr`);
    assert.match(html, /aria-label="Previous property, Alpha Medical"/);
    assert.match(html, /aria-label="Next property, Charlie Medical"/);
    const first = await (await fetch(`${BASE}/properties/${ids['Alpha Medical']}?sort=addr`, { headers: { cookie } })).text();
    assert.match(first, /aria-disabled="true"/);
    assert.match(first, /Previous/);
    const qs = 'sort=addr&status=New';
    const after = await post(cookie, `/properties/${ids['Bravo Medical']}/activities`, {
      kind: 'call', outcome: 'No answer', activity_date: '2024-06-01', sort: 'addr', status: 'New',
    });
    assert.match(after, new RegExp(`/properties/${ids['Bravo Medical']}\\?`));
    assert.match(after, /sort=addr/);
    assert.match(after, /status=New/);
    const stayed = await (await fetch(BASE + after, { headers: { cookie } })).text();
    assert.match(stayed, /no longer matches the list filter/);
    assert.match(stayed, new RegExp(`href="/properties/${ids['Charlie Medical']}\\?status=New&sort=addr"`));
    assert.match(stayed, new RegExp(`href="/properties/${ids['Alpha Medical']}\\?status=New&sort=addr"`));
    assert.match(stayed, /Attempted/);
    assert.doesNotMatch(stayed, /class="badge new"/);
    const direct = await (await fetch(`${BASE}/properties/${ids['Charlie Medical']}`, { headers: { cookie } })).text();
    assert.match(direct, /aria-label="Properties in this calling list"/);
    assert.match(direct, /of 3/);
    const areaAt = stayed.indexOf('id="area-comps"');
    assert.ok(stayed.indexOf('Edit property') < areaAt);
    assert.ok(stayed.indexOf('Log a call') < areaAt);
    void qs;
  } finally {
    child.kill('SIGTERM');
  }
});
