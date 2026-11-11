// Generic CSV import for comps (CoStar / LoopNet / LightBox / Crexi exports, or your own sheet). Rows are marked unverified.
// Usage: node scripts/import_comps_csv.js --type sale|lease --source "CoStar Nov 2026" [--map "address=Property Address,price=Sale Price,..."] [--dry-run] file.csv
// Without --map, columns are matched automatically by header name (shown in the output). Re-importing the same file is a no-op.
const fs = require('fs'); const { parse } = require('csv-parse/sync'); const C = require('../src/comps-core');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
(async () => {
  const file = process.argv[process.argv.length - 1]; const kind = arg('type', 'sale') === 'lease' ? 'lease' : 'sale'; const source = arg('source', null);
  if (!source || !fs.existsSync(file)) { console.error('Usage: node scripts/import_comps_csv.js --type sale|lease --source "Label" [--map "field=Header,..."] [--dry-run] file.csv'); process.exit(1); }
  const rows = parse(fs.readFileSync(file, 'utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  const headers = rows[0]; let mapping = C.guessMapping(kind, headers);
  if (arg('map', null)) { mapping = {}; for (const pair of arg('map').split(',')) { const [k, h] = pair.split('='); const i = headers.findIndex((x) => x.trim().toLowerCase() === String(h).trim().toLowerCase()); if (i < 0) throw new Error(`Header "${h}" not found`); mapping[k.trim()] = i; } }
  console.log('Column mapping:', Object.fromEntries(Object.entries(mapping).map(([k, i]) => [k, headers[i]])));
  const { comps, skipped } = C.mapRows(kind, rows.slice(1), mapping, source);
  if (process.argv.includes('--dry-run')) { console.log({ rows: rows.length - 1, would_import: comps.length, skipped, sample: comps.slice(0, 2) }); process.exit(0); }
  const db = await require('../src/db').migrate(); const r = await db.tx((t) => C.upsertComps(t, kind, comps));
  console.log({ rows: rows.length - 1, inserted: r.inserted, already_existed: r.updated, skipped_no_address: skipped, matched_to_crm_property: r.matched });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
