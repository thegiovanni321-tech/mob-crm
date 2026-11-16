// Fill owner birth_year from a research CSV. Matches an existing property and owner.
// Does not create owners and does not replace a birth year that is already set.
// Usage: node scripts/import_owner_ages.js [--dry-run] [--today YYYY-MM-DD] file.csv
// Columns: property_id and/or address, person_name, birth_year, age_as_of_today, source, match_confidence.
const fs = require('fs');
const Ages = require('../src/owner-ages');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : ''; };
(async () => {
  const file = process.argv.filter((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]).pop();
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/import_owner_ages.js [--dry-run] [--today YYYY-MM-DD] file.csv');
    process.exit(1);
  }
  const rows = Ages.parseAgeCsv(fs.readFileSync(file, 'utf8'));
  const db = await require('../src/db').migrate();
  const stats = await Ages.importOwnerAges(db, rows, { today: arg('today') || undefined, dryRun: process.argv.includes('--dry-run') });
  console.log(JSON.stringify({ rows: rows.length, dryRun: process.argv.includes('--dry-run'), ...stats }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
