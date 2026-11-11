const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PASSWORD = 'synthetic-test-password';
const PORT = 3470;
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
function csvFile(text) {
  const body = new FormData();
  body.append('file', new Blob([text], { type: 'text/csv' }), 'ages.csv');
  return body;
}

test('owner age upload previews, fills empty birth years only, and requires login', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-age-admin-'));
  const child = await startServer(dataDir);
  try {
    const anon = await fetch(BASE + '/admin/import-owner-ages', { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location') || '', /\/login/);
    const denied = await fetch(BASE + '/admin/import-owner-ages/preview', { method: 'POST', headers: { origin: BASE }, body: csvFile('a,b\n1,2'), redirect: 'manual' });
    assert.equal(denied.status, 401);

    const cookie = await login();
    const loc = await fetch(BASE + '/properties', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie }, body: new URLSearchParams({ address: '9 Synthetic Plaza', city: 'Sampleville', state: 'FL', o_name: 'Ada Sample', o_entity: 'Sample Holdings' }), redirect: 'manual' });
    const id = (loc.headers.get('location') || '').match(/\/properties\/(\d+)/)[1];
    const page = await (await fetch(`${BASE}/properties/${id}`, { headers: { cookie } })).text();
    const owner = page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/)[1];
    await fetch(BASE + '/owners/' + owner, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie }, body: new URLSearchParams({ name: 'Ada Sample', entity: 'Sample Holdings', age: '93' }), redirect: 'manual' });
    const csv = [
      'crm_property_id,crm_owner_id,owner_entity,person_name,birth_year,age_as_of_today,source,match_confidence,match_basis,notes',
      `${id},${owner},Sample Holdings,"Ada Sample, MD",1948,78,Nexis research,high,name,role suffix`,
      `${id},${owner},Sample Holdings,Ada Sample,,70,Nexis,high,age only,no year`,
      `${id},${owner},Sample Holdings,Ada Sample,1950,76,Nexis,low,name,too low`,
      `${id},99999,Missing,Nobody,1940,86,Nexis,medium,name,no owner`,
    ].join('\n');
    const preview = await fetch(BASE + '/admin/import-owner-ages/preview', { method: 'POST', headers: { origin: BASE, cookie }, body: csvFile(csv) });
    const html = await preview.text();
    assert.equal(preview.status, 200);
    assert.match(html, /Would update/);
    assert.match(html, /1948/);
    assert.match(html, /does not match/);
    assert.match(html, /birth year is blank/);
    assert.match(html, /not high or medium/);
    assert.match(html, /not in the CRM/);
    const still = await (await fetch(`${BASE}/owners/${owner}`, { headers: { cookie } })).text();
    assert.doesNotMatch(still, /Born 1948/);
    const token = html.match(/name="token" value="([^"]+)"/)[1];
    const applied = await fetch(BASE + '/admin/import-owner-ages/apply', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie }, body: new URLSearchParams({ token }) });
    const done = await applied.text();
    assert.match(done, /1 owner updated/);
    const after = await (await fetch(`${BASE}/owners/${owner}`, { headers: { cookie } })).text();
    assert.match(after, /Born 1948/);
    assert.match(after, /Nexis research/);
    assert.match(after, /high confidence/);
    assert.match(after, /Age 93/);
    const again = await fetch(BASE + '/admin/import-owner-ages/preview', { method: 'POST', headers: { origin: BASE, cookie }, body: csvFile(csv) });
    const second = await again.text();
    assert.match(second, /birth year already set/);
    assert.doesNotMatch(second, /name="token"/);
  } finally {
    child.kill('SIGTERM');
  }
});
