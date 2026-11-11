const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('production rejects missing and default auth secrets; development keeps placeholders', () => {
  const { resolveSecrets } = require('../src/auth');
  assert.throws(() => resolveSecrets({ NODE_ENV: 'production', SESSION_SECRET: '', APP_PASSWORD: 'not-the-placeholder' }), /SESSION_SECRET/);
  assert.throws(() => resolveSecrets({ NODE_ENV: 'production', SESSION_SECRET: 'dev-only-secret-change-me', APP_PASSWORD: 'not-the-placeholder' }), /SESSION_SECRET/);
  assert.throws(() => resolveSecrets({ NODE_ENV: 'production', SESSION_SECRET: 'not-the-placeholder-secret', APP_PASSWORD: '' }), /APP_PASSWORD/);
  assert.throws(() => resolveSecrets({ NODE_ENV: 'production', SESSION_SECRET: 'not-the-placeholder-secret', APP_PASSWORD: 'changeme' }), /APP_PASSWORD/);
  const ok = resolveSecrets({ NODE_ENV: 'production', SESSION_SECRET: 'not-the-placeholder-secret', APP_PASSWORD: 'not-the-placeholder' });
  assert.equal(ok.secret, 'not-the-placeholder-secret');
  assert.equal(ok.password, 'not-the-placeholder');
  const dev = resolveSecrets({ NODE_ENV: 'development' });
  assert.equal(dev.secret, 'dev-only-secret-change-me');
  assert.equal(dev.password, 'changeme');
});

test('workbook and delta paths follow DATA_DIR, WORKBOOK_PATH, and DELTA_DIR', () => {
  const prev = { DATA_DIR: process.env.DATA_DIR, WORKBOOK_PATH: process.env.WORKBOOK_PATH, DELTA_DIR: process.env.DELTA_DIR };
  process.env.DATA_DIR = path.join(os.tmpdir(), 'synthetic-crm-data');
  delete process.env.WORKBOOK_PATH;
  delete process.env.DELTA_DIR;
  const paths = require('../src/paths');
  assert.equal(paths.workbookPath(), path.join(process.env.DATA_DIR, 'Prospects_updated.xlsx'));
  assert.equal(paths.deltaDir(), path.join(process.env.DATA_DIR, 'incoming'));
  process.env.WORKBOOK_PATH = path.join(os.tmpdir(), 'custom-book.xlsx');
  process.env.DELTA_DIR = path.join(os.tmpdir(), 'custom-incoming');
  assert.equal(paths.workbookPath(), path.resolve(process.env.WORKBOOK_PATH));
  assert.equal(paths.deltaDir(), path.resolve(process.env.DELTA_DIR));
  const sync = require('../src/general-sync');
  assert.equal(sync.LIVE, paths.workbookPath());
  assert.equal(sync.deltaDir(), paths.deltaDir());
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('buyers stay capped-only and Crexi rent_psf is stored unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-crm-unit-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const { migrate } = require('../src/db');
  const C = require('../src/comps-core');
  const B = require('../src/buyers');
  const Area = require('../src/area-comps');
  const db = await migrate();
  await C.upsertComps(db, 'sale', [{
    address: '1 No Cap Medical', city: 'Sampleville', state: 'FL', sale_date: '2024-01-01', price: 1000000, rba: 5000,
    purchaser_entity: 'Synthetic No Cap LLC', source: 'synthetic', source_key: 't:nocap', verified: false, land_use: 'Medical Office',
  }]);
  assert.equal((await db.query('SELECT id FROM buyers')).length, 0);
  await C.upsertComps(db, 'sale', [{
    address: '2 Cap Medical', city: 'Sampleville', state: 'FL', sale_date: '2024-02-01', price: 2000000, rba: 8000, cap_rate: 0.065,
    purchaser_entity: 'Synthetic Cap LLC', source: 'synthetic', source_key: 't:cap', verified: true, land_use: 'Medical Office',
  }]);
  const buyers = await db.query('SELECT entity FROM buyers ORDER BY id');
  assert.deepEqual(buyers.map((b) => b.entity), ['Synthetic Cap LLC']);
  await B.syncBuyers(db);
  assert.equal((await db.query('SELECT id FROM buyers')).length, 1);
  await C.upsertComps(db, 'lease', [{
    address: '3 Crexi Medical', city: 'Sampleville', state: 'FL', tenant: 'Sample Clinic', rent_psf: 41.25,
    source: Area.CREXI_NOI_SF_SOURCE, source_key: 't:crexi', verified: false, land_use: 'Medical Office',
  }]);
  const subject = { id: 9, address: '9 Other Plaza', city: 'Sampleville', state: 'FL' };
  const leases = await db.query('SELECT * FROM lease_comps');
  const html = Area.renderAreaComps(Area.buildAreaComps(subject, [], leases, []));
  assert.match(html, /NOI\/SF \$41\.25/);
  assert.doesNotMatch(html, /Actual \$41\.25/);
  const [stored] = await db.query('SELECT rent_psf::float AS rent_psf FROM lease_comps');
  assert.equal(stored.rent_psf, 41.25);
  if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
});
