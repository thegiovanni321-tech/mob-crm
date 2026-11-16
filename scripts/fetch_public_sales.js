// Pull recent medical-office / office sales from free public county records and add them as UNVERIFIED sale comps (de-duped).
// Usage: node scripts/fetch_public_sales.js [--days 30] [--source franklin-oh|wake-nc] [--medical-only] [--dry-run]
// Sources (no login, no key): Franklin County OH Auditor daily conveyances; Wake County NC qualified sales (past 24 months).
// When .remote-sync.json exists the comps go to the hosted CRM over HTTPS (add --local to write the box snapshot instead).
// With the embedded DB (no DATABASE_URL) stop the server first, or use the "Fetch now" button on /comps/import instead.
const { SOURCES } = require('../src/feeds'); const C = require('../src/comps-core');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
(async () => {
  const days = parseInt(arg('days', '30')); const only = arg('source', null); const includeOffice = !process.argv.includes('--medical-only'); const dry = process.argv.includes('--dry-run');
  const names = only ? [only] : Object.keys(SOURCES); if (only && !SOURCES[only]) throw new Error('Unknown source ' + only + '. Options: ' + Object.keys(SOURCES).join(', '));
  // On the box, once the CRM is hosted (.remote-sync.json exists), found comps are pushed to the live app instead of the local snapshot.
  const remote = !dry && !process.argv.includes('--local') ? require('../src/remote-sync').loadConfig() : null;
  const db = dry || remote ? null : await require('../src/db').migrate(); const out = {}; if (remote) out.pushed_to = remote.url;
  for (const n of names) {
    try {
      const comps = await SOURCES[n]({ days, includeOffice });
      if (dry) { out[n] = { found: comps.length, sample: comps.slice(0, 3) }; continue; }
      if (remote) { const r = await require('../src/remote-sync').push(remote, 'sale-comps', JSON.stringify({ comps }), 'application/json');
        if (r.status !== 'ok') throw new Error('push failed: ' + (r.error || 'HTTP ' + r.httpStatus));
        out[n] = { found: comps.length, inserted: r.inserted, already_had: r.updated, matched_to_crm_property: r.matched }; continue; }
      const r = await C.upsertComps(db, 'sale', comps); out[n] = { found: comps.length, inserted: r.inserted, already_had: r.updated, matched_to_crm_property: r.matched };
    } catch (e) { out[n] = { error: e.message }; process.exitCode = 2; }
  }
  console.log(new Date().toISOString(), JSON.stringify({ days, includeOffice, ...out }, null, 1));
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
