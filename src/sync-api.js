// Machine-to-machine sync API for the hosted CRM. The box (where the teammate's delta CSVs, the workbook and the
// weekly public-sales fetch live) pushes data here over HTTPS. Every route needs "Authorization: Bearer $SYNC_TOKEN".
// Disabled entirely when SYNC_TOKEN is not set.
const express = require('express'); const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
const S = require('./general-sync'); const C = require('./comps-core'); const Att = require('./attachments');

const TABLE_ORDER = ['tenants', 'tenant_aliases', 'owners', 'properties', 'property_tenants', 'property_owners', 'activities', 'buyers', 'sale_comps', 'buyer_contacts', 'lease_comps', 'listings', 'attachments', 'crm_sync_keys', 'crm_sync_runs'];
async function tableCounts(db) {
  const ts = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).map((r) => r.table_name);
  const out = {}; for (const t of ts) out[t] = (await db.query(`SELECT count(*)::int n FROM "${t}"`))[0].n; return out;
}

module.exports = function mount(app, getDb) {
  const token = process.env.SYNC_TOKEN;
  if (!token || token.length < 24) return;
  const ok = (req) => { const h = String(req.headers.authorization || ''); const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const want = Buffer.from(token); return got.length === want.length && crypto.timingSafeEqual(got, want); };
  const fails = new Map();
  const r = express.Router();
  r.use((req, res, next) => {
    const n = fails.get(req.ip) || 0; if (n > 20) return res.status(429).json({ error: 'too many bad tokens' });
    if (!ok(req)) { fails.set(req.ip, n + 1); return res.status(401).json({ error: 'bad or missing token' }); }
    next();
  });
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error('[sync-api]', req.path, e.message); res.status(400).json({ status: 'failed', error: e.message }); });
  const tmpFile = (name, buf) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sync-')); const f = path.join(d, path.basename(name)); fs.writeFileSync(f, buf); return f; };
  const cleanup = (f) => { try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* ignore */ } };

  // "Sync General tab now" pressed on the hosted app: the box worker polls this and pushes the workbook
  r.get('/requests', wrap(async (req, res) => res.json({ workbook: (await getDb().query("SELECT count(*)::int n FROM crm_sync_runs WHERE kind='workbook-request' AND status='requested'"))[0].n > 0 })));
  r.post('/requests/done', wrap(async (req, res) => { await getDb().query("UPDATE crm_sync_runs SET status='ok', finished_at=now() WHERE kind='workbook-request' AND status='requested'"); res.json({ ok: true }); }));
  // full JSON export of every table (same format /restore accepts): the box pulls this nightly as an off-Railway backup
  r.get('/export', wrap(async (req, res) => {
    const db = getDb(); const out = { exported_at: new Date().toISOString(), tables: {} };
    const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).map((x) => x.table_name);
    for (const t of tables) {
      const rows = await db.query(`SELECT * FROM "${t}"`);
      out.tables[t] = t === 'attachments' ? rows.map(Att.encodeRow) : rows;
    }
    res.set('Cache-Control', 'no-store').json(out);
  }));
  // overwrite property Notes only, from a General-layout CSV (raw body); ?dry=1 to preview. Not logged as a sync run (it is a one-off data edit).
  r.post('/property-notes', express.raw({ type: '*/*', limit: '20mb' }), wrap(async (req, res) => {
    const S = require('./general-sync'); const f = path.join(os.tmpdir(), 'notes-' + crypto.randomBytes(6).toString('hex') + '.csv');
    fs.writeFileSync(f, req.body);
    try { const data = await S.extract(f); const r2 = await S.replaceNotes(getDb(), data, { dryRun: req.query.dry === '1' });
      console.log(new Date().toISOString(), `[sync-api] property-notes${r2.dry_run ? ' (dry run)' : ''}: ${r2.updated} updated, ${r2.set_blank} set blank, ${r2.unchanged} unchanged, ${r2.unmatched} unmatched`); res.json({ status: 'ok', ...r2 }); }
    catch (e) { res.status(400).json({ status: 'failed', error: e.message }); } finally { fs.rmSync(f, { force: true }); }
  }));
  // tenant-group aliases: list, or add {aliases:[{alias, group}]} where group must be an existing tenant group (exact name). Never creates groups.
  r.get('/aliases', wrap(async (req, res) => res.json(await getDb().query('SELECT a.alias, t.name AS group, a.note, a.created_at FROM tenant_aliases a JOIN tenants t ON t.id=a.tenant_id ORDER BY 1'))));
  r.post('/aliases', express.json({ limit: '1mb' }), wrap(async (req, res) => {
    const db = getDb(); await db.exec(require('./general-sync').SCHEMA); const out = [];
    for (const a of (req.body && req.body.aliases) || []) {
      const [t] = await db.query('SELECT id, name FROM tenants WHERE name=$1', [String(a.group || '')]);
      if (!t || !String(a.alias || '').trim()) { out.push({ alias: a.alias, group: a.group, status: 'skipped: group not found' }); continue; }
      const r2 = await db.query('INSERT INTO tenant_aliases (alias, tenant_id, note) VALUES ($1,$2,$3) ON CONFLICT (alias) DO NOTHING RETURNING alias', [String(a.alias).trim(), t.id, a.note || null]);
      out.push({ alias: a.alias, group: t.name, status: r2.length ? 'added' : 'already existed' });
    }
    res.json({ status: 'ok', results: out });
  }));
  r.get('/ping', wrap(async (req, res) => res.json({ ok: true, counts: await tableCounts(getDb()) })));

  // one CSV delta: body = raw CSV bytes, ?name=crm-delta-xyz.csv
  r.post('/delta', express.raw({ type: '*/*', limit: '20mb' }), wrap(async (req, res) => {
    const name = String(req.query.name || 'crm-delta-upload.csv'); if (!/^crm-delta-[\w.\- ]+\.csv$/i.test(name)) throw new Error('name must look like crm-delta-<anything>.csv');
    const f = tmpFile(name, req.body);
    try { const r2 = await S.importDeltaFile(getDb(), f, { dryRun: req.query.dry === '1' }); console.log(new Date().toISOString(), `[sync-api] delta ${name}: ${r2.new_properties} new properties, ${r2.new_owners} new owners, ${r2.skipped.length} skipped`); res.json({ status: 'ok', ...r2 }); }
    finally { cleanup(f); }
  }));

  // the whole workbook (.xlsx bytes); re-reads its General tab with the same idempotent rules
  r.post('/workbook', express.raw({ type: '*/*', limit: '50mb' }), wrap(async (req, res) => {
    const f = tmpFile('Prospects_updated.xlsx', req.body);
    try { const r2 = await S.syncWorkbook(getDb(), { file: f, tab: String(req.query.tab || 'General'), dryRun: req.query.dry === '1' }); console.log(new Date().toISOString(), `[sync-api] workbook: ${r2.new_properties} new properties, ${r2.new_owners} new owners`); res.json({ status: 'ok', ...r2 }); }
    finally { cleanup(f); }
  }));

  // sale comps found by the box-side public-records fetch: { comps: [...] } (same shape fetch_public_sales.js builds)
  r.post('/sale-comps', express.json({ limit: '20mb' }), wrap(async (req, res) => {
    const comps = Array.isArray(req.body?.comps) ? req.body.comps : null; if (!comps) throw new Error('body must be {"comps":[...]}');
    const r2 = await C.upsertComps(getDb(), 'sale', comps); console.log(new Date().toISOString(), `[sync-api] sale comps: ${comps.length} received, ${r2.inserted} new`); res.json({ status: 'ok', received: comps.length, ...r2 });
  }));

  // analyst CSVs: sale comps (headers auto-mapped; a Buyer column feeds purchaser_entity) and companion buyer contacts. ?dry=1 previews
  r.post('/sale-comps-csv', express.text({ type: '*/*', limit: '20mb' }), wrap(async (req, res) => {
    const { parse } = require('csv-parse/sync'); const rows = parse(String(req.body || '').replace(/^\uFEFF/, ''), { relax_column_count: true, skip_empty_lines: true });
    const source = String(req.query.source || '').trim(); if (!source) throw new Error('add ?source=<label>, e.g. ?source=CoStar');
    const mapping = C.guessMapping('sale', rows[0] || []); if (mapping.address === undefined) throw new Error('no Address column found');
    const { comps, skipped } = C.mapRows('sale', rows.slice(1), mapping, source);
    if (req.query.dry === '1') return res.json({ status: 'ok', dry_run: true, rows: rows.length - 1, comps: comps.length, skipped, mapped: Object.fromEntries(Object.entries(mapping).map(([k, i]) => [k, rows[0][i]])), sample: comps.slice(0, 3) });
    const r2 = await C.upsertComps(getDb(), 'sale', comps); console.log(new Date().toISOString(), `[sync-api] sale comps csv (${source}): ${comps.length} rows, ${r2.inserted} new`); res.json({ status: 'ok', rows: rows.length - 1, skipped, ...r2 });
  }));
  r.post('/buyer-contacts', express.text({ type: '*/*', limit: '20mb' }), wrap(async (req, res) => {
    const { parse } = require('csv-parse/sync'); const rows = parse(String(req.body || '').replace(/^\uFEFF/, ''), { relax_column_count: true, skip_empty_lines: true });
    const r2 = await require('./buyers').importBuyerContacts(getDb(), rows, { dryRun: req.query.dry === '1', source: String(req.query.source || '').trim() || null });
    console.log(new Date().toISOString(), `[sync-api] buyer contacts${req.query.dry === '1' ? ' (dry run)' : ''}: ${r2.inserted} new, ${r2.updated} updated`); res.json({ status: 'ok', dry_run: req.query.dry === '1', ...r2 });
  }));

  // one-time migration of a full export (scripts/export_db.js). Only when ALLOW_RESTORE=1 AND every target table is empty.
  r.post('/restore', express.json({ limit: '100mb' }), wrap(async (req, res) => {
    if (process.env.ALLOW_RESTORE !== '1') return res.status(403).json({ error: 'restore is disabled (set ALLOW_RESTORE=1 for a one-time migration)' });
    const data = req.body; if (!data?.tables) throw new Error('body must be an export_db.js file');
    const db = getDb(); const before = await tableCounts(db);
    const busy = Object.entries(before).filter(([t, n]) => n > 0 && data.tables[t]?.length);
    if (busy.length) return res.status(409).json({ error: 'target not empty, refusing', busy: Object.fromEntries(busy) });
    const names = [...TABLE_ORDER.filter((t) => data.tables[t]), ...Object.keys(data.tables).filter((t) => !TABLE_ORDER.includes(t))];
    const known = new Set(Object.keys(before)); const unknown = names.filter((t) => !known.has(t)); if (unknown.length) throw new Error('unknown tables: ' + unknown.join(', '));
    await db.tx(async (t) => {
      for (const name of names) {
        const rows = data.tables[name]; if (!rows.length) continue;
        if (name === 'attachments') {
          for (const raw of rows) {
            const row = Att.decodeRow(raw);
            await t.query(`INSERT INTO attachments (id, kind, record_id, filename, mime_type, size_bytes, data, created_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))`,
              [row.id, row.kind, row.record_id, row.filename, row.mime_type, row.size_bytes, row.data, row.created_at || null]);
          }
        } else {
          for (let i = 0; i < rows.length; i += 500) await t.query(`INSERT INTO "${name}" SELECT * FROM json_populate_recordset(null::"${name}", $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
        }
        const hasId = (await t.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'", [name])).length;
        const seq = hasId ? (await t.query("SELECT pg_get_serial_sequence($1, 'id') s", [name]))[0].s : null;
        if (seq) await t.query(`SELECT setval($1, GREATEST((SELECT COALESCE(max(id),0) FROM "${name}"),1))`, [seq]);
      }
    });
    const after = await tableCounts(db); const expected = Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length]));
    const mismatch = Object.keys(expected).filter((k) => after[k] !== expected[k]);
    console.log(new Date().toISOString(), `[sync-api] restore: ${mismatch.length ? 'MISMATCH ' + mismatch.join(',') : 'all tables match'}`);
    res.json({ status: mismatch.length ? 'mismatch' : 'ok', expected, after, mismatch });
  }));


  // one-off reviewed notes plan (restore called properties' notes, fill empty values, add "Restored note" history); ?dry=1 previews
  r.post('/notes-plan', express.json({ limit: '20mb' }), wrap(async (req, res) => {
    const r2 = await S.applyNotesPlan(getDb(), req.body || {}, { dryRun: req.query.dry === '1' });
    console.log(new Date().toISOString(), `[sync-api] notes plan${r2.dry_run ? ' (dry run)' : ''}: ${r2.notes_restored} notes, ${r2.values_filled} values, ${r2.history_added} history`); res.json({ status: 'ok', ...r2 });
  }));


  // one-off guarded removal of owner contacts a delta run created by mistake; ?dry=1 previews
  r.post('/cleanup-run-owners', express.json(), wrap(async (req, res) => {
    const r2 = await S.cleanupRunOwners(getDb(), req.body || {}, { dryRun: req.query.dry === '1' });
    console.log(new Date().toISOString(), `[sync-api] cleanup-run-owners${r2.dry_run ? ' (dry run)' : ''}: ${r2.deleted.length} deleted, ${r2.kept.length} kept`); res.json({ status: 'ok', ...r2 });
  }));


  // lease comps (same shape as upsertComps lease rows); idempotent by source_key
  r.post('/lease-comps', express.json({ limit: '20mb' }), wrap(async (req, res) => {
    const comps = Array.isArray(req.body?.comps) ? req.body.comps : null; if (!comps) throw new Error('body must be {"comps":[...]}');
    const r2 = await C.upsertComps(getDb(), 'lease', comps); console.log(new Date().toISOString(), `[sync-api] lease comps: ${comps.length} received, ${r2.inserted} new`); res.json({ status: 'ok', received: comps.length, ...r2 });
  }));

  // one offering: property (+ empty-field enrich) + tenant link/aliases + lease comp + OM history; ?dry=1 previews
  r.post('/offering', express.json({ limit: '5mb' }), wrap(async (req, res) => {
    const r2 = await S.applyOffering(getDb(), req.body || {}, { dryRun: req.query.dry === '1' });
    console.log(new Date().toISOString(), `[sync-api] offering${r2.dry_run ? ' (dry run)' : ''}: property ${r2.property && r2.property.id}, lease ${r2.lease_comp && r2.lease_comp.id}`); res.json({ status: 'ok', ...r2 });
  }));


  // attach a file to a property/sale_comp/lease_comp. Raw body = file bytes.
  // Query: kind, record_id, filename (required). Optional: mime_type. Idempotent on (kind, record_id, filename).
  r.post('/attachment', express.raw({ type: '*/*', limit: '25mb' }), wrap(async (req, res) => {
    const kind = String(req.query.kind || '');
    const record_id = req.query.record_id;
    const filename = String(req.query.filename || '');
    const mime_type = String(req.query.mime_type || req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    const r2 = await Att.upsert(getDb(), { kind, record_id, filename, mime_type, data: buf });
    console.log(new Date().toISOString(), `[sync-api] attachment ${r2.created ? 'created' : 'exists'} id=${r2.id} ${kind}/${record_id} ${filename} ${r2.size_bytes}b`);
    res.json({ status: 'ok', ...r2, path: '/files/' + r2.id });
  }));


  // one-off: delete buyers with no linked sale_comp that has a positive cap_rate; ?dry=1 previews
  // Keeps a buyer if ANY of their purchases has cap_rate > 0. Cascades buyer_contacts; sale_comps.buyer_id → NULL.
  r.post('/delete-buyers-without-cap', express.json(), wrap(async (req, res) => {
    const dry = req.query.dry === '1';
    const db = getDb();
    // First detach uncapped comps from buyers so the Buyers tab cannot show them.
    let unlinked = 0;
    if (!dry) {
      const u = await db.query(`UPDATE sale_comps SET buyer_id = NULL, updated_at = now()
        WHERE buyer_id IS NOT NULL AND (cap_rate IS NULL OR cap_rate <= 0)`);
      unlinked = u.rowCount || 0;
    } else {
      const [u] = await db.query(`SELECT count(*)::int n FROM sale_comps
        WHERE buyer_id IS NOT NULL AND (cap_rate IS NULL OR cap_rate <= 0)`);
      unlinked = u.n;
    }
    const rows = await db.query(`
      SELECT b.id, b.entity, b.buyer_key,
        (SELECT count(*)::int FROM sale_comps c WHERE c.buyer_id = b.id) AS comps,
        (SELECT count(*)::int FROM sale_comps c WHERE c.buyer_id = b.id AND c.cap_rate IS NOT NULL AND c.cap_rate > 0) AS capped_comps,
        (SELECT count(*)::int FROM buyer_contacts bc WHERE bc.buyer_id = b.id) AS contacts
      FROM buyers b
      WHERE NOT EXISTS (
        SELECT 1 FROM sale_comps c
        WHERE c.buyer_id = b.id AND c.cap_rate IS NOT NULL AND c.cap_rate > 0
      )
      ORDER BY b.id`);
    const contactTotal = rows.reduce((n, r) => n + (r.contacts || 0), 0);
    const compsTouched = rows.reduce((n, r) => n + (r.comps || 0), 0);
    if (!dry && rows.length) {
      const ids = rows.map((r) => r.id);
      await db.query('DELETE FROM buyers WHERE id = ANY($1::int[])', [ids]);
    }
    const after = dry ? null : await tableCounts(db);
    console.log(new Date().toISOString(), `[sync-api] delete-buyers-without-cap${dry ? ' (dry run)' : ''}: matched=${rows.length}`);
    res.json({ status: 'ok', dry_run: dry, matched: rows.length, contacts_to_remove: contactTotal, comps_unlinked: compsTouched, uncapped_detached: unlinked,
      sample: rows.slice(0, 25).map((r) => ({ id: r.id, entity: r.entity, buyer_key: r.buyer_key, comps: r.comps, capped_comps: r.capped_comps, contacts: r.contacts })),
      deleted: dry ? 0 : rows.length, counts: after });
  }));


  // one-off: delete sale comps above a cap-rate threshold (fraction, default 0.13 = 13%); ?dry=1 previews
  r.post('/delete-sale-comps-above-cap', express.json(), wrap(async (req, res) => {
    const dry = req.query.dry === '1';
    const raw = req.body && req.body.above != null ? Number(req.body.above) : Number(req.query.above);
    const above = Number.isFinite(raw) && raw > 0 ? raw : 0.13;
    const db = getDb();
    const rows = await db.query(
      `SELECT id, address, city, state, cap_rate, price, sale_date, source, buyer_id
       FROM sale_comps WHERE cap_rate IS NOT NULL AND cap_rate > $1
       ORDER BY cap_rate DESC, id`, [above]);
    const bySource = {};
    for (const r of rows) bySource[r.source || '(none)'] = (bySource[r.source || '(none)'] || 0) + 1;
    if (!dry && rows.length) {
      const ids = rows.map((r) => r.id);
      await db.query('DELETE FROM sale_comps WHERE id = ANY($1::int[])', [ids]);
    }
    const after = dry ? null : await tableCounts(db);
    console.log(new Date().toISOString(), `[sync-api] delete-sale-comps-above-cap${dry ? ' (dry run)' : ''}: above=${above} matched=${rows.length}`);
    res.json({ status: 'ok', dry_run: dry, above, matched: rows.length, by_source: bySource,
      sample: rows.slice(0, 20).map((r) => ({ id: r.id, address: r.address, city: r.city, state: r.state, cap_rate: r.cap_rate, price: r.price, sale_date: r.sale_date, source: r.source })),
      deleted: dry ? 0 : rows.length, counts: after });
  }));


  // one-off: move mislabeled imported Call Back dates onto last_contacted; ?dry=1 previews
  r.post('/callback-relabel', express.json(), wrap(async (req, res) => {
    const r2 = await S.relabelImportedCallbacks(getDb(), { dryRun: req.query.dry === '1' });
    console.log(new Date().toISOString(), `[sync-api] callback-relabel${r2.dry_run ? ' (dry run)' : ''}: cleared ${r2.properties_cleared}, lc filled ${r2.last_contacted_filled}, acts ${r2.import_activities_rewritten}`);
    res.json({ status: 'ok', ...r2 });
  }));

  app.use('/api/sync', r);
};
module.exports.tableCounts = tableCounts;
