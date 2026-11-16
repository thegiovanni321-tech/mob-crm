const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-crexi-'));
process.env.DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
const { migrate } = require('../src/db');
const Crexi = require('../src/crexi-weekly');

const sold = `address,city,state,zip,sale_price,sale_date,building_sf,cap_rate,noi,tenant,lease_type,lease_expiration,year_built,buyer,seller,listing_broker,crexi_url,om_filename
100 Medical Way,Tampa,FL,33602,"$2,200,000",2026-03-01,12000,6.5,140000,Dialysis Co,NNN,2032-03-01,1998,Pat Buyer,Sam Seller,Broker Co,https://crexi.example/sold-1,om-sold.pdf
200 Missing Date,Tampa,FL,33602,100,not-a-date,1000,,,,,, ,,,
`;
const listings = `address,city,state,zip,building_sf,asking_price,asking_rent_psf,for_sale,listing_type,listed_at,tenant,crexi_url,om_filename
100 Medical Way,Tampa,FL,33602,12000,2500000,28.50,yes,lease,2026-04-01,Dialysis Co,https://crexi.example/list-1,om-list.pdf
300 No Url,Tampa,FL,33602,8000,900000,20,yes,lease,2026-04-02,Clinic, ,
`;

async function db() {
  return migrate();
}

test('weekly Crexi import is idempotent and does not create properties', async () => {
  const database = await db();
  const [prop] = await database.query(`INSERT INTO properties (address, city, state, source) VALUES ('100 Medical Way', 'Tampa', 'FL', 'synthetic') RETURNING id`);
  const before = await database.query('SELECT count(*)::int n FROM properties');
  const files = [
    { filename: 'om-sold.pdf', buffer: Buffer.from('%PDF-1.4 sold'), mimetype: 'application/pdf' },
    { filename: 'om-list.pdf', buffer: Buffer.from('%PDF-1.4 list'), mimetype: 'application/pdf' },
    { filename: 'orphan.pdf', buffer: Buffer.from('%PDF-1.4 orphan'), mimetype: 'application/pdf' },
  ];
  const plan = await Crexi.planCrexi(database, { soldRows: Crexi.parseCsv(sold), listingRows: Crexi.parseCsv(listings), files, week: '2026-04-06' });
  assert.equal(plan.source, 'Crexi weekly 2026-04-06');
  assert.equal(plan.sales.filter((r) => r.action === 'insert').length, 1);
  assert.equal(plan.sales.find((r) => r.action === 'skip').reason, 'sale date is missing or not a date');
  assert.equal(plan.listings.find((r) => r.action === 'skip').reason, 'listing URL is required to dedupe');
  assert.equal(plan.sales.find((r) => r.action === 'insert').propertyId, prop.id);
  assert.ok(plan.documents.some((d) => d.action === 'unmatched' && d.filename === 'orphan.pdf'));
  const first = await Crexi.applyCrexi(database, plan);
  assert.equal(first.sales, 1);
  assert.equal(first.listings, 1);
  assert.equal(first.documents, 2);
  const [sale] = await database.query('SELECT verified, source, tenant, noi, listing_url, property_id, cap_rate FROM sale_comps');
  assert.equal(sale.verified, false);
  assert.equal(sale.source, 'Crexi weekly 2026-04-06');
  assert.equal(sale.tenant, 'Dialysis Co');
  assert.equal(Number(sale.noi), 140000);
  assert.equal(Number(sale.property_id), prop.id);
  assert.ok(Math.abs(Number(sale.cap_rate) - 0.065) < 0.0001);
  const [lease] = await database.query('SELECT for_sale, asking_price, listing_url, property_id, verified FROM lease_comps');
  assert.equal(lease.for_sale, true);
  assert.equal(Number(lease.asking_price), 2500000);
  assert.equal(Number(lease.property_id), prop.id);
  const after = await database.query('SELECT count(*)::int n FROM properties');
  assert.equal(after[0].n, before[0].n);
  const owners = await database.query('SELECT count(*)::int n FROM owners');
  assert.equal(owners[0].n, 0);
  const again = await Crexi.planCrexi(database, { soldRows: Crexi.parseCsv(sold), listingRows: Crexi.parseCsv(listings), files, week: '2026-04-06' });
  assert.equal(again.sales.filter((r) => r.action === 'insert').length, 0);
  assert.match(again.sales.find((r) => r.address === '100 Medical Way').reason, /already on file/);
  const second = await Crexi.applyCrexi(database, again);
  assert.equal(second.sales, 0);
  assert.equal(second.listings, 0);
  const docs = await database.query('SELECT count(*)::int n FROM property_documents');
  assert.equal(docs[0].n, 2);
});

const PASSWORD = 'synthetic-test-password';
const PORT = 3479;
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), NODE_ENV: 'test', DELTA_WATCH: '0', APP_PASSWORD: PASSWORD, SESSION_SECRET: 'synthetic-test-secret-value', DATABASE_URL: '' },
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

test('for-sale leases and offering memorandums show on the authenticated pages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-crexi-http-'));
  const child = await startServer(dir);
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const anon = await fetch(base + '/documents/1', { redirect: 'manual' });
    assert.equal(anon.status, 302);
    const login = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const made = await fetch(base + '/properties', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie }, body: new URLSearchParams({ address: '100 Medical Way', city: 'Tampa', state: 'FL' }), redirect: 'manual' });
    const propId = (made.headers.get('location') || '').match(/(\d+)/)[1];
    const body = new FormData();
    body.set('week', '2026-04-06');
    body.set('sold', new Blob([sold], { type: 'text/csv' }), 'sold_comps.csv');
    body.set('listings', new Blob([listings], { type: 'text/csv' }), 'new_listings.csv');
    body.append('oms', new Blob(['%PDF-1.4 sold'], { type: 'application/pdf' }), 'om-sold.pdf');
    body.append('oms', new Blob(['%PDF-1.4 list'], { type: 'application/pdf' }), 'om-list.pdf');
    const preview = await fetch(base + '/admin/import-crexi-weekly/preview', { method: 'POST', headers: { origin: base, cookie }, body });
    const html = await preview.text();
    assert.equal(preview.status, 200);
    assert.match(html, /would be added/);
    assert.match(html, /sale date is missing/);
    const token = html.match(/name="token" value="([^"]+)"/)[1];
    const applied = await fetch(base + '/admin/import-crexi-weekly/apply', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie }, body: new URLSearchParams({ token }) });
    assert.match(await applied.text(), /1 sale comp/);
    const leases = await (await fetch(base + '/comps/leases?forsale=yes', { headers: { cookie } })).text();
    assert.match(leases, /For sale/);
    assert.match(leases, /\$2,500,000/);
    assert.match(leases, /Offering Memorandum/);
    const hidden = await (await fetch(base + '/comps/leases?forsale=no', { headers: { cookie } })).text();
    assert.doesNotMatch(hidden, /100 Medical Way/);
    const prop = await (await fetch(base + '/properties/' + propId, { headers: { cookie } })).text();
    const doc = prop.match(/href="\/documents\/(\d+)"/);
    assert.ok(doc, 'property page links the memorandum');
    const pdf = await fetch(base + '/documents/' + doc[1], { headers: { cookie } });
    assert.match(pdf.headers.get('content-type') || '', /pdf/);
    assert.match(pdf.headers.get('content-disposition') || '', /inline/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.match(bytes.toString('utf8'), /PDF/);
    const area = await (await fetch(base + '/properties/' + propId, { headers: { cookie } })).text();
    assert.match(area, /For sale/);
  } finally {
    child.kill('SIGTERM');
  }
});
