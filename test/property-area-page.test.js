const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'synthetic-test-password';
const SECRET = 'synthetic-test-secret-value';
const CREXI = 'Crexi Inventory Export (medical office) 2026-11-06';

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(PORT),
        NODE_ENV: 'test',
        DELTA_WATCH: '0',
        APP_PASSWORD: PASSWORD,
        SESSION_SECRET: SECRET,
        DATABASE_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const onData = (buf) => {
      log += buf.toString();
      if (log.includes('MOB CRM on')) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited ' + code + '\n' + log)));
    setTimeout(() => reject(new Error('server start timeout\n' + log)), 30000);
  });
}

async function login() {
  const res = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: 'manual',
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.includes('crm_session'), 'login cookie');
  return cookie;
}

async function post(cookie, url, fields) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
  return res.headers.get('location') || '';
}

test('property record shows call-ready area comps', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-crm-http-'));
  const child = await startServer(dataDir);
  try {
    const cookie = await login();
    const loc = await post(cookie, '/properties', {
      address: '100 Synthetic Medical Plaza', city: 'Sampleville', state: 'FL', rba: '12000', status: 'New', lat: '28', lng: '-82',
    });
    const id = loc.match(/\/properties\/(\d+)/)[1];
    await post(cookie, '/comps/sales', {
      address: '100 Synthetic Medical Plaza', city: 'Sampleville', state: 'FL', sale_date: '2020-01-15', price: '1000000', rba: '12000', cap_rate: '6.5',
      land_use: 'Medical Office', source: 'Synthetic subject', verified: '1', property_id: id, back: '/properties/' + id,
    });
    await post(cookie, '/comps/sales', {
      address: '210 Peer Medical', city: 'Sampleville', state: 'FL', sale_date: '2024-06-01', price: '2100000', rba: '10000', cap_rate: '7',
      land_use: 'Medical Office', source: 'Synthetic county', verified: '0',
    });
    await post(cookie, '/comps/sales', {
      address: '210 Peer Medical', city: 'Sampleville', state: 'FL', sale_date: '2024-06-01', price: '2100000', rba: '10000', cap_rate: '6.5',
      land_use: 'Medical Office', source: 'Synthetic broker', verified: '1',
    });
    await post(cookie, '/comps/sales', {
      address: '220 Plain Medical', city: 'Sampleville', state: 'FL', sale_date: '2023-03-01', price: '1500000', rba: '', cap_rate: '',
      land_use: 'Office', source: 'Synthetic county', verified: '0',
    });
    await post(cookie, '/comps/sales', {
      address: '230 Near Medical', city: 'Northplace', state: 'FL', sale_date: '2024-01-01', price: '1800000', rba: '9000', cap_rate: '6',
      land_use: 'Medical Office', source: 'Synthetic county', verified: '1', lat: '28.02', lng: '-82',
    });
    await post(cookie, '/comps/sales', {
      address: '400 Retail Strip', city: 'Sampleville', state: 'FL', sale_date: '2024-01-01', price: '5000000', rba: '20000', cap_rate: '6',
      land_use: 'Retail', source: 'Synthetic county', verified: '0',
    });
    await post(cookie, '/comps/sales', {
      address: '310 Asking Sale', city: 'Sampleville', state: 'FL', price: '2500000', rba: '8000',
      land_use: 'Medical Office', source: 'Synthetic listing desk', notes: 'For sale at an asking price', verified: '0',
    });
    await post(cookie, '/comps/leases', {
      address: '240 Peer Medical', city: 'Sampleville', state: 'FL', tenant: 'Sample Clinic', rent_psf: '41.25', start_date: '2023-01-01',
      source: CREXI, verified: '0',
    });
    await post(cookie, '/comps/leases', {
      address: '240 Peer Medical', city: 'Sampleville', state: 'FL', tenant: 'Sample Clinic', rent_psf: '33', lease_type: 'NNN', term_months: '60', start_date: '2023-01-01',
      source: 'Explicit rent roll 2026-12-15', verified: '1',
    });
    await post(cookie, '/comps/leases', {
      address: '260 Bare Medical', city: 'Sampleville', state: 'FL', tenant: '', rent_psf: '', lease_type: '', term_months: '',
      source: 'Synthetic call', verified: '0',
    });
    await post(cookie, '/listings', {
      address: '300 Asking Lane', city: 'Sampleville', state: 'FL', asking_price: '2400000', sf: '8000', cap_rate: '6.25', status: 'Active', tenant: 'Sample Clinic',
    });
    const page = await fetch(BASE + '/properties/' + id, { headers: { cookie } });
    const html = await page.text();
    assert.equal(page.status, 200);
    const start = html.indexOf('id="area-comps"');
    const end = html.indexOf('<h2>Owner contacts');
    assert.ok(start > 0 && end > start);
    const area = html.slice(start, end);
    assert.match(area, /Closed sales/);
    assert.match(area, /Same city/);
    assert.match(area, /[0-9.]+ mi/);
    assert.match(area, /210 Peer Medical/);
    assert.equal(area.split('210 Peer Medical').length - 1, 1);
    assert.match(area, /Actual \$33\.00\/SF/);
    assert.doesNotMatch(area, /Actual \$41\.25/);
    assert.match(area, /NOI\/SF|excluded from actual rent/);
    assert.match(area, /Unknown/);
    assert.match(area, /Asking, not closed/);
    assert.match(area, /300 Asking Lane/);
    assert.match(area, /310 Asking Sale/);
    assert.doesNotMatch(area, /100 Synthetic Medical Plaza/);
    assert.doesNotMatch(area, /400 Retail Strip/);
    assert.match(area, /href="\/comps\/sales\?city=Sampleville&amp;state=FL"/);
    assert.match(area, /href="\/comps\/leases\?city=Sampleville&amp;state=FL"/);
    assert.match(area, /href="\/comps\/sales\/\d+"/);
    assert.match(area, /href="\/comps\/leases\/\d+"/);
    const closed = area.split('<h3>Leases')[0];
    assert.doesNotMatch(closed, /300 Asking Lane|310 Asking Sale/);
    assert.match(html, /Full unfiltered list in Sampleville/);
  } finally {
    child.kill('SIGTERM');
  }
});
