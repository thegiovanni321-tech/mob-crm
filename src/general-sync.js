// Incremental, idempotent import of prospect rows (the workbook's "General" tab, or crm-delta-*.csv files) into the CRM.
// Rules: properties are matched by normalized address incl. suite/unit (+ city + state); contacts within a property by normalized
// owner name + entity. Existing records only get EMPTY fields filled - nothing already in the CRM is overwritten.
// Things deleted in the app are remembered (crm_sync_keys) and not re-created by later syncs.
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFile } = require('child_process');
const C = require('./comps-core');
const paths = require('./paths');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crm_sync_keys (key TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id INT, first_seen TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS crm_sync_runs (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, file TEXT, status TEXT NOT NULL, result JSONB, error TEXT,
  started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON crm_sync_runs(started_at DESC);
-- optional alias names for tenant groups ("<alias> (confirmed tenant)" or Tenancy -> existing group); filled by hand, never automatically
CREATE TABLE IF NOT EXISTS tenant_aliases (alias TEXT PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, note TEXT, created_at TIMESTAMPTZ DEFAULT now());
`;
const workbookPath = () => paths.workbookPath();
const deltaDir = () => paths.deltaDir();
const EXTRACT = path.join(__dirname, '..', 'scripts', 'extract_general.py');

const normName = (n) => String(n || '').replace(/\([^)]*\)/g, ' ').split(',')[0].toLowerCase()
  .replace(/\b(dr|md|m\.d|do|dds|dmd|od|phd|jr|sr|vet)\b\.?/g, ' ').replace(/[^a-z]/g, '');
const TITLES = new Set(['dr', 'md', 'do', 'dds', 'dmd', 'od', 'phd', 'jr', 'sr', 'vet', 'dpm', 'pt', 'ra', 'cpo', 'np', 'pa', 'rn', 'ii', 'iii', 'iv', 'mr', 'mrs', 'ms', 'esq', 'cpa', 'facs', 'dvm', 'dc', 'aud', 'pharmd']);
const nameTokens = (n) => String(n || '').replace(/\([^)]*\)/g, ' ').split(',')[0].toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, '').split(/\s+/).filter((w) => w && !TITLES.has(w));
// "Jane Q Physician" = "Jane Quin Physician" = "Dr. Jane Physician MD": same first + last name and compatible middle initials
function samePerson(a, b) {
  const x = nameTokens(a); const y = nameTokens(b); if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  if (x.length < 2 || y.length < 2 || x[0] !== y[0] || x[x.length - 1] !== y[y.length - 1]) return false;
  const mx = x.slice(1, -1); const my = y.slice(1, -1); return !mx.length || !my.length || mx[0][0] === my[0][0];
}
const normEnt = (e) => String(e || '').replace(/\([^)]*\)/g, ' ').toLowerCase().replace(/\(individual\)/g, '').replace(/\b(llc|l\.l\.c|inc|lp|llp|pllc|pa|pc|ltd|co)\b\.?/g, ' ').replace(/[^a-z0-9]/g, '');
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const propKey = (p) => `prop:${C.fullAddr(p.address)}|${C.normCity(p.city)}|${p.state || ''}`;
// tenant-group names are compared ignoring case, spaces and punctuation ("EyeCare Partners" = "Eye Care Partners")
const normGroup = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// "<Group> (confirmed tenant)" in a note: the group is the text right before the marker, back to the previous ; | newline or marker.
// Parentheses inside the name are kept ("Wolfson Children's (Baptist Health)"). If the whole clause is not a known group, the longest
// known group at its end wins (so "Verified. Novant Health (confirmed tenant)" still finds Novant Health).
function confirmedTenantNames(note) {
  const out = []; const re = /\(\s*confirmed tenant\s*\)/gi; let last = 0; let m;
  while ((m = re.exec(note))) {
    const seg = note.slice(last, m.index); last = m.index + m[0].length;
    const clause = seg.split(/[;|\n\r]/).pop().replace(/^[\s,.:\-–—]+|[\s,.:\-–—]+$/g, '');
    if (clause) out.push(clause);
  }
  return out;
}
function resolveGroup(name, tByNorm, aliasByNorm) {
  const tryOne = (n) => { const k = normGroup(n); if (!k) return null; if (tByNorm.has(k)) return { id: tByNorm.get(k), via: 'name' }; if (aliasByNorm.has(k)) return { id: aliasByNorm.get(k), via: 'alias' }; return null; };
  const whole = tryOne(name); if (whole) return { ...whole, matched_text: name };
  // shorter endings of the clause, cut at ". ", ", ", ": " or " - " (longest first)
  const cuts = []; const re = /(?:\.|,|:|\s-|\s–)\s+/g; let m; while ((m = re.exec(name))) cuts.push(m.index + m[0].length);
  for (const c of cuts) { const tail = name.slice(c).trim(); const r = tryOne(tail); if (r) return { ...r, matched_text: tail }; }
  return null;
}
const empty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function extract(file, tab = 'General') {
  return new Promise((resolve, reject) => execFile('python3', [EXTRACT, file, tab], { maxBuffer: 256 * 1024 * 1024, timeout: 120000 }, (err, out, errOut) => {
    if (err) return reject(new Error('Could not read file: ' + (errOut || err.message).toString().slice(-400)));
    let j; try { j = JSON.parse(out); } catch (e) { return reject(new Error('Reader returned bad output')); }
    if (!j.ok) return reject(new Error(j.error)); resolve(j);
  }));
}

class DryRun extends Error { constructor(r) { super('dry run'); this.result = r; } }
async function apply(db, data, { label = 'sync', dryRun = false } = {}) {
  await db.exec(SCHEMA);
  try { return await db.tx(async (t) => { const r = await applyTx(t, data, label); if (dryRun) throw new DryRun(r); return r; }); }
  catch (e) { if (e instanceof DryRun) return { dry_run: true, ...e.result }; throw e; }
}
async function applyTx(t, data, label) {
  {
    const res = { source: label, rows_read: data.stats.rows, blank_rows: data.stats.blank_rows, property_blocks: data.properties.length,
      calls_colors_used: data.calls_colors_used, new_properties: 0, existing_properties_matched: 0, existing_properties_enriched: 0, fields_filled: 0,
      new_owners: 0, owners_reused_from_other_properties: 0, owners_enriched: 0, owner_links_added: 0, new_tenants: 0, tenant_links_added: 0,
      activities_added: 0, duplicates_in_file_merged: 0, skipped_deleted_in_crm: 0, new_by_state: {}, new_property_ids: [], tenant_rows: [], unmatched_groups: {}, extra_columns_ignored: data.ignored_columns || [], skipped: [...data.skipped] };
    // ---- indexes of what is already in the CRM
    const props = await t.query('SELECT * FROM properties');
    const byKey = new Map(); const byKeyNoCity = new Map();
    for (const p of props) { byKey.set(propKey(p), p); const k2 = `${C.fullAddr(p.address)}|${p.state || ''}`; if (!byKeyNoCity.has(k2)) byKeyNoCity.set(k2, []); byKeyNoCity.get(k2).push(p); }
    const keys = new Map((await t.query('SELECT key, ref_id FROM crm_sync_keys')).map((r) => [r.key, r.ref_id]));
    const propIds = new Set(props.map((p) => p.id));
    const tenants = await t.query('SELECT id, name FROM tenants'); const tByName = new Map(tenants.map((x) => [x.name.toLowerCase().trim(), x.id]));
    const tById = new Map(tenants.map((x) => [x.id, x.name])); const tByNorm = new Map(); for (const x of tenants) if (!tByNorm.has(normGroup(x.name))) tByNorm.set(normGroup(x.name), x.id);
    const aliasByNorm = new Map((await t.query('SELECT alias, tenant_id FROM tenant_aliases').catch(() => [])).map((a) => [normGroup(a.alias), a.tenant_id]));
    const owners = await t.query('SELECT * FROM owners'); const oById = new Map(owners.map((o) => [o.id, o]));
    const oByName = new Map(); for (const o of owners) { const k = normName(o.name) || 'ent:' + normEnt(o.entity); if (!oByName.has(k)) oByName.set(k, []); oByName.get(k).push(o); }
    const links = await t.query('SELECT property_id, owner_id FROM property_owners'); const ownersOf = new Map();
    for (const l of links) { if (!ownersOf.has(l.property_id)) ownersOf.set(l.property_id, new Set()); ownersOf.get(l.property_id).add(l.owner_id); }
    const tlinks = new Set((await t.query('SELECT property_id, tenant_id FROM property_tenants')).map((l) => l.property_id + ':' + l.tenant_id));
    const acts = new Set((await t.query("SELECT property_id, activity_date FROM activities WHERE kind='import'")).map((a) => `${a.property_id}|${a.activity_date || ''}`));
    const remember = async (key, kind, id) => { if (!keys.has(key)) { await t.query('INSERT INTO crm_sync_keys (key, kind, ref_id) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [key, kind, id]); keys.set(key, id); } };
    const ensureTenant = async (name) => {
      const k = name.toLowerCase().trim(); if (tByName.has(k)) return tByName.get(k);
      const [r] = await t.query('INSERT INTO tenants (name, notes) VALUES ($1,$2) RETURNING id', [name, `Created by ${label}`]); tByName.set(k, r.id); res.new_tenants++; return r.id;
    };
    const tabTenant = await ensureTenant('General'); // General-tab rows (and deltas, which use its layout) belong to the General group, as in the original import
    const seenInFile = new Map();
    for (const b of data.properties) {
      const key = propKey(b); const srcRow = `${label} row ${b.row}`;
      let p = byKey.get(key);
      if (!p && C.normCity(b.city) === '') { const l = byKeyNoCity.get(`${C.fullAddr(b.address)}|${b.state || ''}`) || []; if (l.length === 1) p = l[0]; }
      if (!p && keys.has(key) && !propIds.has(keys.get(key))) { res.skipped_deleted_in_crm++; res.skipped.push({ row: b.row, reason: 'property was deleted in the CRM earlier; not re-created', text: b.address }); continue; }
      const notes = [...b.notes, ...b.raw_dates, b.rba_raw ? 'RBA: ' + b.rba_raw : null, b.price_raw ? 'Price: ' + b.price_raw : null, b.sale_date_raw ? 'Sale date: ' + b.sale_date_raw : null,
        b.cap_raw ? 'Cap rate: ' + b.cap_raw : null].filter(Boolean).join('\n') || null;
      const talked = b.imports.map((i) => i.talked).filter(Boolean).sort().pop() || null;
      // Spreadsheet "Call Back" = last contacted (misnamed historically), NOT a future CRM callback
      const lastCalled = b.imports.map((i) => i.callback).filter(Boolean).sort().pop() || null;
      const lastContacted = [talked, lastCalled].filter(Boolean).sort().pop() || null;
      const called = b.imports.some((i) => i.called);
      const status = talked ? 'Talked' : called || lastCalled ? 'Attempted' : 'New';
      const tenantOnly = b.notes.join('\n').trim() || null; const calledRow = b.imports.length > 0;
      // "<Group> (confirmed tenant)" lines only drive tenant links; they never rewrite an existing property's Notes (so phone-only / link-only rows leave Notes alone)
      const tenantForNotes = b.notes.filter((n) => !/\(confirmed tenant\)\s*$/i.test(String(n).trim())).join('\n').trim() || null;
      const extraLines = [...b.raw_dates, b.rba_raw ? 'RBA: ' + b.rba_raw : null, b.price_raw ? 'Price: ' + b.price_raw : null, b.sale_date_raw ? 'Sale date: ' + b.sale_date_raw : null, b.cap_raw ? 'Cap rate: ' + b.cap_raw : null].filter(Boolean).join('\n') || null;
      let isNew = false; let changed = false;
      if (seenInFile.has(key)) res.duplicates_in_file_merged++;
      if (!p) {
        const [r] = await t.query(`INSERT INTO properties (address, city, state, state_raw, zip, tenancy, rba, acres, year_built, sale_date, price, cap_rate, notes, status, last_contacted, callback_date, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [b.address, b.city, b.state, b.state_raw, b.zip, b.tenancy, b.rba, b.acres, b.year_built, b.sale_date, b.price, b.cap_rate, calledRow ? notes : tenantOnly, status, lastContacted, null, 'Spreadsheet: ' + srcRow]);
        p = r; isNew = true; byKey.set(key, p); propIds.add(p.id); res.new_properties++; res.new_property_ids.push(p.id);
        if (!calledRow && extraLines) { await t.query("INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1,'note','Spreadsheet values',$2,CURRENT_DATE)", [p.id, extraLines]); res.activities_added++; }
        const st = p.state || 'Unknown'; res.new_by_state[st] = (res.new_by_state[st] || 0) + 1;
      } else if (!seenInFile.has(key)) {
        res.existing_properties_matched++;
        const fill = { zip: b.zip, tenancy: b.tenancy, rba: b.rba, acres: b.acres, year_built: b.year_built, sale_date: b.sale_date, price: b.price, cap_rate: b.cap_rate, notes, state_raw: b.state_raw,
          last_contacted: lastContacted }; // never set callback_date from the spreadsheet
        const set = Object.keys(fill).filter((k) => !empty(fill[k]) && empty(p[k]));
        // Notes: tenant-only value for never-called properties; called ones keep their note (tenant name prepended when missing)
        const calledP = await isCalledProp(t, p, b.imports);
        if (empty(p.notes) && !calledP) { fill.notes = tenantForNotes;
          if (extraLines && !(await t.query("SELECT 1 FROM activities WHERE property_id=$1 AND kind='note' AND notes=$2", [p.id, extraLines])).length) {
            await t.query("INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1,'note','Spreadsheet values',$2,CURRENT_DATE)", [p.id, extraLines]); res.activities_added++; changed = true; } }
        const nv = empty(p.notes) ? null : await notesFor(t, p, tenantForNotes, b.imports);
        if (nv !== null && !set.includes('notes')) { set.push('notes'); fill.notes = nv; res.notes_rewritten = (res.notes_rewritten || 0) + 1; }
        // status only moves off the default 'New' when nobody has worked the property in the app yet
        const [{ n: worked }] = await t.query("SELECT count(*)::int n FROM activities WHERE property_id=$1 AND kind<>'import'", [p.id]);
        if (p.status === 'New' && status !== 'New' && !worked) set.push('status');
        if (set.includes('notes') && empty(fill.notes)) set.splice(set.indexOf('notes'), 1);
        if (set.length) {
          const vals = set.map((k) => (k === 'status' ? status : fill[k]));
          const [r] = await t.query(`UPDATE properties SET ${set.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [p.id, ...vals]);
          p = r; byKey.set(key, p); res.fields_filled += set.filter((k) => !(k === 'notes' && nv !== null)).length; changed = true;
        }
      }
      seenInFile.set(key, p.id);
      await remember(key, 'property', p.id);
      // ---- tenant groups: the tab's group, plus an exact match of Tenancy or a "<Group> (confirmed tenant)" note to an existing group
      const tids = new Set(); if (tabTenant) tids.add(tabTenant);
      const named = []; // groups named on this row (Tenancy column or "(confirmed tenant)" notes), reported per row
      if (b.tenancy) { const g = resolveGroup(b.tenancy, tByNorm, aliasByNorm); if (g) named.push({ from: 'tenancy', written: b.tenancy, ...g }); } // Tenancy values that are not a group are just ignored (it is often free text)
      // "Confirmed Tenant" column: group/practice names separated by ";" (blank = unconfirmed). Old "<Group> (confirmed tenant)" notes are the fallback when it is blank.
      const ct = String(b.confirmed_tenant || '').split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean);
      for (const w of ct) named.push({ from: 'confirmed_tenant', written: w, ...(resolveGroup(w, tByNorm, aliasByNorm) || {}) });
      if (!ct.length) for (const note of b.notes) for (const w of confirmedTenantNames(note)) named.push({ from: 'note', written: w, ...(resolveGroup(w, tByNorm, aliasByNorm) || {}) });
      const row = { row: b.row, address: b.address, city: b.city, state: b.state, property_id: p.id };
      for (const g of named) {
        if (!g.id) { res.tenant_rows.push({ ...row, group_as_written: g.written, from: g.from, outcome: 'unmatched' }); res.unmatched_groups[g.written] = (res.unmatched_groups[g.written] || 0) + 1; continue; }
        const already = tlinks.has(p.id + ':' + g.id) || tids.has(g.id);
        res.tenant_rows.push({ ...row, group_as_written: g.written, from: g.from, outcome: already ? 'already_linked' : 'linked', group: tById.get(g.id), ...(g.via === 'alias' ? { via_alias: true } : {}), ...(g.matched_text !== g.written ? { matched_text: g.matched_text } : {}) });
        tids.add(g.id);
      }
      for (const tid of tids) if (!tlinks.has(p.id + ':' + tid)) { await t.query('INSERT INTO property_tenants VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, tid]); tlinks.add(p.id + ':' + tid); res.tenant_links_added++; changed = true; }
      // ---- contacts
      const mainEntity = (b.contacts.find((c) => c.entity) || {}).entity || null;
      const contactOwner = [];
      for (const c of b.contacts) {
        const nn = normName(c.name); const ne = normEnt(c.entity || mainEntity); const okey = `owner:${p.id}|${nn || 'ent:' + ne}|${nn ? ne : ''}`;
        const linked = [...(ownersOf.get(p.id) || [])].map((id) => oById.get(id)).filter(Boolean);
        // Same person already on this property = same contact. (The original import kept one entity per person across all their
        // properties, so a different entity spelling on an existing contact is not treated as a new person.) Entity-only contacts match on entity.
        let o = linked.find((x) => (nn ? normName(x.name) === nn && (!ne || !normEnt(x.entity) || normEnt(x.entity) === ne) : !normName(x.name) && normEnt(x.entity) === ne))
          || (nn ? linked.find((x) => normName(x.name) === nn || samePerson(x.name, c.name)) : null)
          // entity-only row (no Owner 1): the owner already on this property with that entity name
          || (!nn && ne ? linked.find((x) => normEnt(x.entity) === ne) : null);
        // a row with no Owner 1 and no contact details (only Entity, e.g. a tenant-link-only row) never creates a contact on a property that already has owners
        const hasDetails = c.phones.length || c.email || c.website || c.mailing_address || c.age;
        if (!o && !nn && !hasDetails && linked.length) { contactOwner.push(null); res.contactless_rows_no_owner = (res.contactless_rows_no_owner || 0) + 1; continue; }
        if (!o && keys.has(okey)) { contactOwner.push(null); continue; } // this contact was removed from the property in the app
        const phones = c.phones;
        if (!o) {
          // same person + same entity already in the CRM on another property -> reuse that owner record (original import rule)
          const cands = oByName.get(nn || 'ent:' + ne) || [];
          o = cands.find((x) => ne && normEnt(x.entity) === ne && (!phones.length || ![1, 2, 3, 4, 5].some((k) => x['phone' + k]) || phones.some((ph) => [1, 2, 3, 4, 5].some((k) => digits(x['phone' + k]) === digits(ph)))));
          if (o) res.owners_reused_from_other_properties++;
        }
        if (!o) {
          const ph = [...phones.slice(0, 5), null, null, null, null, null].slice(0, 5);
          const extra = phones.slice(5); const [r] = await t.query(`INSERT INTO owners (name, entity, age, phone1, phone2, phone3, phone4, phone5, email, website, mailing_address, notes)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [c.name, c.entity || (c.name ? mainEntity : null), c.age, ...ph, c.email, c.website, c.mailing_address, extra.length ? 'Other phones: ' + extra.join(', ') : null]);
          o = r; oById.set(o.id, o); const k = nn || 'ent:' + ne; if (!oByName.has(k)) oByName.set(k, []); oByName.get(k).push(o); res.new_owners++;
        } else {
          const set = {}; for (const k of ['entity', 'age', 'email', 'website', 'mailing_address']) { const v = k === 'entity' ? (c.entity || mainEntity) : c[k]; if (!empty(v) && empty(o[k])) set[k] = v; }
          const have = new Set([1, 2, 3, 4, 5].map((k) => digits(o['phone' + k])).filter(Boolean)); const slots = [1, 2, 3, 4, 5].filter((k) => empty(o['phone' + k]));
          for (const ph of phones) if (!have.has(digits(ph)) && slots.length) { set['phone' + slots.shift()] = ph; have.add(digits(ph)); }
          const ks = Object.keys(set);
          if (ks.length) { const [r] = await t.query(`UPDATE owners SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [o.id, ...ks.map((k) => set[k])]); o = r; oById.set(o.id, o); res.owners_enriched++; changed = true; }
        }
        if (!(ownersOf.get(p.id) || new Set()).has(o.id)) {
          await t.query('INSERT INTO property_owners VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, o.id]);
          if (!ownersOf.has(p.id)) ownersOf.set(p.id, new Set()); ownersOf.get(p.id).add(o.id); res.owner_links_added++; changed = true;
        }
        await remember(okey, 'owner_link', o.id); contactOwner.push(o.id);
      }
      // ---- call history from Date Talked To / Call Back (Call Back = last contacted date, stored as activity_date)
      for (const im of b.imports) {
        const actDate = im.talked || im.callback || null;
        const k = `${p.id}|${actDate || ''}`; if (acts.has(k)) continue;
        const outcome = im.talked ? 'Talked' : 'Called';
        await t.query(`INSERT INTO activities (property_id, owner_id, kind, outcome, notes, activity_date, callback_date) VALUES ($1,$2,'import',$3,$4,$5,$6)`,
          [p.id, im.contact !== null && im.contact !== undefined ? contactOwner[im.contact] || null : null, outcome, `Imported from ${srcRow.replace(/ row (\d+)$/, ' (row $1)')}`, actDate, null]);
        acts.add(k); res.activities_added++; if (!isNew) changed = true;
      }
      if (!isNew && changed && !res._enriched?.has(p.id)) { (res._enriched ||= new Set()).add(p.id); res.existing_properties_enriched++; }
    }
    delete res._enriched;
    res.comps_linked = await relinkComps(t);
    return res;
  }
}

// Link comps that have no property yet to a CRM property with the same address (used after every sync).
async function relinkComps(db) {
  const idx = await C.propertyIndex(db); let n = 0;
  for (const table of ['sale_comps', 'lease_comps']) {
    const rows = await db.query(`SELECT id, address, city, state, tenant_id FROM ${table} WHERE property_id IS NULL AND address IS NOT NULL`);
    for (const c of rows) { const p = idx.match(c.address, c.city, c.state); if (p) { await db.query(`UPDATE ${table} SET property_id=$2, tenant_id=COALESCE(tenant_id,$3), updated_at=now() WHERE id=$1 AND property_id IS NULL`, [c.id, p.id, p.tenant_id]); n++; } }
  }
  return n;
}

// Overwrite ONLY properties.notes from a General-layout file (Building Address/City/State + Notes), matching properties exactly as the sync does.
// Blank Notes in the file -> notes set to NULL. Nothing else on the property (not even updated_at), its links, or activity notes is touched. One transaction.
async function replaceNotes(db, data, { dryRun = false } = {}) {
  return serial(async () => {
    try { return await db.tx(async (t) => {
      const props = await t.query('SELECT id, address, city, state, notes, status, last_contacted, callback_date, created_at, updated_at FROM properties');
      const byKey = new Map(); const byKeyNoCity = new Map();
      for (const p of props) { byKey.set(propKey(p), p); const k2 = `${C.fullAddr(p.address)}|${p.state || ''}`; if (!byKeyNoCity.has(k2)) byKeyNoCity.set(k2, []); byKeyNoCity.get(k2).push(p); }
      const res = { dry_run: dryRun, property_blocks: data.properties.length, updated: 0, set_blank: 0, unchanged: 0, unmatched: 0, duplicate_in_file: 0, rows: [] }; const seen = new Map();
      for (const b of data.properties) {
        let p = byKey.get(propKey(b));
        if (!p && C.normCity(b.city) === '') { const l = byKeyNoCity.get(`${C.fullAddr(b.address)}|${b.state || ''}`) || []; if (l.length === 1) p = l[0]; }
        const row = { row: b.row, address: b.address, city: b.city, state: b.state };
        if (!p) { res.unmatched++; res.rows.push({ ...row, outcome: 'unmatched' }); continue; }
        if (seen.has(p.id)) { res.duplicate_in_file++; res.rows.push({ ...row, property_id: p.id, outcome: 'duplicate_in_file', first_row: seen.get(p.id) }); continue; }
        seen.set(p.id, b.row);
        const tv = b.notes.join('\n').trim() || null; const ov = p.notes == null || String(p.notes).trim() === '' ? null : p.notes;
        const called = await isCalledProp(t, p); const nv = called ? mergeTenantNote(tv, ov) : tv; if (called) res.called_kept = (res.called_kept || 0) + 1;
        if ((nv || null) === (ov == null ? null : String(ov).trim()) ) { res.unchanged++; res.rows.push({ ...row, property_id: p.id, outcome: 'unchanged' }); continue; }
        await t.query('UPDATE properties SET notes=$2 WHERE id=$1', [p.id, nv]);
        if (nv) res.updated++; else res.set_blank++;
        res.rows.push({ ...row, property_id: p.id, outcome: nv ? 'updated' : 'set_blank', old_notes: p.notes, new_notes: nv, created_at: p.created_at, updated_at: p.updated_at });
      }
      if (dryRun) throw new DryRun(res); return res;
    }); } catch (e) { if (e instanceof DryRun) return e.result; throw e; }
  });
}


// ---------- "called" + tenant-only Notes rule ----------
// A property counts as called when its status is not 'New', it has any call history/activity, a contact date is set,
// or its note holds call content. Called properties keep their Notes (the incoming tenant name is put on the first line
// when it is not already in the note); only never-called properties get a tenant-only Notes value.
const CALL_RE = /\b(said (that )?(he|she|they)|told (me|us)|spoke (with|to)|talked (to|with)|left (a )?(vm|voicemail|message|msg)|lvm|not interested|call(ed)? back|no answer|hung up|wants? to sell|wanted \$)/i;
const nrm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function isCalledProp(t, p, incomingImports = []) {
  if ((p.status || 'New') !== 'New' || p.last_contacted || p.callback_date || incomingImports.length) return true;
  if (CALL_RE.test(String(p.notes || ''))) return true;
  const [{ n }] = await t.query("SELECT count(*)::int n FROM activities WHERE property_id=$1 AND NOT (kind='note' AND outcome IN ('Restored note','Spreadsheet values','Offering memorandum'))", [p.id]); return n > 0;
}
function mergeTenantNote(tenant, old) {
  const tv = String(tenant || '').trim(); const ov = String(old || '').trim();
  if (!ov) return tv || null; if (!tv || nrm(ov).includes(nrm(tv))) return ov; return tv + '\n' + ov;
}
// the Notes value a sync should leave on an existing property, given the file's tenant-only Notes value (null = leave as is)
async function notesFor(t, p, tenantOnly, incomingImports) {
  const tv = String(tenantOnly || '').trim(); if (!tv) return null;
  const cur = p.notes == null ? '' : String(p.notes).trim();
  const nv = (await isCalledProp(t, p, incomingImports)) ? mergeTenantNote(tv, cur) : tv;
  return nv === cur ? null : nv;
}

// one sync at a time (watcher, "Sync now" button and scripts share this queue)
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
async function logRun(db, kind, file, fn, { dryRun = false } = {}) {
  await db.exec(SCHEMA);
  if (dryRun) return fn(); // dry runs change nothing and are not added to the sync history
  const [run] = await db.query('INSERT INTO crm_sync_runs (kind, file, status) VALUES ($1,$2,$3) RETURNING id', [kind, file, 'running']);
  if (process.env.SYNC_DRY_RUN_NOLOG) await db.query('DELETE FROM crm_sync_runs WHERE id=$1', [run.id]);
  try { const r = await fn(); await db.query('UPDATE crm_sync_runs SET status=$2, result=$3, finished_at=now() WHERE id=$1', [run.id, 'ok', JSON.stringify(r)]); return r; }
  catch (e) { await db.query('UPDATE crm_sync_runs SET status=$2, error=$3, finished_at=now() WHERE id=$1', [run.id, 'failed', e.message]); throw e; }
}


// One-off: apply a reviewed plan in ONE transaction. plan = { notes: [{id, expect, notes}], fills: [{id, field, value}], history: [{id, notes, outcome}] }.
// Notes change only when the current value still equals `expect`; fills only touch empty rba/price/sale_date/cap_rate; any mismatch aborts everything.
async function applyNotesPlan(db, plan, { dryRun = false } = {}) {
  return serial(async () => {
    try { return await db.tx(async (t) => {
      const res = { dry_run: dryRun, notes_restored: 0, values_filled: 0, history_added: 0, rows: [] };
      for (const n of plan.notes || []) {
        const [p] = await t.query('SELECT id, address, city, notes FROM properties WHERE id=$1', [n.id]); if (!p) throw new Error('property ' + n.id + ' not found');
        if (String(p.notes || '').trim() !== String(n.expect || '').trim()) throw new Error(`property ${n.id} notes changed since the plan was made; nothing applied`);
        await t.query('UPDATE properties SET notes=$2 WHERE id=$1', [p.id, n.notes]); res.notes_restored++; res.rows.push({ id: p.id, address: p.address, city: p.city, action: 'notes_restored' });
      }
      for (const f of plan.fills || []) {
        if (!['rba', 'price', 'sale_date', 'cap_rate'].includes(f.field)) throw new Error('bad field ' + f.field);
        const r = await t.query(`UPDATE properties SET ${f.field}=$2 WHERE id=$1 AND ${f.field} IS NULL RETURNING id, address, city`, [f.id, f.value]);
        if (r.length) { res.values_filled++; res.rows.push({ id: f.id, address: r[0].address, city: r[0].city, action: 'filled ' + f.field, value: f.value }); }
        else res.rows.push({ id: f.id, action: 'not filled (already set) ' + f.field });
      }
      for (const h of plan.history || []) {
        const dup = await t.query("SELECT 1 FROM activities WHERE property_id=$1 AND kind='note' AND outcome=$2 AND notes=$3", [h.id, h.outcome || 'Restored note', h.notes]);
        if (dup.length) { res.rows.push({ id: h.id, action: 'history already present' }); continue; }
        await t.query("INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1,'note',$2,$3,CURRENT_DATE)", [h.id, h.outcome || 'Restored note', h.notes]);
        res.history_added++; res.rows.push({ id: h.id, action: 'history added' });
      }
      if (dryRun) throw new DryRun(res); return res;
    }); } catch (e) { if (e instanceof DryRun) return e.result; throw e; }
  });
}


// One-off guarded cleanup of owner contacts a given delta run created by mistake. Every condition is re-checked inside ONE transaction;
// an owner that fails any check is kept (reported with what it holds). ?dry=1 previews.
async function cleanupRunOwners(db, { run_file, owner_ids = [] }, { dryRun = false } = {}) {
  return serial(async () => {
    try { return await db.tx(async (t) => {
      const [run] = await t.query("SELECT id, started_at, finished_at FROM crm_sync_runs WHERE file=$1 AND kind='delta' AND status='ok' ORDER BY id DESC LIMIT 1", [run_file]);
      if (!run) throw new Error('run not found: ' + run_file);
      const res = { dry_run: dryRun, run_id: run.id, deleted: [], kept: [] };
      for (const id of owner_ids) {
        const [o] = await t.query('SELECT * FROM owners WHERE id=$1', [id]); if (!o) { res.kept.push({ id, reason: 'not found' }); continue; }
        const why = [];
        const end = new Date(run.finished_at || Date.now()).getTime() + 1000; const ct = new Date(o.created_at).getTime();
        if (ct < new Date(run.started_at).getTime() - 1000 || ct > end) why.push('not created during that run');
        const keys = await t.query("SELECT key, first_seen FROM crm_sync_keys WHERE kind='owner_link' AND ref_id=$1", [id]);
        if (!keys.length || keys.some((k) => { const f = new Date(k.first_seen).getTime(); return f < new Date(run.started_at).getTime() - 1000 || f > end; })) why.push('sync keys not all from that run');
        const held = ['name', 'phone1', 'phone2', 'phone3', 'phone4', 'phone5', 'email', 'website', 'mailing_address', 'age', 'notes'].filter((k) => o[k] !== null && String(o[k]).trim() !== '');
        if (held.length) why.push('holds ' + held.map((k) => `${k}=${o[k]}`).join(', '));
        const [{ n: acts }] = await t.query('SELECT count(*)::int n FROM activities WHERE owner_id=$1', [id]); if (acts) why.push(acts + ' activities');
        const links = await t.query('SELECT property_id FROM property_owners WHERE owner_id=$1', [id]); if (links.length !== 1) why.push(links.length + ' property links');
        const fk = await t.query("SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='owners' AND tc.table_name NOT IN ('property_owners','activities')");
        for (const f of fk) { const [{ n }] = await t.query(`SELECT count(*)::int n FROM "${f.table_name}" WHERE "${f.column_name}"=$1`, [id]); if (n) why.push(`referenced by ${f.table_name}`); }
        if (links.length === 1 && o.entity) {
          const dup = await t.query('SELECT o2.id, o2.entity FROM property_owners po JOIN owners o2 ON o2.id=po.owner_id WHERE po.property_id=$1 AND o2.id<>$2', [links[0].property_id, id]);
          if (!dup.some((d) => normEnt(d.entity) === normEnt(o.entity))) why.push('its entity is not already on the property');
        }
        if (why.length) { res.kept.push({ id, entity: o.entity, reasons: why }); continue; }
        await t.query("DELETE FROM crm_sync_keys WHERE kind='owner_link' AND ref_id=$1", [id]);
        await t.query('DELETE FROM property_owners WHERE owner_id=$1', [id]); await t.query('DELETE FROM owners WHERE id=$1', [id]);
        res.deleted.push({ id, entity: o.entity, property_id: links[0].property_id });
      }
      if (dryRun) throw new DryRun(res); return res;
    }); } catch (e) { if (e instanceof DryRun) return e.result; throw e; }
  });
}


// Idempotent offering import (property + tenant link + lease comp + OM history). Empty property fields only; never overwrites notes/status on an existing called property.
// body.property: address/city/state/zip + optional fields. body.tenant: {name, aliases[]}. body.lease_comp: lease fields incl. source_key. body.history_notes: OM text.
async function applyOffering(db, body, { dryRun = false } = {}) {
  const C2 = require('./comps-core');
  await db.exec(SCHEMA); await db.exec(C2.SCHEMA);
  return serial(async () => {
    try { return await db.tx(async (t) => {
      const propIn = body.property || {}; if (!propIn.address || !propIn.city || !propIn.state) throw new Error('property.address/city/state required');
      const res = { dry_run: dryRun, property: null, property_created: false, fields_filled: [], tenant: null, tenant_created: false, aliases_added: [], lease_comp: null, lease_inserted: false, history_added: false };
      // ---- tenant group
      const tName = String((body.tenant && body.tenant.name) || '').trim();
      let tenant = null;
      if (tName) {
        const want = [tName, ...((body.tenant.aliases || []).map((a) => String(a).trim()).filter(Boolean))];
        const allT = await t.query('SELECT id, name FROM tenants');
        const aliases = await t.query('SELECT alias, tenant_id FROM tenant_aliases');
        const byNorm = new Map(allT.map((x) => [normGroup(x.name), x]));
        for (const a of aliases) if (!byNorm.has(normGroup(a.alias))) byNorm.set(normGroup(a.alias), allT.find((x) => x.id === a.tenant_id));
        for (const w of want) { const hit = byNorm.get(normGroup(w)); if (hit) { tenant = hit; break; } }
        if (!tenant) {
          const [r] = await t.query('INSERT INTO tenants (name, notes) VALUES ($1,$2) RETURNING id, name', [tName, body.tenant.notes || 'Created from offering memorandum']);
          tenant = r; res.tenant_created = true;
        }
        res.tenant = { id: tenant.id, name: tenant.name };
        for (const a of (body.tenant.aliases || [])) {
          const al = String(a).trim(); if (!al || normGroup(al) === normGroup(tenant.name)) continue;
          const ins = await t.query('INSERT INTO tenant_aliases (alias, tenant_id, note) VALUES ($1,$2,$3) ON CONFLICT (alias) DO NOTHING RETURNING alias', [al, tenant.id, body.tenant.alias_note || 'Offering memorandum']);
          if (ins.length) res.aliases_added.push(al);
        }
      }
      // ---- property (match by suite-aware address)
      const key = propKey(propIn);
      const props = await t.query('SELECT * FROM properties');
      p = props.find((x) => propKey(x) === key) || null;
      if (!p) {
        const notes = propIn.notes || null;
        const [r] = await t.query(`INSERT INTO properties (address, city, state, state_raw, zip, tenancy, rba, acres, year_built, sale_date, price, cap_rate, notes, status, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [propIn.address, propIn.city, propIn.state, propIn.state_raw || null, propIn.zip || null, propIn.tenancy || null, propIn.rba ?? null, propIn.acres ?? null,
           propIn.year_built || null, propIn.sale_date || null, propIn.price ?? null, propIn.cap_rate ?? null, notes, propIn.status || 'New', propIn.source || null]);
        p = r; res.property_created = true;
        await t.query('INSERT INTO crm_sync_keys (key, kind, ref_id) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [key, 'property', p.id]);
      } else {
        const fill = { zip: propIn.zip, tenancy: propIn.tenancy, rba: propIn.rba, acres: propIn.acres, year_built: propIn.year_built,
          sale_date: propIn.sale_date, price: propIn.price, cap_rate: propIn.cap_rate, source: propIn.source };
        const set = Object.keys(fill).filter((k) => !empty(fill[k]) && empty(p[k]));
        // Notes: only fill when blank and uncalled; never overwrite existing notes/status
        if (propIn.notes && empty(p.notes) && !(await isCalledProp(t, p))) { set.push('notes'); fill.notes = propIn.notes; }
        if (set.length) {
          const [r] = await t.query(`UPDATE properties SET ${set.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [p.id, ...set.map((k) => fill[k])]);
          p = r; res.fields_filled = set;
        }
      }
      res.property = { id: p.id, address: p.address, city: p.city, state: p.state, notes: p.notes, price: p.price, rba: p.rba, cap_rate: p.cap_rate, status: p.status };
      if (tenant) {
        const link = await t.query('INSERT INTO property_tenants (property_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING property_id', [p.id, tenant.id]);
        res.tenant_linked = !!link.length || true;
      }
      // ---- lease comp (idempotent by source_key)
      if (body.lease_comp) {
        const lc = { ...body.lease_comp, property_id: p.id, tenant_id: tenant ? tenant.id : (body.lease_comp.tenant_id || null),
          address: body.lease_comp.address || p.address, city: body.lease_comp.city || p.city, state: body.lease_comp.state || p.state, zip: body.lease_comp.zip || p.zip };
        if (!lc.source_key) throw new Error('lease_comp.source_key required');
        const r2 = await C2.upsertComps(t, 'lease', [lc], { autoMatch: false });
        res.lease_inserted = r2.inserted > 0; res.lease_comp = { id: r2.ids[0], inserted: r2.inserted > 0, updated: r2.updated > 0 };
      }
      // ---- OM history entry (not a call)
      if (body.history_notes) {
        const outcome = body.history_outcome || 'Offering memorandum';
        const dup = await t.query("SELECT 1 FROM activities WHERE property_id=$1 AND kind='note' AND outcome=$2 AND notes=$3", [p.id, outcome, body.history_notes]);
        if (!dup.length) {
          await t.query("INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1,'note',$2,$3,CURRENT_DATE)", [p.id, outcome, body.history_notes]);
          res.history_added = true;
        }
      }
      if (dryRun) throw new DryRun(res); return res;
    }); } catch (e) { if (e instanceof DryRun) return e.result; throw e; }
  });
}


// One-off: spreadsheet "Call Back" was last-contacted, not a future callback. Move imported callback_date → last_contacted, clear property CB,
// and rewrite import activities accordingly. Leaves kind='call' callbacks alone. One transaction; ?dry=1 previews.
async function relabelImportedCallbacks(db, { dryRun = false } = {}) {
  return serial(async () => {
    try { return await db.tx(async (t) => {
      const res = {
        dry_run: dryRun,
        properties_cleared: 0,
        last_contacted_filled: 0,
        last_contacted_updated: 0,
        real_callbacks_left_alone: 0,
        import_activities_rewritten: 0,
        samples: [],
      };
      // Properties whose callback_date matches an import activity, and no in-app call scheduled that same callback
      const victims = await t.query(`
        SELECT p.id, p.address, p.city, p.state, p.status, p.callback_date, p.last_contacted
        FROM properties p
        WHERE p.callback_date IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM activities a
            WHERE a.property_id = p.id AND a.kind = 'import' AND a.callback_date = p.callback_date
          )
          AND NOT EXISTS (
            SELECT 1 FROM activities a
            WHERE a.property_id = p.id AND a.kind = 'call' AND a.callback_date = p.callback_date
          )`);
      const leftAlone = await t.query(`
        SELECT count(*)::int n FROM properties p
        WHERE p.callback_date IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM activities a
            WHERE a.property_id = p.id AND a.kind = 'call' AND a.callback_date = p.callback_date
          )`);
      res.real_callbacks_left_alone = leftAlone[0].n;
      for (const p of victims) {
        const cb = p.callback_date;
        let filled = false, updated = false;
        let newLc = p.last_contacted;
        if (!p.last_contacted || String(cb).slice(0, 10) > String(p.last_contacted).slice(0, 10)) {
          if (!p.last_contacted) filled = true; else updated = true;
          newLc = cb;
        }
        await t.query(
          `UPDATE properties SET last_contacted = $2, callback_date = NULL, updated_at = now() WHERE id = $1`,
          [p.id, newLc],
        );
        res.properties_cleared++;
        if (filled) res.last_contacted_filled++;
        if (updated) res.last_contacted_updated++;
        if (res.samples.length < 12) {
          res.samples.push({
            id: p.id,
            address: [p.address, p.city, p.state].filter(Boolean).join(', '),
            imported_cb: cb,
            last_contacted_before: p.last_contacted,
            last_contacted_after: newLc,
            status: p.status,
          });
        }
      }
      // Rewrite import activities that still carry a callback_date
      const acts = await t.query(`SELECT id, property_id, outcome, activity_date, callback_date FROM activities WHERE kind = 'import' AND callback_date IS NOT NULL`);
      for (const a of acts) {
        const actDate = a.activity_date || a.callback_date;
        const outcome = a.outcome === 'Callback set' ? 'Called' : a.outcome;
        await t.query(
          `UPDATE activities SET activity_date = $2, outcome = $3, callback_date = NULL WHERE id = $1`,
          [a.id, actDate, outcome],
        );
        res.import_activities_rewritten++;
      }
      if (dryRun) throw new DryRun(res); return res;
    }); } catch (e) { if (e instanceof DryRun) return e.result; throw e; }
  });
}


// Re-read the General tab from a fresh read-only copy of the workbook.
async function syncWorkbook(db, { file = workbookPath(), tab = 'General', dryRun = false } = {}) {
  return serial(() => logRun(db, 'workbook', `${path.basename(file)} / ${tab}`, async () => {
    if (!fs.existsSync(file)) throw new Error('Workbook not found: ' + file);
    const copy = path.join(os.tmpdir(), `prospects_sync_copy_${process.pid}.xlsx`); fs.copyFileSync(file, copy);
    try { return await apply(db, await extract(copy, tab), { label: tab, dryRun }); } finally { fs.rmSync(copy, { force: true }); }
  }, { dryRun }));
}
async function importDeltaFile(db, file, { dryRun = false } = {}) {
  return serial(() => logRun(db, 'delta', path.basename(file), async () => apply(db, await extract(file), { label: 'delta ' + path.basename(file), dryRun }), { dryRun }));
}

// ---------- folder watcher: DATA_DIR/incoming/crm-delta-*.csv (override with DELTA_DIR) ----------
function startWatcher(getDb, { dir = deltaDir(), everyMs = 60000, log = console.log } = {}) {
  const done = path.join(dir, 'crm-delta-processed'); const failed = path.join(dir, 'crm-delta-failed');
  const sizes = new Map(); let busy = false;
  const dest = (folder, name) => { let p = path.join(folder, name); if (fs.existsSync(p)) p = path.join(folder, name.replace(/\.csv$/i, '') + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv'); return p; };
  async function tick() {
    if (busy || !fs.existsSync(dir)) return; busy = true;
    try {
      const files = fs.readdirSync(dir).filter((f) => /^crm-delta-.*\.csv$/i.test(f)).sort();
      for (const f of files) {
        const full = path.join(dir, f); let st; try { st = fs.statSync(full); } catch { continue; }
        // wait until the file stops changing (same size on two polls and not modified in the last 10 s) so half-written files are not read
        const prev = sizes.get(f); sizes.set(f, st.size);
        if (prev !== st.size || Date.now() - st.mtimeMs < 10000) continue;
        sizes.delete(f);
        fs.mkdirSync(done, { recursive: true }); fs.mkdirSync(failed, { recursive: true });
        try {
          const r = await importDeltaFile(getDb(), full);
          const to = dest(done, f); fs.renameSync(full, to);
          fs.writeFileSync(to + '.result.json', JSON.stringify({ file: f, processed_at: new Date().toISOString(), status: 'ok', ...r }, null, 1));
          log(`[delta] ${f}: ${r.new_properties} new properties, ${r.existing_properties_enriched} enriched, ${r.new_owners} new owners, ${r.skipped.length} rows skipped -> ${to}`);
        } catch (e) {
          const to = dest(failed, f); try { fs.renameSync(full, to); } catch { /* left in place */ }
          fs.writeFileSync(to + '.error.txt', `${new Date().toISOString()}\n${f} was NOT imported (no changes were made).\nReason: ${e.message}\n\nFix the file and save it again as ${path.join(dir, f)}.\n`);
          log(`[delta] ${f} FAILED: ${e.message} -> ${to}`);
        }
      }
    } catch (e) { log('[delta] watcher error: ' + e.message); } finally { busy = false; }
  }
  const timer = setInterval(tick, everyMs); timer.unref?.(); setTimeout(tick, 5000).unref?.();
  log(`[delta] watching ${dir}/crm-delta-*.csv every ${Math.round(everyMs / 1000)}s`);
  return { tick, get busy() { return busy; } };
}

module.exports = { applyOffering, cleanupRunOwners, applyNotesPlan, relabelImportedCallbacks, isCalledProp, mergeTenantNote, CALL_RE, replaceNotes, propKey, get LIVE() { return workbookPath(); }, workbookPath, deltaDir, normGroup, confirmedTenantNames, resolveGroup, samePerson, applyTx, SCHEMA, extract, apply, relinkComps, syncWorkbook, importDeltaFile, startWatcher, normName, normEnt, propKey };
