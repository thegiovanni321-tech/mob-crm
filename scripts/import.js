// Load data/seed.json (produced by scripts/extract.py) into the database.
// Usage: node scripts/import.js [--reset]   (refuses to run on a non-empty DB without --reset)
const fs = require('fs'); const path = require('path');
const { migrate } = require('../src/db');
(async () => {
  const seedPath = process.env.SEED_FILE || path.join(__dirname, '..', 'data', 'seed.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const db = await migrate();
  const [{ n }] = await db.query('SELECT count(*)::int AS n FROM properties');
  if (n > 0 && !process.argv.includes('--reset')) { console.error(`Database already has ${n} properties. Re-run with --reset to wipe and re-import.`); process.exit(1); }
  await db.tx(async (t) => {
    if (n > 0) await t.query('TRUNCATE activities, property_owners, property_tenants, properties, owners, tenants RESTART IDENTITY CASCADE');
    const tid = {}; const oid = {};
    for (const te of seed.tenants) {
      const [r] = await t.query('INSERT INTO tenants (name, notes) VALUES ($1,$2) RETURNING id', [te.name, (te.notes || []).join('\n') || null]);
      tid[te.name] = r.id;
    }
    for (const o of seed.owners) {
      const ph = [...o.phones, null, null, null, null, null].slice(0, 5);
      const notes = [o.extra_phones && o.extra_phones.length ? 'Other phones: ' + o.extra_phones.join(', ') : null].filter(Boolean).join('\n') || null;
      const [r] = await t.query(`INSERT INTO owners (name, entity, age, phone1, phone2, phone3, phone4, phone5, email, website, mailing_address, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [o.name, o.entity, o.age, ...ph, o.email, o.website, o.mailing_address, notes]);
      oid[o.key] = r.id;
    }
    for (const p of seed.properties) {
      const notes = [...p.notes, ...p.raw_dates, p.rba_raw ? 'RBA: ' + p.rba_raw : null, p.price_raw ? 'Price: ' + p.price_raw : null,
        p.sale_date_raw ? 'Sale date: ' + p.sale_date_raw : null].filter(Boolean).join('\n') || null;
      const source = (p.srcs || []).join('; ');
      const [r] = await t.query(`INSERT INTO properties (address, city, state, state_raw, zip, tenancy, rba, acres, year_built, sale_date, price, cap_rate,
        notes, status, last_contacted, callback_date, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [p.address, p.city, p.state, p.state_raw, p.zip, p.tenancy, p.rba, p.acres, p.year_built, p.sale_date, p.price, p.cap_rate,
         notes, p.status, p.last_talked, p.callback, 'Spreadsheet: ' + source]);
      for (const tn of p.tenants) await t.query('INSERT INTO property_tenants VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, tid[tn]]);
      for (const k of p.owner_keys) await t.query('INSERT INTO property_owners VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, oid[k]]);
      for (const im of p.imports) {
        const outcome = im.talked ? 'Talked' : im.called ? 'Called' : 'Callback set';
        await t.query(`INSERT INTO activities (property_id, owner_id, kind, outcome, notes, activity_date, callback_date) VALUES ($1,$2,'import',$3,$4,$5,$6)`,
          [r.id, im.contact ? oid[im.contact] : null, outcome, `Imported from spreadsheet (${im.tenant} tab, row ${im.row})${im.called && !im.talked ? ' - CALLS cell was marked green' : ''}`, im.talked, im.callback]);
      }
    }
  });
  const c = await db.query(`SELECT (SELECT count(*) FROM tenants)::int t, (SELECT count(*) FROM properties)::int p, (SELECT count(*) FROM owners)::int o, (SELECT count(*) FROM activities)::int a`);
  console.log('Imported', c[0]);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
