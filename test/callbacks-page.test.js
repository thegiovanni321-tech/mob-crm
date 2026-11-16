const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3465;
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

test('callbacks page keeps scheduled lists and shows a stale talk plus a negated note', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-cb-'));
  const child = await startServer(dataDir);
  try {
    const cookie = await login();
    const loc = await post(cookie, '/properties', { address: '9 Synthetic Followup', city: 'Sampleville', state: 'FL', status: 'New', o_name: 'Ada Sample', o_entity: 'Sample Holdings' });
    const id = loc.match(/\/properties\/(\d+)/)[1];
    const page = await (await fetch(`${BASE}/properties/${id}`, { headers: { cookie } })).text();
    const owner = page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/)[1];
    await post(cookie, `/properties/${id}/activities`, {
      kind: 'call', outcome: 'Talked', owner_id: owner, activity_date: '2020-01-15', notes: 'She is interested in selling. Not a voicemail.',
    });
    await post(cookie, `/owners/${owner}`, { name: 'Ada Sample', entity: 'Sample Holdings', birth_year: '1948', age_source: 'Nexis', age_confidence: 'high' });
    const record = await (await fetch(`${BASE}/properties/${id}`, { headers: { cookie } })).text();
    assert.match(record, /Born 1948/);
    assert.match(record, /Nexis/);
    assert.match(record, /high confidence/);
    const html = await (await fetch(BASE + '/callbacks', { headers: { cookie } })).text();
    assert.match(html, /Due or overdue/);
    assert.match(html, /Next 14 days/);
    assert.match(html, /Most likely to sell/);
    assert.doesNotMatch(html, /Excluded by negation/);
    assert.match(html, /Ada Sample/);
    assert.match(html, /Sample Holdings/);
    assert.match(html, /9 Synthetic Followup/);
    assert.match(html, /interested in selling/);
    assert.match(html, /Age 78/);
    const negLoc = await post(cookie, '/properties', { address: '8 Synthetic Never', city: 'Sampleville', state: 'FL', status: 'New', o_name: 'Bea Sample', o_entity: 'Bea LLC' });
    const id2 = negLoc.match(/\/properties\/(\d+)/)[1];
    const page2 = await (await fetch(`${BASE}/properties/${id2}`, { headers: { cookie } })).text();
    const owner2 = page2.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/)[1];
    await post(cookie, `/properties/${id2}/activities`, { kind: 'call', outcome: 'Talked', owner_id: owner2, activity_date: '2020-02-01', notes: 'They are not selling.' });
    const html2 = await (await fetch(BASE + '/callbacks', { headers: { cookie } })).text();
    assert.doesNotMatch(html2, /8 Synthetic Never/);
    assert.doesNotMatch(html2, /Bea Sample/);
    assert.match(html2, /clearly not selling, hidden/);
    const hidden = await (await fetch(BASE + '/callbacks/not-selling', { headers: { cookie } })).text();
    assert.match(hidden, /8 Synthetic Never/);
    assert.match(hidden, /not selling/);
  } finally {
    child.kill('SIGTERM');
  }
});
