const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Needs = require('../src/buyer-needs');

function prop(over) {
  return { id: 1, address: '1 Test', city: 'Tampa', state: 'FL', zip: '33602', price: 2000000, cap_rate: 0.07, rba: 10000, tenancy: 'Single Tenant', tenants: 'Dialysis Center', year_built: '1998', years_remaining: 6, notes: '', lead: false, sellerScore: 0, ...over };
}

test('buyer need matches stay unknown when a field is missing and strict can hide them', () => {
  const need = Needs.fromForm({ states: 'FL', price_min: '1000000', price_max: '3000000', active: '1' });
  const known = prop({ id: 1 });
  const unknown = prop({ id: 2, address: '2 No Price', price: null, asking_price: null });
  const outside = prop({ id: 3, address: '3 Georgia', state: 'GA' });
  const asking = prop({ id: 4, address: '4 Asking', price: null, asking_price: 1500000 });
  const lenient = Needs.matchProperties(need, [known, unknown, outside, asking], { strict: false });
  assert.deepEqual(lenient.map((r) => r.id), [1, 4, 2]);
  assert.equal(lenient.find((r) => r.id === 2).reasons.find((r) => r.label === 'Price').status, 'unknown');
  assert.match(lenient.find((r) => r.id === 4).reasons.find((r) => r.label === 'Price').detail, /Asking price/);
  const strict = Needs.matchProperties(need, [known, unknown, outside, asking], { strict: true });
  assert.deepEqual(strict.map((r) => r.id), [1, 4]);
  const lead = prop({ id: 5, lead: true });
  const ranked = Needs.matchProperties(need, [known, lead], { strict: true });
  assert.equal(ranked[0].id, 5);
  assert.ok(ranked[0].score > ranked[1].score);
  const sellers = Needs.fromForm({ states: 'FL', sellers_only: '1', active: '1' });
  const only = Needs.matchProperties(sellers, [prop({ id: 8, sellerScore: 0, lead: false }), prop({ id: 9, sellerScore: 80 })], {});
  assert.deepEqual(only.map((r) => r.id), [9]);
});

const PASSWORD = 'synthetic-test-password';
const PORT = 3475;
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

function seedBuyer(dataDir) {
  return new Promise((resolve, reject) => {
    const seed = spawn(process.execPath, ['-e', `
      const { migrate } = require('./src/db');
      (async () => {
        const db = await migrate();
        const [b] = await db.query("INSERT INTO buyers (buyer_key, name, entity, phone, email) VALUES ('synthetic-bn', 'Pat Buyer', 'Pat Holdings', '555-010-4242', 'pat@example.test') RETURNING id");
        await db.query("INSERT INTO sale_comps (buyer_id, address, city, state, price, cap_rate, sale_date, source) VALUES ($1, '9 Purchase', 'Tampa', 'FL', 2500000, 0.065, '2024-05-01', 'synthetic')", [b.id]);
        console.log(String(b.id));
      })().catch((e) => { console.error(e); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: '', DATA_DIR: dataDir } });
    let out = '', err = '';
    seed.stdout.on('data', (b) => { out += b; });
    seed.stderr.on('data', (b) => { err += b; });
    seed.on('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || out)));
  });
}
test('buyer needs can be saved, ranked, and opened with list context', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-bn-'));
  const buyerId = await seedBuyer(dataDir);
  const child = await startServer(dataDir);
  try {
    const anon = await fetch(BASE + '/buyer-needs', { redirect: 'manual' });
    assert.equal(anon.status, 302);
    const cookie = await login();
    const make = async (address, state, price, owner) => {
      const loc = await post(cookie, '/properties', { address, city: 'Tampa', state, status: 'New', price: price || '', ...owner });
      return loc.match(/\/properties\/(\d+)/)[1];
    };
    const fl = await make('10 Florida Medical', 'FL', '2200000', { o_name: 'Ada Sample', o_phone1: '555-010-1000' });
    const page = await (await fetch(`${BASE}/properties/${fl}`, { headers: { cookie } })).text();
    const ownerId = page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/)[1];
    const other = await make('11 Florida Annex', 'FL', '1800000', {});
    await post(cookie, `/properties/${other}/owners/${ownerId}/link`, {});
    const ga = await make('12 Georgia Medical', 'GA', '2200000', { o_name: 'Bea Sample', o_phone1: '555-010-2000' });
    const created = await post(cookie, '/buyer-needs', {
      buyer_name: 'Pat Buyer', company: 'Pat Holdings', states: 'FL', price_min: '1000000', price_max: '3000000', active: '1',
    });
    const needId = created.match(/\/buyer-needs\/(\d+)/)[1];
    const detail = await (await fetch(BASE + '/buyer-needs/' + needId, { headers: { cookie } })).text();
    assert.match(detail, /10 Florida Medical/);
    assert.match(detail, /11 Florida Annex/);
    assert.doesNotMatch(detail, /12 Georgia Medical/);
    assert.match(detail, /State: met/);
    assert.match(detail, new RegExp(`/properties/${fl}\\?from=bn`));
    assert.match(detail, new RegExp(`bn_id=${needId}`));
    const strict = await (await fetch(BASE + '/buyer-needs/' + needId + '?strict=1', { headers: { cookie } })).text();
    assert.match(strict, /Strict|Lenient/);
    const opened = await (await fetch(`${BASE}/properties/${fl}?from=bn&bn_id=${needId}&bn_at=0`, { headers: { cookie } })).text();
    assert.match(opened, /← Back to Buyer Need/);
    assert.match(opened, new RegExp(`href="/buyer-needs/${needId}`));
    const next = opened.match(/<a class="prop-arrow" href="([^"]+)" rel="next"/);
    assert.ok(next);
    assert.match(next[1], new RegExp(`/properties/${other}`));
    assert.match(next[1], /from=bn/);
    assert.doesNotMatch(next[1], new RegExp(`/properties/${ga}`));
    assert.match(opened, /Other properties owned by Ada Sample/);
    assert.match(opened, new RegExp(`/properties/${other}\\?[^"]*ret=${fl}`));
    assert.match(opened, new RegExp(`/properties/${other}\\?[^"]*from=bn`));
    const hopped = await (await fetch(`${BASE}/properties/${other}?ret=${fl}&from=bn&bn_id=${needId}&bn_at=0`, { headers: { cookie } })).text();
    assert.match(hopped, /← Back to 10 Florida Medical/);
    assert.match(hopped, new RegExp(`/properties/${fl}\\?[^"]*from=bn`));
    assert.match(hopped, new RegExp(`bn_id=${needId}`));
    const saved = await post(cookie, `/properties/${fl}/activities`, {
      kind: 'call', outcome: 'No answer', activity_date: '2026-11-11', notes: 'Rang the Florida building', from: 'bn', bn_id: needId, bn_at: '0',
    });
    assert.match(saved, /from=bn/);
    assert.match(saved, new RegExp(`bn_id=${needId}`));
    const stayed = await (await fetch(BASE + saved, { headers: { cookie } })).text();
    assert.match(stayed, /← Back to Buyer Need/);
    const edit = await (await fetch(BASE + '/buyer-needs/' + needId + '/edit', { headers: { cookie } })).text();
    assert.match(edit, /Delete this buyer need/);
    await post(cookie, '/buyer-needs/' + needId + '/delete', {});
    const gone = await fetch(BASE + '/buyer-needs/' + needId, { headers: { cookie } });
    assert.equal(gone.status, 404);
    const prefill = await (await fetch(BASE + '/buyer-needs/new?buyer_id=' + buyerId, { headers: { cookie } })).text();
    assert.match(prefill, /Pat Buyer/);
    assert.match(prefill, /value="FL"/);
    assert.match(prefill, /value="2500000"/);
    assert.match(prefill, /value="0.065"/);
    assert.match(prefill, /Suggested from the last capped purchase/);
    const buyers = await (await fetch(BASE + '/buyers/' + buyerId, { headers: { cookie } })).text();
    assert.match(buyers, new RegExp(`/buyer-needs/new\\?buyer_id=${buyerId}`));
  } finally {
    child.kill('SIGTERM');
  }
});
