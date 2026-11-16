// Weekly Crexi feed: preview, then insert unverified sale and lease comps plus OM PDFs.
// Never creates properties or owners. A second upload of the same rows adds nothing.
const { parse } = require('csv-parse/sync');
const C = require('./comps-core');

const SOLD_FIELDS = ['address', 'city', 'state', 'zip', 'sale_price', 'sale_date', 'building_sf', 'price_psf', 'cap_rate', 'noi', 'tenant', 'lease_type', 'lease_term', 'lease_expiration', 'year_built', 'buyer', 'seller', 'listing_broker', 'crexi_url', 'om_filename'];
const LISTING_FIELDS = SOLD_FIELDS.concat(['asking_price', 'asking_rent_psf', 'for_sale', 'listing_type', 'listed_at']);

function headerKey(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return [];
  const rows = parse(raw, { columns: (headers) => headers.map(headerKey), skip_empty_lines: true, relax_column_count: true, trim: true });
  return rows;
}
function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function capRate(v) {
  const n = num(v);
  if (n == null) return null;
  return Math.abs(n) > 1 ? n / 100 : n;
}
function isoDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const month = String(m[1]).padStart(2, '0');
  const day = String(m[2]).padStart(2, '0');
  const iso = `${year}-${month}-${day}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}
function termMonths(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/year|\byr\b/.test(s)) return Math.round(n * 12);
  if (/month|\bmo\b/.test(s)) return Math.round(n);
  return n <= 40 ? Math.round(n * 12) : Math.round(n);
}
function forSaleFlag(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (['y', 'yes', 'true', '1', 'for sale'].includes(s)) return true;
  if (['n', 'no', 'false', '0'].includes(s)) return false;
  return null;
}
function fileKey(name) {
  return String(name || '').trim().toLowerCase().split(/[/\\]/).pop();
}
function sourceLabel(week) {
  return 'Crexi weekly ' + (isoDate(week) || new Date().toISOString().slice(0, 10));
}
function saleRecord(row, source) {
  const tenant = row.tenant || null;
  return {
    address: row.address,
    city: row.city || null,
    state: row.state ? String(row.state).trim().toUpperCase() : null,
    zip: row.zip || null,
    sale_date: isoDate(row.sale_date),
    price: num(row.sale_price != null && row.sale_price !== '' ? row.sale_price : row.price),
    rba: num(row.building_sf),
    cap_rate: capRate(row.cap_rate),
    noi: num(row.noi),
    tenant: tenant || null,
    tenants: tenant || null,
    lease_type: row.lease_type || null,
    lease_expiration: isoDate(row.lease_expiration),
    year_built: row.year_built || null,
    buyer: row.buyer || null,
    seller: row.seller || null,
    listing_broker: row.listing_broker || null,
    listing_url: row.crexi_url || row.listing_url || null,
    source,
    verified: false,
    norm_addr: C.normAddr(row.address),
  };
}
function listingRecord(row, source) {
  const tenant = row.tenant || null;
  const notes = row.listing_type ? 'Listing type: ' + row.listing_type : null;
  return {
    address: row.address,
    city: row.city || null,
    state: row.state ? String(row.state).trim().toUpperCase() : null,
    zip: row.zip || null,
    tenant: tenant || null,
    sf_leased: num(row.building_sf),
    rent_psf: num(row.asking_rent_psf != null && row.asking_rent_psf !== '' ? row.asking_rent_psf : row.rent_psf),
    lease_type: row.lease_type || null,
    term_months: termMonths(row.lease_term),
    expiration_date: isoDate(row.lease_expiration),
    asking_price: num(row.asking_price != null && row.asking_price !== '' ? row.asking_price : row.sale_price),
    for_sale: forSaleFlag(row.for_sale),
    listing_url: row.crexi_url || row.listing_url || null,
    listing_source: source,
    listed_at: isoDate(row.listed_at),
    year_built: row.year_built || null,
    notes,
    source,
    verified: false,
    norm_addr: C.normAddr(row.address),
  };
}
function classifySold(row) {
  if (!String(row.address || '').trim()) return { action: 'skip', reason: 'address is blank' };
  const rec = saleRecord(row, '');
  if (!rec.sale_date) return { action: 'skip', reason: 'sale date is missing or not a date' };
  if (!rec.norm_addr) return { action: 'skip', reason: 'address could not be normalized' };
  return { action: 'insert', record: rec };
}
function classifyListing(row) {
  if (!String(row.address || '').trim()) return { action: 'skip', reason: 'address is blank' };
  const rec = listingRecord(row, '');
  if (!rec.listing_url) return { action: 'skip', reason: 'listing URL is required to dedupe' };
  if (!rec.norm_addr) return { action: 'skip', reason: 'address could not be normalized' };
  return { action: 'insert', record: rec };
}
async function planCrexi(db, { soldRows, listingRows, files, week }) {
  const source = sourceLabel(week);
  const props = await C.propertyIndex(db);
  const fileMap = new Map();
  for (const file of files || []) {
    const key = fileKey(file.filename);
    if (key) fileMap.set(key, file);
  }
  const usedFiles = new Set();
  const sales = [];
  const listings = [];
  for (const row of soldRows || []) {
    const line = sales.length + 2;
    const found = classifySold(row);
    if (found.action === 'skip') { sales.push({ line, action: 'skip', reason: found.reason, address: row.address || '' }); continue; }
    const rec = { ...found.record, source };
    const [existing] = await db.query('SELECT id FROM sale_comps WHERE norm_addr=$1 AND sale_date IS NOT DISTINCT FROM $2::date LIMIT 1', [rec.norm_addr, rec.sale_date]);
    const om = fileKey(row.om_filename);
    if (existing) {
      sales.push({ line, action: 'skip', reason: 'already on file for this address and sale date', address: rec.address, compId: existing.id, om });
      continue;
    }
    const match = props.match(rec.address, rec.city, rec.state);
    if (match) rec.property_id = match.id;
    if (om) usedFiles.add(om);
    sales.push({ line, action: 'insert', address: rec.address, propertyId: rec.property_id || null, om, record: rec });
  }
  for (const row of listingRows || []) {
    const line = listings.length + 2;
    const found = classifyListing(row);
    if (found.action === 'skip') { listings.push({ line, action: 'skip', reason: found.reason, address: row.address || '' }); continue; }
    const rec = { ...found.record, source, listing_source: source };
    const [existing] = await db.query('SELECT id FROM lease_comps WHERE norm_addr=$1 AND listing_url IS NOT DISTINCT FROM $2 LIMIT 1', [rec.norm_addr, rec.listing_url]);
    const om = fileKey(row.om_filename);
    if (existing) {
      listings.push({ line, action: 'skip', reason: 'already on file for this address and listing URL', address: rec.address, compId: existing.id, om });
      continue;
    }
    const match = props.match(rec.address, rec.city, rec.state);
    if (match) rec.property_id = match.id;
    if (om) usedFiles.add(om);
    listings.push({ line, action: 'insert', address: rec.address, propertyId: rec.property_id || null, om, forSale: rec.for_sale, record: rec });
  }
  const documents = [];
  for (const [key, file] of fileMap) {
    const sale = sales.find((row) => row.om === key && row.action === 'insert');
    const listing = listings.find((row) => row.om === key && row.action === 'insert');
    if (sale || listing) documents.push({ filename: file.filename, action: 'link', address: (sale || listing).address, kind: sale ? 'sale' : 'lease' });
    else documents.push({ filename: file.filename, action: 'unmatched', reason: 'no imported row has this om_filename' });
  }
  for (const row of sales.concat(listings)) {
    if (row.action === 'insert' && row.om && !fileMap.has(row.om)) documents.push({ filename: row.om, action: 'missing', reason: 'om_filename was not in the upload', address: row.address });
  }
  return { source, sales, listings, documents, files: fileMap };
}
async function applyCrexi(db, plan) {
  const inserted = { sales: 0, listings: 0, documents: 0, skipped: 0 };
  await db.tx(async (t) => {
    for (const row of plan.sales) {
      if (row.action !== 'insert') { inserted.skipped++; continue; }
      const rec = row.record;
      const sourceKey = 'crexi-weekly:sale:' + rec.norm_addr + '|' + rec.sale_date;
      const [made] = await t.query(`INSERT INTO sale_comps
        (property_id, address, city, state, zip, sale_date, price, rba, cap_rate, noi, tenant, tenants, lease_type, lease_expiration, year_built, buyer, seller, listing_broker, listing_url, source, source_key, verified, norm_addr)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,false,$22)
        ON CONFLICT (source_key) DO NOTHING RETURNING id`,
        [rec.property_id || null, rec.address, rec.city, rec.state, rec.zip, rec.sale_date, rec.price, rec.rba, rec.cap_rate, rec.noi, rec.tenant, rec.tenants, rec.lease_type, rec.lease_expiration, rec.year_built, rec.buyer, rec.seller, rec.listing_broker, rec.listing_url, rec.source, sourceKey, rec.norm_addr]);
      if (!made) { inserted.skipped++; row.action = 'skip'; row.reason = 'already imported'; continue; }
      inserted.sales++;
      row.compId = made.id;
    }
    for (const row of plan.listings) {
      if (row.action !== 'insert') { inserted.skipped++; continue; }
      const rec = row.record;
      const sourceKey = 'crexi-weekly:lease:' + rec.norm_addr + '|' + String(rec.listing_url || '').toLowerCase();
      const [made] = await t.query(`INSERT INTO lease_comps
        (property_id, address, city, state, zip, tenant, sf_leased, rent_psf, lease_type, term_months, expiration_date, asking_price, for_sale, listing_url, listing_source, listed_at, source, source_key, verified, norm_addr, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false,$19,$20)
        ON CONFLICT (source_key) DO NOTHING RETURNING id`,
        [rec.property_id || null, rec.address, rec.city, rec.state, rec.zip, rec.tenant, rec.sf_leased, rec.rent_psf, rec.lease_type, rec.term_months, rec.expiration_date, rec.asking_price, rec.for_sale, rec.listing_url, rec.listing_source, rec.listed_at, rec.source, sourceKey, rec.norm_addr, rec.notes]);
      if (!made) { inserted.skipped++; row.action = 'skip'; row.reason = 'already imported'; continue; }
      inserted.listings++;
      row.compId = made.id;
    }
    const fileMap = plan.files || new Map();
    for (const row of plan.sales.concat(plan.listings)) {
      if (!row.compId || !row.om) continue;
      const file = fileMap.get(row.om);
      if (!file) continue;
      const saleId = plan.sales.includes(row) ? row.compId : null;
      const leaseId = saleId ? null : row.compId;
      const propertyId = row.record && row.record.property_id ? row.record.property_id : null;
      const buf = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);
      const [doc] = await t.query(`INSERT INTO property_documents
        (property_id, sale_comp_id, lease_comp_id, kind, filename, content_type, bytes, size, source_url)
        VALUES ($1,$2,$3,'om',$4,$5,$6,$7,$8)
        ON CONFLICT DO NOTHING RETURNING id`,
        [propertyId, saleId, leaseId, file.filename, file.mimetype || 'application/pdf', buf, buf.length, (row.record && row.record.listing_url) || null]);
      if (doc) inserted.documents++;
    }
  });
  return inserted;
}
function forSaleBadge(comp, money) {
  if (!comp || comp.for_sale !== true) return '';
  const price = comp.asking_price != null && comp.asking_price !== '' ? money(comp.asking_price) : '';
  return `<span class="badge for-sale">For sale${price ? ' · ' + price : ''}</span>`;
}
module.exports = {
  SOLD_FIELDS, LISTING_FIELDS, parseCsv, planCrexi, applyCrexi, forSaleBadge, sourceLabel, isoDate, capRate, forSaleFlag,
};
