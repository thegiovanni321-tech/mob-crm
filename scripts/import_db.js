// Load a JSON export (from scripts/export_db.js) into an EMPTY Postgres (DATABASE_URL). Refuses to run if any target table has rows.
// Usage: node scripts/import_db.js < export.json   (or: node scripts/import_db.js export.json). Add --check to only print counts.
(async () => {
  const db = await require('../src/db').migrate();
  const counts = async () => Object.fromEntries(await Promise.all((await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"))
    .map(async ({ table_name: t }) => [t, (await db.query(`SELECT count(*)::int n FROM "${t}"`))[0].n])));
  if (process.argv.includes('--check')) { console.log(JSON.stringify(await counts())); process.exit(0); }
  const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 0;
  const data = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const before = await counts();
  const busy = Object.entries(before).filter(([t, n]) => n > 0 && data.tables[t]);
  if (busy.length) throw new Error('Target is not empty, refusing to import: ' + busy.map(([t, n]) => `${t}=${n}`).join(', '));
  const order = ['tenants', 'tenant_aliases', 'owners', 'properties', 'property_tenants', 'property_owners', 'activities', 'buyers', 'sale_comps', 'buyer_contacts', 'lease_comps', 'listings', 'attachments', 'crm_sync_keys', 'crm_sync_runs'];
  const all = [...order.filter((t) => data.tables[t]), ...Object.keys(data.tables).filter((t) => !order.includes(t))];
  const Att = require('../src/attachments');
  await db.tx(async (t) => {
    for (const name of all) {
      const rows = data.tables[name]; if (!rows.length) continue;
      if (name === 'attachments') {
        for (const raw of rows) {
          const row = Att.decodeRow(raw);
          await t.query(`INSERT INTO attachments (id, kind, record_id, filename, mime_type, size_bytes, data, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))`,
            [row.id, row.kind, row.record_id, row.filename, row.mime_type, row.size_bytes, row.data, row.created_at || null]);
        }
      } else {
        for (let i = 0; i < rows.length; i += 500)
          await t.query(`INSERT INTO "${name}" SELECT * FROM json_populate_recordset(null::"${name}", $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
      }
      const hasId = (await t.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'", [name])).length;
      const seq = hasId ? (await t.query(`SELECT pg_get_serial_sequence($1, 'id') s`, [name]))[0].s : null;
      if (seq) await t.query(`SELECT setval($1, GREATEST((SELECT COALESCE(max(id),0) FROM "${name}"),1))`, [seq]);
    }
  });
  const after = await counts();
  const expected = Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length]));
  const mismatch = Object.keys(expected).filter((k) => after[k] !== expected[k]);
  console.log(JSON.stringify({ expected, after, match: mismatch.length === 0, mismatch }));
  process.exit(mismatch.length ? 2 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
