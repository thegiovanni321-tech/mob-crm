// Export every table of the current DB (PGlite or DATABASE_URL) to one JSON file, for moving data to another Postgres.
// Usage: node scripts/export_db.js out.json      (with the embedded DB, stop the server first)
(async () => {
  const db = await require('../src/db').migrate();
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).map((r) => r.table_name);
  const out = { exported_at: new Date().toISOString(), tables: {} };
  const Att = require('../src/attachments');
  for (const t of tables) {
    const rows = await db.query(`SELECT * FROM "${t}"`);
    out.tables[t] = t === 'attachments' ? rows.map(Att.encodeRow) : rows;
  }
  require('fs').writeFileSync(process.argv[2], JSON.stringify(out));
  console.log(JSON.stringify(Object.fromEntries(tables.map((t) => [t, out.tables[t].length]))));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
