// Seed sale comps from the prospects workbook (rows with a Sale Date and/or Price). Idempotent: safe to re-run;
// existing comps are matched on source_key and never duplicated (only their blank fields get filled).
// Usage: python3 scripts/extract_sale_comps.py && node scripts/seed_sale_comps.js      (or: npm run seed:comps)
// With the embedded DB (no DATABASE_URL) stop the server first - PGlite allows one process at a time.
const fs = require('fs'); const path = require('path');
const { migrate } = require('../src/db'); const C = require('../src/comps-core');
(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'data', 'sale_comps_seed.json');
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = await migrate();
  const groups = new Map();
  for (const r of seed.rows) {
    const key = 'wb:' + C.keyOf(C.fullAddr(r.address), C.normCity(r.city), r.state || r.state_raw, r.sale_date || r.sale_date_raw || ('price:' + (r.price ?? r.price_raw)));
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r);
  }
  const comps = [];
  for (const [key, rows] of groups) {
    const r = rows[0]; const first = (k) => rows.map((x) => x[k]).find((v) => v !== null && v !== undefined && v !== '') ?? null;
    const tabs = [...new Set(rows.map((x) => x.tab))];
    comps.push({ address: r.address, city: r.city, state: r.state, zip: first('zip'), sale_date: first('sale_date'), price: first('price'), rba: first('rba'), cap_rate: first('cap_rate'),
      year_built: first('year_built'), acres: first('acres'), tenants: tabs.join('; '), source: 'Prospects workbook', source_key: key, verified: true,
      notes: [`Workbook rows: ${rows.map((x) => `${x.tab} row ${x.row}`).join(', ')}`, first('sale_date_raw') && 'Sale date (as written): ' + first('sale_date_raw'),
        first('price_raw') && 'Price (as written): ' + first('price_raw'), first('cap_raw') && 'Cap rate (as written): ' + first('cap_raw'), first('rba_raw') && 'RBA (as written): ' + first('rba_raw'),
        first('entity') && `Owner of record in workbook: ${first('entity')}${first('owner') ? ' (' + first('owner') + ')' : ''}`, r.state_raw && 'State (as written): ' + r.state_raw].filter(Boolean).join('\n') });
  }
  const before = (await db.query('SELECT count(*)::int n FROM sale_comps WHERE source=$1', ['Prospects workbook']))[0].n;
  const res = await db.tx(async (t) => C.upsertComps(t, 'sale', comps));
  const [after] = await db.query(`SELECT count(*)::int n, count(property_id)::int linked, count(*) FILTER (WHERE sale_date IS NOT NULL)::int dated, count(*) FILTER (WHERE price IS NOT NULL)::int priced
    FROM sale_comps WHERE source='Prospects workbook'`);
  const byState = await db.query(`SELECT COALESCE(state,'?') s, count(*)::int n FROM sale_comps WHERE source='Prospects workbook' GROUP BY 1 ORDER BY 2 DESC`);
  console.log(JSON.stringify({ workbook: seed.source, workbook_rows_with_sale_data: seed.rows.length, unique_sales: comps.length, before, inserted: res.inserted, already_existed: res.updated,
    total_workbook_comps: after.n, linked_to_property: after.linked, unlinked: after.n - after.linked, with_sale_date: after.dated, with_price: after.priced,
    by_state: Object.fromEntries(byState.map((x) => [x.s, x.n])) }, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
