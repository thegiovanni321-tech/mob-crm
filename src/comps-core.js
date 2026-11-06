// Shared comps logic (no Express): schema, address normalization, property/tenant matching, idempotent inserts.
// Used by the web app (src/comps-routes.js) and by scripts (seed, CSV import, public-records feed).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sale_comps (
  id SERIAL PRIMARY KEY,
  property_id INT REFERENCES properties(id) ON DELETE SET NULL, tenant_id INT REFERENCES tenants(id) ON DELETE SET NULL,
  address TEXT, city TEXT, state TEXT, zip TEXT, sale_date DATE, price NUMERIC, rba NUMERIC, cap_rate NUMERIC,
  year_built TEXT, acres NUMERIC, buyer TEXT, seller TEXT, tenants TEXT, source TEXT, source_key TEXT UNIQUE,
  verified BOOLEAN NOT NULL DEFAULT false, notes TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS lease_comps (
  id SERIAL PRIMARY KEY,
  property_id INT REFERENCES properties(id) ON DELETE SET NULL, tenant_id INT REFERENCES tenants(id) ON DELETE SET NULL,
  address TEXT, city TEXT, state TEXT, zip TEXT, tenant TEXT, sf_leased NUMERIC, rent_psf NUMERIC, lease_type TEXT,
  term_months NUMERIC, start_date DATE, escalations TEXT, ti_psf NUMERIC, free_rent_months NUMERIC,
  source TEXT, source_key TEXT UNIQUE, verified BOOLEAN NOT NULL DEFAULT false, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS land_use TEXT;
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS norm_addr TEXT;
ALTER TABLE lease_comps ADD COLUMN IF NOT EXISTS norm_addr TEXT;
CREATE TABLE IF NOT EXISTS buyers (
  id SERIAL PRIMARY KEY, buyer_key TEXT NOT NULL UNIQUE, name TEXT, entity TEXT, phone TEXT, email TEXT,
  owner_id INT REFERENCES owners(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS purchaser_name TEXT;
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS purchaser_entity TEXT;
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS purchaser_phone TEXT;
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS purchaser_email TEXT;
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS purchaser_owner_id INT REFERENCES owners(id) ON DELETE SET NULL;
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS buyer_id INT REFERENCES buyers(id) ON DELETE SET NULL;
ALTER TABLE lease_comps ADD COLUMN IF NOT EXISTS expiration_date DATE;
CREATE INDEX IF NOT EXISTS idx_sc_buyer ON sale_comps(buyer_id);
CREATE TABLE IF NOT EXISTS buyer_contacts (
  id SERIAL PRIMARY KEY, contact_key TEXT NOT NULL UNIQUE, buyer_id INT REFERENCES buyers(id) ON DELETE CASCADE,
  buyer_entity TEXT, entity_state TEXT, entity_doc TEXT, registered_agent TEXT, officer_name TEXT, officer_title TEXT, contact_name TEXT,
  phone TEXT, phone_type TEXT, email TEXT, mailing_address TEXT, contact_source TEXT, confidence TEXT,
  linked_comp_address TEXT, linked_sale_date DATE, sale_comp_id INT REFERENCES sale_comps(id) ON DELETE SET NULL, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_bc_buyer ON buyer_contacts(buyer_id);
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY, property_id INT REFERENCES properties(id) ON DELETE SET NULL, tenant_id INT REFERENCES tenants(id) ON DELETE SET NULL,
  address TEXT NOT NULL, city TEXT, state TEXT, zip TEXT, tenant TEXT, asking_price NUMERIC, cap_rate NUMERIC, noi NUMERIC, sf NUMERIC,
  lease_type TEXT, lease_expiration DATE, years_remaining NUMERIC, status TEXT NOT NULL DEFAULT 'Active', notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_listings_prop ON listings(property_id);
CREATE INDEX IF NOT EXISTS idx_sc_prop ON sale_comps(property_id);
CREATE INDEX IF NOT EXISTS idx_sc_state_city ON sale_comps(state, city);
CREATE INDEX IF NOT EXISTS idx_sc_date ON sale_comps(sale_date);
CREATE INDEX IF NOT EXISTS idx_lc_prop ON lease_comps(property_id);
CREATE INDEX IF NOT EXISTS idx_lc_state_city ON lease_comps(state, city);
CREATE INDEX IF NOT EXISTS idx_lc_date ON lease_comps(start_date);
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS lat NUMERIC;
ALTER TABLE sale_comps ADD COLUMN IF NOT EXISTS lng NUMERIC;
ALTER TABLE lease_comps ADD COLUMN IF NOT EXISTS lat NUMERIC;
ALTER TABLE lease_comps ADD COLUMN IF NOT EXISTS lng NUMERIC;
`;
const LEASE_TYPES = ['NNN', 'Modified Gross', 'Full Service', 'Other'];

const SUFFIX = { street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', bl: 'blvd', blv: 'blvd', parkway: 'pkwy', pw: 'pkwy', pky: 'pkwy',
  lane: 'ln', court: 'ct', circle: 'cir', place: 'pl', highway: 'hwy', terrace: 'ter', trail: 'trl', square: 'sq', point: 'pt', pointe: 'pt', crossing: 'xing',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', expressway: 'expy', freeway: 'fwy', way: 'way', loop: 'lp', cove: 'cv', center: 'ctr', centre: 'ctr', plaza: 'plz', run: 'run', commons: 'cmns' };
// "1234 N Main Street, Suite 200" -> "1234nmainst" (drops suite/unit/building parts)
function normAddr(a) {
  let s = String(a || '').toLowerCase().split(/\s+(?:\+|&|and)\s+(?=\d)/)[0].replace(/[.,#]/g, ' '); // "1726 Metro Medical Dr + 1629 Owen Dr" -> first address
  s = s.replace(/\b(suite|ste|unit|apt|bldg|building|fl|floor|rm|room)\b\s*[\w-]*.*$/, ' ');
  return s.split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] || w).join('').replace(/[^a-z0-9]/g, '');
}
// Like normAddr but keeps the suite/unit: "2340 Hemby Lane, Unit B2" -> "2340hembylnunitb2"
function fullAddr(a) {
  const s = String(a || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\b(suite|ste)\b/g, 'ste').replace(/\b(units?|apt)\b/g, 'unit');
  return s.split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] || w).join('').replace(/[^a-z0-9]/g, '');
}
const normCity = (c) => String(c || '').toLowerCase().replace(/[^a-z]/g, '');

async function propertyIndex(db) {
  const rows = await db.query(`SELECT p.id, p.address, p.city, p.state,
    (SELECT min(pt.tenant_id) FROM property_tenants pt WHERE pt.property_id=p.id) tenant_id,
    (SELECT string_agg(t.name, '; ' ORDER BY t.name) FROM property_tenants pt JOIN tenants t ON t.id=pt.tenant_id WHERE pt.property_id=p.id) tenant_names
    FROM properties p`);
  const idx = new Map();
  const exact = new Map();
  for (const r of rows) {
    const k = normAddr(r.address) + '|' + (r.state || ''); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r);
    const e = fullAddr(r.address) + '|' + normCity(r.city) + '|' + (r.state || ''); if (!exact.has(e)) exact.set(e, r);
  }
  return { match(address, city, state) {
    // 1) same address incl. suite/unit (so "Ste 100" and "Unit B2" in one building stay separate), 2) same building in the same city.
    const e = exact.get(fullAddr(address) + '|' + normCity(city) + '|' + (state || '')); if (e) return e;
    const list = idx.get(normAddr(address) + '|' + (state || '')) || []; if (!list.length) return null;
    const sameCity = list.filter((r) => normCity(r.city) === normCity(city));
    if (sameCity.length) return sameCity.find((r) => fullAddr(r.address) === normAddr(r.address)) || sameCity[0];
    return list.length === 1 ? list[0] : null;
  } };
}
async function tenantIndex(db) {
  const rows = await db.query('SELECT id, name FROM tenants'); const m = new Map(rows.map((r) => [r.name.toLowerCase().trim(), r.id]));
  return { match: (name) => (name ? m.get(String(name).toLowerCase().trim()) || null : null) };
}

const SALE_COLS = ['property_id', 'tenant_id', 'address', 'city', 'state', 'zip', 'sale_date', 'price', 'rba', 'cap_rate', 'year_built', 'acres', 'buyer', 'seller', 'tenants', 'source', 'source_key', 'verified', 'notes', 'land_use', 'norm_addr', 'purchaser_name', 'purchaser_entity', 'purchaser_phone', 'purchaser_email', 'purchaser_owner_id', 'lat', 'lng'];
const LEASE_COLS = ['property_id', 'tenant_id', 'address', 'city', 'state', 'zip', 'tenant', 'sf_leased', 'rent_psf', 'lease_type', 'term_months', 'start_date', 'escalations', 'ti_psf', 'free_rent_months', 'source', 'source_key', 'verified', 'notes', 'norm_addr', 'expiration_date', 'lat', 'lng'];
// Insert comps idempotently. A comp whose source_key already exists is NOT duplicated: only its empty fields are filled.
// Returns { inserted, updated, matched } (matched = linked to an existing CRM property).
async function upsertComps(db, kind, comps, { autoMatch = true } = {}) {
  const cols = kind === 'lease' ? LEASE_COLS : SALE_COLS; const table = kind === 'lease' ? 'lease_comps' : 'sale_comps';
  const pidx = autoMatch ? await propertyIndex(db) : null; const tidx = await tenantIndex(db);
  const res = { inserted: 0, updated: 0, matched: 0, ids: [] };
  for (const c0 of comps) {
    const c = { ...c0, norm_addr: normAddr(c0.address) };
    if (pidx && !c.property_id && c.address) { const p = pidx.match(c.address, c.city, c.state); if (p) { c.property_id = p.id; if (!c.tenant_id) c.tenant_id = p.tenant_id; if (kind === 'sale' && !c.tenants) c.tenants = p.tenant_names; } }
    if (!c.tenant_id) c.tenant_id = tidx.match(kind === 'lease' ? c.tenant : (c.tenants || '').split(';')[0]);
    if (c.property_id) res.matched++;
    const vals = cols.map((k) => (c[k] === undefined || c[k] === '' ? (k === 'verified' ? false : null) : c[k]));
    const fill = cols.filter((k) => !['source_key', 'verified', 'source'].includes(k)).map((k) => `${k}=COALESCE(${table}.${k}, EXCLUDED.${k})`).join(', ');
    const [r] = await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})
      ON CONFLICT (source_key) DO UPDATE SET ${fill} RETURNING id, (xmax = 0) AS inserted`, vals);
    if (r.inserted) res.inserted++; else res.updated++; res.ids.push(r.id);
  }
  if (kind === 'sale' && comps.length) { try { res.buyers = await require('./buyers').syncBuyers(db); } catch (e) { console.error('[buyers] sync', e.message); } }
  return res;
}
// Build a stable de-dupe key from the parts that identify one transaction.
const keyOf = (...parts) => parts.map((p) => (p === null || p === undefined ? '' : String(p).toLowerCase().trim())).join('|');

module.exports = { fullAddr, SCHEMA, LEASE_TYPES, normAddr, normCity, propertyIndex, tenantIndex, upsertComps, keyOf, SALE_COLS, LEASE_COLS };

// ---------- field definitions (forms, CSV export, CSV import mapping) ----------
// t: text | num | money | date | pct | int | select | bool
const SALE_FIELDS = [
  { k: 'address', l: 'Address', t: 'text', req: true, al: ['address', 'property address', 'building address', 'site address', 'street'] },
  { k: 'city', l: 'City', t: 'text', al: ['city', 'property city'] }, { k: 'state', l: 'State', t: 'text', al: ['state', 'st'] }, { k: 'zip', l: 'Zip', t: 'text', al: ['zip', 'zip code', 'postal code'] },
  { k: 'sale_date', l: 'Sale date', t: 'date', al: ['sale date', 'date', 'close date', 'closing date', 'sold date', 'recording date'] },
  { k: 'price', l: 'Price', t: 'money', al: ['price', 'sale price', 'sales price', 'sold price', 'amount', 'consideration'] },
  { k: 'rba', l: 'RBA (sf)', t: 'num', al: ['rba', 'sf', 'building sf', 'bldg sf', 'size', 'square feet', 'gla', 'building size', 'building sf/rba', 'sf/rba', 'rba/sf', 'rba (sf)'] },
  { k: 'land_use', l: 'Land use', t: 'text', al: ['land use', 'property type', 'asset type', 'property use'] },
  { k: 'cap_rate', l: 'Cap rate', t: 'pct', al: ['cap rate', 'cap', 'capitalization rate'] },
  { k: 'year_built', l: 'Year built', t: 'text', al: ['year built', 'yr built', 'built'] },
  { k: 'acres', l: 'Acres', t: 'num', al: ['acres', 'land acres', 'lot acres', 'land area (ac)'] },
  { k: 'buyer', l: 'Buyer (as recorded)', t: 'text', al: ['buyer', 'grantee', 'true buyer'] },
  { k: 'purchaser_name', l: 'Purchaser contact name', t: 'text', al: ['purchaser name', 'purchaser contact', 'buyer name', 'buyer contact', 'buyer contact name', 'purchaser contact name'] },
  { k: 'purchaser_entity', l: 'Purchaser entity', t: 'text', al: ['purchaser', 'purchaser entity', 'buyer entity', 'purchasing entity', 'true buyer entity'] },
  { k: 'purchaser_phone', l: 'Purchaser phone', t: 'text', al: ['purchaser phone', 'buyer phone', 'buyer contact phone', 'purchaser contact phone'] },
  { k: 'purchaser_email', l: 'Purchaser email', t: 'text', al: ['purchaser email', 'buyer email', 'buyer contact email', 'purchaser contact email'] }, { k: 'seller', l: 'Seller', t: 'text', al: ['seller', 'grantor', 'true seller'] },
  { k: 'tenants', l: 'Tenant(s)', t: 'text', al: ['tenant', 'tenants', 'tenant name', 'occupant'] },
  { k: 'notes', l: 'Notes', t: 'text', al: ['notes', 'comments', 'remarks'] },
];
const LEASE_FIELDS = [
  { k: 'address', l: 'Address', t: 'text', req: true, al: ['address', 'property address', 'building address', 'street'] },
  { k: 'city', l: 'City', t: 'text', al: ['city'] }, { k: 'state', l: 'State', t: 'text', al: ['state', 'st'] }, { k: 'zip', l: 'Zip', t: 'text', al: ['zip', 'zip code'] },
  { k: 'tenant', l: 'Tenant', t: 'text', al: ['tenant', 'tenant name', 'lessee'] },
  { k: 'sf_leased', l: 'SF leased', t: 'num', al: ['sf', 'sf leased', 'square feet', 'size', 'leased sf', 'rsf'] },
  { k: 'rent_psf', l: 'Rent $/SF', t: 'money', al: ['rent', 'rent/sf', 'rent psf', 'rate', 'asking rent', 'starting rent', 'rent $/sf'] },
  { k: 'lease_type', l: 'Lease type', t: 'select', opts: LEASE_TYPES, al: ['lease type', 'type', 'expense structure', 'service type'] },
  { k: 'term_months', l: 'Term (months)', t: 'int', al: ['term', 'term (months)', 'term months', 'lease term'] },
  { k: 'start_date', l: 'Start date', t: 'date', al: ['start date', 'commencement', 'commencement date', 'lease date', 'sign date', 'date'] },
  { k: 'expiration_date', l: 'Lease expiration', t: 'date', al: ['expiration', 'expiration date', 'lease expiration', 'expires', 'end date', 'lease end'] },
  { k: 'escalations', l: 'Escalations', t: 'text', al: ['escalations', 'bumps', 'increases', 'escalation'] },
  { k: 'ti_psf', l: 'TI $/SF', t: 'money', al: ['ti', 'ti/sf', 'ti psf', 'tenant improvements'] },
  { k: 'free_rent_months', l: 'Free rent (months)', t: 'num', al: ['free rent', 'free rent months', 'abatement'] },
  { k: 'notes', l: 'Notes', t: 'text', al: ['notes', 'comments', 'remarks'] },
];
const STATE_RE = /^[A-Z]{2}$/;
const STATE_FULL = { ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC', 'PUERTO RICO': 'PR' };
const P = {
  text: (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; },
  num: (v) => { const s = String(v ?? '').replace(/[$,\s]|sf|ac|acres|\/sf|psf/gi, ''); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; },
  int: (v) => { const n = P.num(String(v ?? '').replace(/months?|mos?\.?/i, '')); return n === null ? null : Math.round(n); },
  pct: (v) => { const s = String(v ?? '').trim(); const n = P.num(s.replace('%', '')); if (n === null) return null; return s.includes('%') || n > 1 ? n / 100 : n; },
  date: (v) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v ?? '').trim(); if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    m = s.match(/^(\d{1,2})[/-](\d{4})$/); if (m) return `${m[2]}-${m[1].padStart(2, '0')}-01`;
    if (/^\d{5}$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 864e5); return d.toISOString().slice(0, 10); } // Excel serial
    return null;
  },
  state: (v) => { const s = String(v ?? '').trim().toUpperCase().replace(/\./g, ''); if (STATE_RE.test(s)) return s; return STATE_FULL[s] || null; },
  leaseType: (v) => { const s = String(v ?? '').toLowerCase(); if (!s.trim()) return null; if (/nnn|triple|net net|absolute/.test(s)) return 'NNN'; if (/mod|mg\b|modified/.test(s)) return 'Modified Gross'; if (/full|fs\b|gross/.test(s)) return 'Full Service'; return 'Other'; },
};
P.money = P.num; P.select = P.leaseType;
const fieldsFor = (kind) => (kind === 'lease' ? LEASE_FIELDS : SALE_FIELDS);
const parseField = (f, v) => (f.k === 'state' ? P.state(v) : P[f.t](v));
function guessMapping(kind, headers) {
  const norm = (h) => String(h || '').toLowerCase().replace(/[_\s]+/g, ' ').replace(/[^a-z0-9 $/()]/g, '').trim();
  const map = {}; const used = new Set();
  for (const f of fieldsFor(kind)) {
    const i = headers.findIndex((h, j) => !used.has(j) && (f.al.includes(norm(h)) || norm(h) === f.l.toLowerCase()));
    if (i >= 0) { map[f.k] = i; used.add(i); }
  }
  return map;
}
// rows: arrays of cell values; mapping: { fieldKey: columnIndex }. Returns { comps, skipped }.
function mapRows(kind, rows, mapping, source) {
  const comps = []; let skipped = 0;
  for (const r of rows) {
    const c = { source, verified: false };
    for (const f of fieldsFor(kind)) if (mapping[f.k] !== undefined && mapping[f.k] !== null && mapping[f.k] !== '') c[f.k] = parseField(f, r[Number(mapping[f.k])]);
    if (kind === 'sale' && !c.purchaser_entity && c.buyer) c.purchaser_entity = c.buyer; // a plain "Buyer" column is the purchaser entity
    if (!c.address) { skipped++; continue; }
    c.source_key = 'csv:' + (kind === 'lease' ? keyOf(source, normAddr(c.address), c.state, c.tenant, c.start_date, c.sf_leased) : keyOf(source, normAddr(c.address), c.state, c.sale_date, c.price));
    comps.push(c);
  }
  return { comps, skipped };
}
const CREXI_NOI_SF_SOURCE = 'Crexi Inventory Export (medical office) 2026-11-06';
function leaseRentBasis(comp) {
  return require('./area-comps').leaseRentBasis(comp);
}
module.exports.CREXI_NOI_SF_SOURCE = CREXI_NOI_SF_SOURCE;
module.exports.leaseRentBasis = leaseRentBasis;
module.exports.SALE_FIELDS = SALE_FIELDS; module.exports.LEASE_FIELDS = LEASE_FIELDS; module.exports.P = P;
module.exports.fieldsFor = fieldsFor; module.exports.parseField = parseField; module.exports.guessMapping = guessMapping; module.exports.mapRows = mapRows;
