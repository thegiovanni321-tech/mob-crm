// Incremental import of the workbook's General tab (or one delta CSV) into the CRM. Idempotent; never overwrites CRM data.
// Usage: node scripts/sync_general.js [--dry-run] [--file workbook.xlsx] [--tab General] [--delta crm-delta-x.csv]
// With the embedded DB, stop the server first (or use "Sync General tab now" on Comps -> Import / feeds).
const S = require('../src/general-sync');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
(async () => {
  const dryRun = process.argv.includes('--dry-run'); if (dryRun) process.env.SYNC_DRY_RUN_NOLOG = '1';
  const db = await require('../src/db').migrate();
  const r = arg('delta') ? await S.importDeltaFile(db, arg('delta'), { dryRun }) : await S.syncWorkbook(db, { file: arg('file', undefined), tab: arg('tab', 'General'), dryRun });
  const { new_property_ids, skipped, ...rest } = r;
  console.log(JSON.stringify({ ...rest, skipped_rows: skipped.length, skipped }, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
