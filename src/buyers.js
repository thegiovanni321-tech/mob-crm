// Buyers (purchasers from sale comps) + listing → likely-buyer scoring. Grounded only in CRM fields.
// A buyer comes from a sale comp's purchaser_name / purchaser_entity (analyst data), falling back to the recorded
// grantee in sale_comps.buyer (public records). Phones/emails come only from purchaser_* fields or a linked owner.
const G = require('./general-sync');

const nkey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const entKey = (s) => G.normEnt(s) || nkey(s);
function buyerKeyOf(c) {
  // the purchasing entity is the buyer's identity; a contact name only keys the buyer when there is no entity
  const name = String(c.purchaser_name || '').trim() || null; const ent = String(c.purchaser_entity || c.buyer || '').trim();
  if (ent && entKey(ent)) return { key: 'e:' + entKey(ent), name, entity: ent };
  if (name && G.normName(name)) return { key: 'n:' + G.normName(name), name, entity: null };
  return null;
}

// Idempotent: create/refresh buyers from sale comps and set sale_comps.buyer_id. Never invents contact details.
async function syncBuyers(db) {
  // Buyers tab is capped-comps only: never create/link buyers from sales without a positive cap rate.
  const unlinked = await db.query(`UPDATE sale_comps SET buyer_id = NULL, updated_at = now()
    WHERE buyer_id IS NOT NULL AND (cap_rate IS NULL OR cap_rate <= 0)`);
  const comps = await db.query(`SELECT id, purchaser_name, purchaser_entity, purchaser_phone, purchaser_email, purchaser_owner_id, buyer, buyer_id
    FROM sale_comps
    WHERE cap_rate IS NOT NULL AND cap_rate > 0
      AND COALESCE(NULLIF(trim(purchaser_name),''), NULLIF(trim(purchaser_entity),''), NULLIF(trim(buyer),'')) IS NOT NULL`);
  if (!comps.length) return { buyers: 0, linked: 0, unlinked: unlinked.rowCount || 0 };
  const owners = await db.query('SELECT id, name, entity FROM owners');
  const byName = new Map(); const byEnt = new Map();
  for (const o of owners) {
    const n = G.normName(o.name); if (n) byName.set(n, (byName.get(n) || []).concat(o.id));
    const e = G.normEnt(o.entity); if (e) byEnt.set(e, (byEnt.get(e) || []).concat(o.id));
  }
  const existing = new Map((await db.query('SELECT * FROM buyers')).map((b) => [b.buyer_key, b]));
  let created = 0; let linked = 0;
  for (const c of comps) {
    const k = buyerKeyOf(c); if (!k) continue;
    let ownerId = c.purchaser_owner_id || null;
    if (!ownerId && k.name) { const l = byName.get(G.normName(k.name)) || []; if (l.length === 1) ownerId = l[0]; }
    if (!ownerId && !k.name && k.entity) { const l = byEnt.get(G.normEnt(k.entity)) || []; if (l.length === 1) ownerId = l[0]; }
    let b = existing.get(k.key);
    if (!b) {
      [b] = await db.query(`INSERT INTO buyers (buyer_key, name, entity, phone, email, owner_id) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (buyer_key) DO UPDATE SET updated_at=buyers.updated_at RETURNING *`, [k.key, k.name, k.entity, c.purchaser_phone || null, c.purchaser_email || null, ownerId]);
      existing.set(k.key, b); created++;
    } else {
      const fill = { name: k.name, entity: k.entity, phone: c.purchaser_phone, email: c.purchaser_email, owner_id: ownerId };
      const set = Object.keys(fill).filter((x) => fill[x] && !b[x]);
      if (set.length) { [b] = await db.query(`UPDATE buyers SET ${set.map((x, i) => `${x}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [b.id, ...set.map((x) => fill[x])]); existing.set(k.key, b); }
    }
    if (c.buyer_id !== b.id) { await db.query('UPDATE sale_comps SET buyer_id=$2 WHERE id=$1', [c.id, b.id]); linked++; }
  }
  return { buyers: existing.size, created, linked, unlinked: unlinked.rowCount || 0 };
}

// ---------- lease years remaining ----------
const addMonths = (iso, m) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Number(m)); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const iso = (d) => (!d ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
function leaseExpiration(l) {
  if (!l) return null;
  if (l.expiration_date) return iso(l.expiration_date);
  const m = String(l.notes || '').match(/(?:expir\w*|lease end\w*|ends?)\D{0,20}(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (l.start_date && Number(l.term_months) > 0) return addMonths(iso(l.start_date), l.term_months);
  return null;
}
function yearsBetween(fromIso, toIso) { if (!fromIso || !toIso) return null; const y = (new Date(toIso + 'T12:00:00Z') - new Date(fromIso + 'T12:00:00Z')) / (365.25 * 864e5); return Math.max(0, Math.round(y * 10) / 10); }
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// All buyers with their purchases (newest first), lease info from the purchased property's latest lease comp.
async function loadBuyers(db, { id } = {}) {
  const buyers = await db.query(`SELECT b.*, o.name owner_name FROM buyers b LEFT JOIN owners o ON o.id=b.owner_id ${id ? 'WHERE b.id=$1' : ''}`, id ? [id] : []);
  if (!buyers.length) return [];
  const comps = await db.query(`SELECT c.*, p.address prop_address, CASE WHEN c.rba > 0 AND c.price > 0 THEN round(c.price / c.rba, 2) END ppsf,
      (SELECT string_agg(t.name, '; ' ORDER BY t.name) FROM property_tenants pt JOIN tenants t ON t.id=pt.tenant_id WHERE pt.property_id=c.property_id) prop_tenants,
      (SELECT array_agg(pt.tenant_id) FROM property_tenants pt WHERE pt.property_id=c.property_id) prop_tenant_ids
    FROM sale_comps c LEFT JOIN properties p ON p.id=c.property_id
    WHERE c.buyer_id IS NOT NULL AND c.cap_rate IS NOT NULL AND c.cap_rate > 0 ${id ? 'AND c.buyer_id=$1' : ''}`, id ? [id] : []);
  const leases = await db.query('SELECT * FROM lease_comps WHERE property_id IS NOT NULL ORDER BY start_date DESC NULLS LAST, id DESC');
  const leaseByProp = new Map(); for (const l of leases) if (!leaseByProp.has(l.property_id)) leaseByProp.set(l.property_id, l);
  const t = todayIso(); const byBuyer = new Map();
  for (const c of comps) {
    const l = c.property_id ? leaseByProp.get(c.property_id) : null; const exp = leaseExpiration(l);
    c.lease_id = l ? l.id : null; c.lease_type = l ? l.lease_type : null; c.lease_tenant = l ? l.tenant : null; c.lease_expiration = exp;
    c.years_remaining = exp ? yearsBetween(t, exp) : null; c.years_at_purchase = exp && c.sale_date ? yearsBetween(iso(c.sale_date), exp) : null;
    if (!byBuyer.has(c.buyer_id)) byBuyer.set(c.buyer_id, []); byBuyer.get(c.buyer_id).push(c);
  }
  for (const b of buyers) {
    b.purchases = (byBuyer.get(b.id) || []).sort((x, y) => String(y.sale_date || '').localeCompare(String(x.sale_date || '')) || y.id - x.id);
    b.last = b.purchases[0] || null; b.display = b.entity || b.name || '(unnamed buyer)'; b.sub = b.entity && b.name ? b.name : '';
  }
  const contacts = await db.query(`SELECT * FROM buyer_contacts ${id ? 'WHERE buyer_id=$1' : 'WHERE buyer_id IS NOT NULL'}`, id ? [id] : []);
  const cBy = new Map(); for (const c of contacts) { if (!cBy.has(c.buyer_id)) cBy.set(c.buyer_id, []); cBy.get(c.buyer_id).push(c); }
  for (const b of buyers) { b.contacts = (cBy.get(b.id) || []).sort((x, y) => confRank(y) - confRank(x) || Number(!!y.phone) - Number(!!x.phone)); b.best = b.contacts.find((c) => c.phone || c.email) || b.contacts[0] || null; }
  return id ? buyers : buyers.filter((b) => b.purchases.length);
}
const confRank = (c) => { const s = String(c.confidence || '').toLowerCase(); const n = parseFloat(s); if (Number.isFinite(n)) return n > 1 ? n / 100 : n; return /high|verified|confirmed/.test(s) ? 0.9 : /med/.test(s) ? 0.6 : /low/.test(s) ? 0.3 : 0.5; };

// ---------- companion buyer-contacts CSV ----------
const CONTACT_FIELDS = [
  ['buyer_entity', ['buyer entity', 'buyer', 'purchaser', 'purchaser entity', 'entity']], ['entity_state', ['entity state', 'state of formation', 'formation state']],
  ['entity_doc', ['entity doc #', 'entity doc', 'entity doc no', 'document number', 'doc #', 'entity number', 'sos id']], ['registered_agent', ['registered agent', 'agent']],
  ['officer_name', ['officer/manager name', 'officer manager name', 'officer name', 'manager name', 'officer', 'manager']], ['officer_title', ['officer title', 'title']],
  ['contact_name', ['buyer contact name', 'contact name', 'contact']], ['phone', ['phone', 'phone number', 'contact phone']], ['phone_type', ['phone type', 'type']],
  ['email', ['email', 'e-mail', 'contact email']], ['mailing_address', ['mailing address', 'address', 'mail address']], ['contact_source', ['contact source', 'source']],
  ['confidence', ['confidence', 'confidence level']], ['linked_comp_address', ['linked comp address', 'comp address', 'property address']],
  ['linked_sale_date', ['linked sale date', 'sale date']], ['notes', ['notes', 'note', 'comments']]];
const hnorm = (h) => String(h || '').toLowerCase().replace(/[_\s]+/g, ' ').replace(/[^a-z0-9 #/-]/g, '').trim();
function mapContactHeaders(headers) {
  const map = {}; const used = new Set();
  for (const [k, al] of CONTACT_FIELDS) { const i = headers.findIndex((h, j) => !used.has(j) && al.includes(hnorm(h))); if (i >= 0) { map[k] = i; used.add(i); } }
  return map;
}
// rows: array of arrays incl. header row. Idempotent on entity + person + phone + email. Fills only empty fields on re-import.
async function importBuyerContacts(db, rows, { dryRun = false, source = null } = {}) {
  const C = require('./comps-core');
  const headers = rows[0] || []; const map = mapContactHeaders(headers);
  if (map.buyer_entity === undefined) throw new Error('buyer contacts file needs a "Buyer Entity" column');
  const res = { rows: rows.length - 1, skipped: 0, inserted: 0, updated: 0, unchanged: 0, buyers_created: 0, comps_linked: 0, comps_filled: 0, unmatched_entities: [], columns: Object.keys(map) };
  if (!dryRun) await syncBuyers(db);
  const buyers = await db.query('SELECT id, buyer_key, entity FROM buyers'); const byEnt = new Map();
  for (const b of buyers) { if (b.entity) byEnt.set(entKey(b.entity), b); if (b.buyer_key.startsWith('e:')) byEnt.set(b.buyer_key.slice(2), b); }
  for (const r of rows.slice(1)) {
    const c = {}; for (const [k] of CONTACT_FIELDS) if (map[k] !== undefined) { const v = String(r[map[k]] ?? '').trim(); c[k] = v || null; }
    if (!c.buyer_entity || !entKey(c.buyer_entity)) { res.skipped++; continue; }
    if (c.linked_sale_date) c.linked_sale_date = C.P.date(c.linked_sale_date);
    if (c.entity_state) c.entity_state = C.P.state(c.entity_state) || c.entity_state;
    if (!c.contact_source && source) c.contact_source = source;
    // linked sale comp: same address (+ sale date when given)
    let comp = null;
    if (c.linked_comp_address) {
      // accept "123 Main St, Ste 1" or "123 Main St, Ste 1, City, ST 12345" (trailing city/state/zip is stripped and the state must match)
      const full = c.linked_comp_address; const m = full.match(/^(.*?),\s*([^,]+),\s*([A-Za-z]{2})\.?\s*(\d{5}(?:-\d{4})?)?\s*$/);
      const keys = [C.normAddr(full)]; if (m && m[1].trim()) keys.push(C.normAddr(m[1]));
      let cand = await db.query('SELECT id, state, sale_date, buyer_id, purchaser_entity, purchaser_name, purchaser_phone, purchaser_email FROM sale_comps WHERE norm_addr = ANY($1::text[])', [keys]);
      if (m) cand = cand.filter((x) => !x.state || x.state === m[3].toUpperCase());
      const dated = c.linked_sale_date ? cand.filter((x) => (x.sale_date instanceof Date ? x.sale_date.toISOString().slice(0, 10) : String(x.sale_date || '').slice(0, 10)) === c.linked_sale_date) : cand;
      comp = dated.length === 1 ? dated[0] : null;
    }
    let b = byEnt.get(entKey(c.buyer_entity));
    if (comp) {
      res.comps_linked++;
      const person = c.contact_name || c.officer_name;
      const fill = { purchaser_entity: c.buyer_entity, purchaser_name: person, purchaser_phone: c.phone, purchaser_email: c.email };
      const set = Object.keys(fill).filter((k) => fill[k] && !comp[k]);
      if (set.length) { res.comps_filled++; if (!dryRun) await db.query(`UPDATE sale_comps SET ${set.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [comp.id, ...set.map((k) => fill[k])]); }
    }
    if (!b && !dryRun && comp) { await syncBuyers(db); const [nb] = await db.query('SELECT b.id, b.buyer_key, b.entity FROM buyers b JOIN sale_comps s ON s.buyer_id=b.id WHERE s.id=$1', [comp.id]); if (nb) { b = nb; byEnt.set(entKey(c.buyer_entity), nb); } }
    if (!b) {
      if (res.unmatched_entities.length < 50 && !res.unmatched_entities.includes(c.buyer_entity)) res.unmatched_entities.push(c.buyer_entity);
      if (dryRun) { res.buyers_created++; b = { id: null }; byEnt.set(entKey(c.buyer_entity), b); }
      else { [b] = await db.query(`INSERT INTO buyers (buyer_key, entity) VALUES ($1,$2) ON CONFLICT (buyer_key) DO UPDATE SET updated_at=buyers.updated_at RETURNING id, buyer_key, entity`, ['e:' + entKey(c.buyer_entity), c.buyer_entity]); byEnt.set(entKey(c.buyer_entity), b); res.buyers_created++; }
    }
    const key = [entKey(c.buyer_entity), G.normName(c.contact_name || c.officer_name || '') || '', String(c.phone || '').replace(/\D/g, '').slice(-10), String(c.email || '').toLowerCase()].join('|');
    const [ex] = await db.query('SELECT * FROM buyer_contacts WHERE contact_key=$1', [key]);
    const row = { ...c, buyer_id: b.id, sale_comp_id: comp ? comp.id : null };
    if (!ex) { res.inserted++; if (!dryRun) { const cols = Object.keys(row); await db.query(`INSERT INTO buyer_contacts (contact_key, ${cols.join(',')}) VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(',')})`, [key, ...cols.map((k) => row[k])]); } }
    else { const set = Object.keys(row).filter((k) => row[k] !== null && row[k] !== undefined && (ex[k] === null || ex[k] === undefined || ex[k] === ''));
      if (set.length) { res.updated++; if (!dryRun) await db.query(`UPDATE buyer_contacts SET ${set.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [ex.id, ...set.map((k) => row[k])]); } else res.unchanged++; }
  }
  if (!dryRun && res.comps_filled) await syncBuyers(db);
  return res;
}

// ---------- likely buyers ----------
const NEIGHBORS = Object.fromEntries(('AL:FL,GA,MS,TN|AK:|AZ:CA,CO,NM,NV,UT|AR:LA,MO,MS,OK,TN,TX|CA:AZ,NV,OR|CO:AZ,KS,NE,NM,OK,UT,WY|CT:MA,NY,RI|DE:MD,NJ,PA|DC:MD,VA|FL:AL,GA|GA:AL,FL,NC,SC,TN|HI:|ID:MT,NV,OR,UT,WA,WY|IL:IA,IN,KY,MO,WI|IN:IL,KY,MI,OH|IA:IL,MN,MO,NE,SD,WI|KS:CO,MO,NE,OK|KY:IL,IN,MO,OH,TN,VA,WV|LA:AR,MS,TX|ME:NH|MD:DC,DE,PA,VA,WV|MA:CT,NH,NY,RI,VT|MI:IN,OH,WI|MN:IA,ND,SD,WI|MS:AL,AR,LA,TN|MO:AR,IA,IL,KS,KY,NE,OK,TN|MT:ID,ND,SD,WY|NE:CO,IA,KS,MO,SD,WY|NV:AZ,CA,ID,OR,UT|NH:MA,ME,VT|NJ:DE,NY,PA|NM:AZ,CO,OK,TX,UT|NY:CT,MA,NJ,PA,VT|NC:GA,SC,TN,VA|ND:MN,MT,SD|OH:IN,KY,MI,PA,WV|OK:AR,CO,KS,MO,NM,TX|OR:CA,ID,NV,WA|PA:DE,MD,NJ,NY,OH,WV|RI:CT,MA|SC:GA,NC|SD:IA,MN,MT,ND,NE,WY|TN:AL,AR,GA,KY,MO,MS,NC,VA|TX:AR,LA,NM,OK|UT:AZ,CO,ID,NM,NV,WY|VT:MA,NH,NY|VA:DC,KY,MD,NC,TN,WV|WA:ID,OR|WV:KY,MD,OH,PA,VA|WI:IA,IL,MI,MN|WY:CO,ID,MT,NE,SD,UT')
  .split('|').map((x) => { const [s, n] = x.split(':'); return [s, n ? n.split(',') : []]; }));
const money0 = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pctf = (n) => (Number(n) * 100).toFixed(2) + '%';
const MEDICAL_RE = /medical|clinic|physician|surgery|dental|health|hospital|doctor/i;

// Score one buyer against a listing. Points (max ~105): market 30, price 20, cap 15, lease 15, tenant 15, recency 5, medical 5.
function scoreBuyer(b, L, listingTenantIds, listingTenantNorm) {
  const reasons = []; const parts = {}; const P = b.purchases; const st = (L.state || '').toUpperCase(); const city = String(L.city || '').toLowerCase().trim();
  // 1. market
  let mk = 0;
  if (st) {
    const sameSt = P.filter((c) => (c.state || '').toUpperCase() === st);
    if (sameSt.length) { mk += 20; if (b.last && (b.last.state || '').toUpperCase() === st) mk += 5; reasons.push(`bought ${sameSt.length} propert${sameSt.length === 1 ? 'y' : 'ies'} in ${st}`); }
    else { const nb = P.filter((c) => (NEIGHBORS[st] || []).includes((c.state || '').toUpperCase())); if (nb.length) { mk += 8; reasons.push(`buys in a neighboring state (${[...new Set(nb.map((c) => c.state))].join(', ')})`); } }
    if (city && P.some((c) => String(c.city || '').toLowerCase().trim() === city)) { mk += 10; reasons.push(`has bought in ${L.city}`); }
  }
  parts.market = Math.min(30, mk);
  // 2. price band
  parts.price = 0;
  if (Number(L.asking_price) > 0) {
    const priced = P.filter((c) => Number(c.price) > 0); let best = null;
    for (const c of priced) { const r = Math.abs(Number(c.price) - Number(L.asking_price)) / Number(L.asking_price); if (best === null || r < best.r) best = { r, c }; }
    if (best && best.r <= 0.25) { parts.price = 20; reasons.push(`paid ${money0(best.c.price)} (${Math.round(best.r * 100)}% from the ask)`); }
    else if (best && best.r <= 0.5) { parts.price = 10; reasons.push(`paid ${money0(best.c.price)}, within 50% of the ask`); }
  }
  // 3. cap band
  parts.cap = 0;
  if (Number(L.cap_rate) > 0) {
    const capped = P.filter((c) => Number(c.cap_rate) > 0); let best = null;
    for (const c of capped) { const d = Math.abs(Number(c.cap_rate) - Number(L.cap_rate)); if (best === null || d < best.d) best = { d, c }; }
    if (best && best.d <= 0.005) { parts.cap = 15; reasons.push(`bought at a ${pctf(best.c.cap_rate)} cap`); }
    else if (best && best.d <= 0.01) { parts.cap = 8; reasons.push(`bought at a ${pctf(best.c.cap_rate)} cap (within 1 pt)`); }
  }
  // 4. lease years
  parts.lease = 0;
  if (L.years_remaining !== null && L.years_remaining !== undefined && L.years_remaining !== '') {
    const lp = P.filter((c) => c.years_at_purchase !== null); let best = null;
    for (const c of lp) { const d = Math.abs(c.years_at_purchase - Number(L.years_remaining)); if (best === null || d < best.d) best = { d, c }; }
    if (best && best.d <= 2) { parts.lease = 15; reasons.push(`bought with ~${best.c.years_at_purchase} yrs of lease left${best.c.lease_type ? ` (${best.c.lease_type})` : ''}`); }
    else if (best && best.d <= 5) { parts.lease = 8; reasons.push(`bought with ~${best.c.years_at_purchase} yrs of lease left`); }
  }
  // 5. tenant / system
  parts.tenant = 0;
  const hitIds = P.filter((c) => (c.prop_tenant_ids || []).some((x) => listingTenantIds.has(x)) || (c.tenant_id && listingTenantIds.has(c.tenant_id)));
  const hitName = listingTenantNorm ? P.filter((c) => [c.tenants, c.prop_tenants, c.lease_tenant].some((x) => x && nkey(x).includes(listingTenantNorm))) : [];
  if (hitIds.length || hitName.length) { parts.tenant = 15; reasons.push(`owns/bought a property leased to the same tenant group`); }
  // 6. recency + medical
  parts.recency = 0; const t = todayIso();
  if (b.last && b.last.sale_date && yearsBetween(iso(b.last.sale_date), t) <= 3) { parts.recency = 5; reasons.push(`last bought ${iso(b.last.sale_date)}`); }
  parts.medical = P.some((c) => MEDICAL_RE.test([c.land_use, c.tenants, c.prop_tenants, c.source].join(' ')) || c.lease_id) ? 5 : 0;
  if (parts.medical) reasons.push('has bought medical property');
  const score = Object.values(parts).reduce((a, x) => a + x, 0);
  return { score, parts, reasons };
}

async function likelyBuyers(db, L, { limit = 25 } = {}) {
  const buyers = await loadBuyers(db);
  const tids = new Set(); if (L.tenant_id) tids.add(L.tenant_id);
  if (L.property_id) for (const r of await db.query('SELECT tenant_id FROM property_tenants WHERE property_id=$1', [L.property_id])) tids.add(r.tenant_id);
  // ignore the catch-all spreadsheet tab group so it doesn't match everyone
  for (const r of await db.query("SELECT id FROM tenants WHERE name IN ('General')")) tids.delete(r.id);
  const tnorm = nkey(L.tenant || '').slice(0, 40) || null;
  const out = [];
  for (const b of buyers) {
    if (L.property_id && b.purchases.every((c) => c.property_id === L.property_id)) continue; // only bought this very property
    const s = scoreBuyer(b, L, tids, tnorm && tnorm.length >= 5 ? tnorm : null);
    if (s.score <= 5) continue;
    out.push({ buyer: b, ...s });
  }
  out.sort((a, b) => b.score - a.score || String(b.buyer.last?.sale_date || '').localeCompare(String(a.buyer.last?.sale_date || '')));
  return { total_buyers: buyers.length, ranked: out.slice(0, limit) };
}

// Plain-English note grounded in the scored reasons.
function recommendation(L, ranked, totalBuyers) {
  if (!totalBuyers) return 'No buyers with purchase history are in the CRM yet. As sale comps with purchaser names and contacts are imported, this list will rank them for this listing.';
  if (!ranked.length) return `None of the ${totalBuyers} buyers in the CRM fit this listing on market, price, cap rate, lease term or tenant yet.`;
  const st = L.state ? ` in ${L.state}` : '';
  const local = ranked.filter((r) => r.parts.market >= 20).length; const priced = ranked.filter((r) => r.parts.price >= 10).length;
  const top = ranked.slice(0, 3).map((r) => `${r.buyer.display} (${r.reasons.slice(0, 2).join('; ')})`).join('; ');
  return `Of ${totalBuyers} buyers in the CRM, ${local} have bought${st} and ${priced} have paid within 50% of the ${L.asking_price ? money0(L.asking_price) : 'asking'} price. ` +
    `Start with ${top}. Scores weigh market (30), price (20), cap rate (15), lease years remaining (15), same tenant group (15), recent and medical purchases (10).`;
}

module.exports = { importBuyerContacts, mapContactHeaders, CONTACT_FIELDS, syncBuyers, loadBuyers, likelyBuyers, recommendation, leaseExpiration, yearsBetween, todayIso, buyerKeyOf, NEIGHBORS };
