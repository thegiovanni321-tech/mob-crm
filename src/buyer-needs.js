// Buyer needs: optional criteria matched against properties already in the CRM.
// A missing field is unknown. A value outside the request is not met. Nothing is estimated.
const Geo = require('./geo/reference');
const Follow = require('./followups');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buyer_needs (
  id SERIAL PRIMARY KEY,
  buyer_id INT REFERENCES buyers(id) ON DELETE SET NULL,
  buyer_name TEXT,
  company TEXT,
  phone TEXT,
  email TEXT,
  states TEXT,
  places TEXT,
  center_city TEXT,
  center_state TEXT,
  center_zip TEXT,
  radius_miles NUMERIC,
  price_min NUMERIC,
  price_max NUMERIC,
  cap_min NUMERIC,
  cap_max NUMERIC,
  sf_min NUMERIC,
  sf_max NUMERIC,
  min_years NUMERIC,
  tenant_keywords TEXT,
  tenancy TEXT,
  year_built_min INT,
  sellers_only BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buyer_needs_buyer ON buyer_needs(buyer_id);
`;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function capFraction(v) {
  const n = num(v);
  if (n == null) return null;
  return Math.abs(n) > 1 ? n / 100 : n;
}
function yearOf(v) {
  const m = String(v || '').match(/\d{4}/);
  if (!m) return null;
  const y = Number(m[0]);
  return y >= 1800 && y <= 2100 ? y : null;
}
function splitList(v) {
  return String(v || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}
function truthy(v) {
  return v === true || v === '1' || v === 'on' || v === 'true';
}
function blank(v) {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}
function fromForm(body) {
  const b = body || {};
  const tenancy = String(b.tenancy || '').toLowerCase();
  return {
    buyer_id: num(b.buyer_id) > 0 ? Math.round(num(b.buyer_id)) : null,
    buyer_name: blank(b.buyer_name),
    company: blank(b.company),
    phone: blank(b.phone),
    email: blank(b.email),
    states: blank(b.states),
    places: blank(b.places),
    center_city: blank(b.center_city),
    center_state: blank(b.center_state) ? String(b.center_state).trim().toUpperCase().slice(0, 2) : null,
    center_zip: blank(b.center_zip),
    radius_miles: num(b.radius_miles),
    price_min: num(b.price_min),
    price_max: num(b.price_max),
    cap_min: num(b.cap_min),
    cap_max: num(b.cap_max),
    sf_min: num(b.sf_min),
    sf_max: num(b.sf_max),
    min_years: num(b.min_years),
    tenant_keywords: blank(b.tenant_keywords),
    tenancy: tenancy === 'single' || tenancy === 'multi' ? tenancy : null,
    year_built_min: yearOf(b.year_built_min),
    sellers_only: truthy(b.sellers_only),
    notes: blank(b.notes),
    active: b.active == null ? true : truthy(b.active),
  };
}
function summary(need) {
  const bits = [];
  if (need.states) bits.push(need.states);
  if (need.places) bits.push(need.places);
  if (num(need.radius_miles)) bits.push(num(need.radius_miles) + ' mi');
  if (need.price_min != null || need.price_max != null) bits.push('price');
  if (need.cap_min != null || need.cap_max != null) bits.push('cap');
  if (need.sf_min != null || need.sf_max != null) bits.push('SF');
  if (need.min_years != null) bits.push(need.min_years + '+ yrs');
  if (need.tenant_keywords) bits.push(need.tenant_keywords);
  if (need.tenancy) bits.push(need.tenancy === 'single' ? 'single tenant' : 'multi tenant');
  if (need.year_built_min) bits.push('built ' + need.year_built_min + '+');
  if (need.sellers_only) bits.push('sellers only');
  return bits.join(' · ') || 'No criteria yet';
}
function displayName(need) {
  return need.buyer_name || need.company || 'Unnamed buyer';
}
function centerPoint(need) {
  const zip = Geo.zipPoint(need.center_zip);
  if (zip) return { lat: zip.lat, lng: zip.lng, approx: true, label: 'ZIP center' };
  const place = Geo.placePoint(need.center_city, need.center_state);
  if (place) return { lat: place.lat, lng: place.lng, approx: true, label: 'city center' };
  return null;
}
function propertyPoint(property) {
  const lat = num(property.lat);
  const lng = num(property.lng);
  if (lat != null && lng != null) return { lat, lng, approx: false, label: 'property coordinates' };
  const place = Geo.placePoint(property.city, property.state);
  if (place) return { lat: place.lat, lng: place.lng, approx: true, label: 'Census city center' };
  const zip = Geo.zipPoint(property.zip);
  if (zip) return { lat: zip.lat, lng: zip.lng, approx: true, label: 'Census ZIP center' };
  return null;
}
function inRange(value, min, max) {
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}
function evaluateProperty(need, property) {
  const reasons = [];
  const states = splitList(need.states).map((s) => s.toUpperCase());
  if (states.length) {
    const st = String(property.state || '').trim().toUpperCase();
    if (!st) reasons.push({ label: 'State', status: 'unknown', detail: 'No state on the property.' });
    else if (states.includes(st)) reasons.push({ label: 'State', status: 'met', detail: st });
    else reasons.push({ label: 'State', status: 'not met', detail: st + ' is not in ' + states.join(', ') + '.' });
  }
  const places = splitList(need.places);
  if (places.length) {
    const city = String(property.city || '').trim().toLowerCase();
    const notes = String(property.notes || '').toLowerCase();
    const hit = places.find((p) => (city && city === p.toLowerCase()) || (notes && notes.includes(p.toLowerCase())));
    if (hit) reasons.push({ label: 'City or county', status: 'met', detail: hit + '. Counties are not a stored field; this matched the city or the notes.' });
    else if (!city && !String(property.notes || '').trim()) reasons.push({ label: 'City or county', status: 'unknown', detail: 'No city or notes. Counties are not a stored field.' });
    else reasons.push({ label: 'City or county', status: 'not met', detail: 'The city and notes do not mention that place. Counties are not a stored field.' });
  }
  const radius = num(need.radius_miles);
  if (radius && (blank(need.center_zip) || (blank(need.center_city) && blank(need.center_state)))) {
    const center = centerPoint(need);
    const point = propertyPoint(property);
    if (!center || !point) {
      reasons.push({ label: 'Distance', status: 'unknown', detail: !center ? 'The center is not in the Census place or ZIP file.' : 'No property coordinates and no Census city or ZIP center.' });
    } else {
      const miles = Geo.haversineMiles(center.lat, center.lng, point.lat, point.lng);
      const via = [center.approx ? center.label : '', point.approx ? point.label : point.label].filter(Boolean).join(', ');
      const detail = miles.toFixed(1) + ' miles' + (via ? ' (' + via + ')' : '') + '.';
      reasons.push({ label: 'Distance', status: miles <= radius ? 'met' : 'not met', detail });
    }
  }
  if (num(need.price_min) != null || num(need.price_max) != null) {
    let price = num(property.price);
    let kind = 'Recorded sale price';
    if (price == null && num(property.asking_price) != null) {
      price = num(property.asking_price);
      kind = 'Asking price on a linked listing, not a recorded sale';
    }
    if (price == null) reasons.push({ label: 'Price', status: 'unknown', detail: 'No recorded sale price and no linked listing asking price. Nothing was estimated.' });
    else reasons.push({ label: 'Price', status: inRange(price, num(need.price_min), num(need.price_max)) ? 'met' : 'not met', detail: kind + ' ' + price + '.' });
  }
  if (num(need.cap_min) != null || num(need.cap_max) != null) {
    let cap = capFraction(property.cap_rate);
    let kind = 'Recorded sale cap rate';
    if (cap == null && capFraction(property.listing_cap) != null) {
      cap = capFraction(property.listing_cap);
      kind = 'Cap rate on a linked listing, not a recorded sale';
    }
    if (cap == null) reasons.push({ label: 'Cap rate', status: 'unknown', detail: 'No recorded sale cap rate and no linked listing cap rate. Nothing was estimated.' });
    else reasons.push({ label: 'Cap rate', status: inRange(cap, capFraction(need.cap_min), capFraction(need.cap_max)) ? 'met' : 'not met', detail: kind + ' ' + (cap * 100).toFixed(2) + '%.' });
  }
  if (num(need.sf_min) != null || num(need.sf_max) != null) {
    let sf = num(property.rba);
    let kind = 'Building SF';
    if (sf == null && num(property.listing_sf) != null) {
      sf = num(property.listing_sf);
      kind = 'Listing SF';
    }
    if (sf == null) reasons.push({ label: 'Building SF', status: 'unknown', detail: 'No building SF on the property or a linked listing.' });
    else reasons.push({ label: 'Building SF', status: inRange(sf, num(need.sf_min), num(need.sf_max)) ? 'met' : 'not met', detail: kind + ' ' + sf + '.' });
  }
  if (num(need.min_years) != null) {
    const years = num(property.years_remaining);
    if (years == null) reasons.push({ label: 'Lease years', status: 'unknown', detail: 'No lease years remaining on a linked listing or lease.' });
    else reasons.push({ label: 'Lease years', status: years >= num(need.min_years) ? 'met' : 'not met', detail: years.toFixed(1) + ' years remaining.' });
  }
  const words = splitList(need.tenant_keywords);
  if (words.length) {
    const hay = [property.tenants, property.tenancy, property.notes].filter(Boolean).join(' ').toLowerCase();
    if (!hay.trim()) reasons.push({ label: 'Tenant', status: 'unknown', detail: 'No tenant, tenancy, or notes to compare.' });
    else {
      const hit = words.filter((w) => hay.includes(w.toLowerCase()));
      reasons.push({ label: 'Tenant', status: hit.length ? 'met' : 'not met', detail: hit.length ? 'Matched ' + hit.join(', ') + '.' : 'None of the keywords are in the tenant, tenancy, or notes.' });
    }
  }
  if (need.tenancy === 'single' || need.tenancy === 'multi') {
    const text = String(property.tenancy || '').toLowerCase();
    if (!text.trim()) reasons.push({ label: 'Tenancy', status: 'unknown', detail: 'Tenancy is blank.' });
    else {
      const single = /\bsingle\b/.test(text);
      const multi = /\bmulti\b/.test(text);
      const ok = need.tenancy === 'single' ? single && !multi : multi;
      reasons.push({ label: 'Tenancy', status: ok ? 'met' : 'not met', detail: property.tenancy });
    }
  }
  if (yearOf(need.year_built_min)) {
    const y = yearOf(property.year_built);
    if (!y) reasons.push({ label: 'Year built', status: 'unknown', detail: 'Year built is blank or not a year.' });
    else reasons.push({ label: 'Year built', status: y >= yearOf(need.year_built_min) ? 'met' : 'not met', detail: String(y) });
  }
  if (need.sellers_only === true || need.sellers_only === 't' || truthy(need.sellers_only)) {
    const seller = !!(property.lead || (num(property.sellerScore) || 0) > 0);
    reasons.push({ label: 'Seller', status: seller ? 'met' : 'not met', detail: property.lead ? 'Marked as a lead.' : seller ? 'On Most likely to sell.' : 'Not a lead and not on Most likely to sell.' });
  }
  return reasons;
}
function matchProperties(need, properties, opts = {}) {
  const strict = !!opts.strict;
  const rows = [];
  for (const property of properties || []) {
    const reasons = evaluateProperty(need, property);
    if (reasons.some((r) => r.status === 'not met')) continue;
    if (strict && reasons.some((r) => r.status === 'unknown')) continue;
    const sellerScore = num(property.sellerScore) || 0;
    let score = reasons.filter((r) => r.status === 'met').length * 10;
    if (property.lead) score += 40;
    if (sellerScore >= 75) score += 30;
    else if (sellerScore >= 45) score += 15;
    rows.push({ ...property, reasons, score, sellerScore });
  }
  rows.sort((a, b) => b.score - a.score || b.sellerScore - a.sellerScore || Number(a.id) - Number(b.id));
  return rows;
}
function plusDays(d, n) {
  const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function yearsLeft(expiration, today) {
  if (!expiration) return null;
  const ms = new Date(expiration + 'T12:00:00Z') - new Date(today + 'T12:00:00Z');
  return ms / (365.25 * 864e5);
}
async function loadCandidates(db, today) {
  const props = await db.query(`SELECT p.id, p.address, p.city, p.state, p.zip, p.lat, p.lng, p.tenancy, p.rba, p.year_built,
    p.price, p.cap_rate, p.notes, p.lead_at, p.status, p.last_contacted
    FROM properties p`);
  const owners = await db.query(`SELECT po.property_id, o.id, o.name, o.entity, o.phone1, o.age, o.notes, o.mailing_address, o.birth_year, o.age_source, o.age_confidence
    FROM property_owners po JOIN owners o ON o.id = po.owner_id`);
  const tenants = await db.query(`SELECT pt.property_id, string_agg(t.name, ', ' ORDER BY t.name) AS names
    FROM property_tenants pt JOIN tenants t ON t.id = pt.tenant_id GROUP BY pt.property_id`);
  const listings = await db.query(`SELECT property_id, asking_price, cap_rate, sf, years_remaining, lease_expiration
    FROM listings WHERE property_id IS NOT NULL ORDER BY id DESC`);
  const leases = await db.query('SELECT property_id, expiration_date, start_date, term_months FROM lease_comps WHERE property_id IS NOT NULL');
  const acts = await db.query('SELECT id, property_id, owner_id, kind, outcome, notes, activity_date FROM activities');
  const ownersOf = new Map();
  for (const o of owners) {
    if (!ownersOf.has(o.property_id)) ownersOf.set(o.property_id, []);
    ownersOf.get(o.property_id).push(o);
  }
  const tenantOf = new Map(tenants.map((t) => [t.property_id, t.names]));
  const listingOf = new Map();
  for (const l of listings) if (!listingOf.has(l.property_id)) listingOf.set(l.property_id, l);
  const leaseExp = new Map();
  for (const l of leases) {
    let exp = l.expiration_date ? String(l.expiration_date).slice(0, 10) : '';
    if (!exp && l.start_date && l.term_months) exp = plusDays(l.start_date, Math.round(Number(l.term_months) * 30.4375));
    const prev = leaseExp.get(l.property_id);
    if (exp && (!prev || exp < prev)) leaseExp.set(l.property_id, exp);
  }
  const shaped = props.map((p) => {
    const listing = listingOf.get(p.id);
    const exp = (listing && listing.lease_expiration ? String(listing.lease_expiration).slice(0, 10) : '') || leaseExp.get(p.id) || '';
    let years = listing && num(listing.years_remaining) != null ? num(listing.years_remaining) : null;
    if (years == null && exp) years = yearsLeft(exp, today);
    return {
      ...p,
      lead: p.lead_at != null && String(p.lead_at).trim() !== '',
      owners: ownersOf.get(p.id) || [],
      tenants: tenantOf.get(p.id) || '',
      owner_names: (ownersOf.get(p.id) || []).map((o) => o.name).filter(Boolean).join(', '),
      phones: (ownersOf.get(p.id) || []).map((o) => o.phone1).filter(Boolean).join(', '),
      asking_price: listing ? listing.asking_price : null,
      listing_cap: listing ? listing.cap_rate : null,
      listing_sf: listing ? listing.sf : null,
      years_remaining: years,
    };
  });
  const follow = Follow.buildFollowUps({ today, properties: shaped, activities: acts });
  const scoreOf = new Map(follow.ranked.map((r) => [Number(r.propertyId), r]));
  const talkOf = new Map();
  for (const a of acts) {
    if (!Follow.isTalk(a) || !a.activity_date) continue;
    const day = String(a.activity_date).slice(0, 10);
    const prev = talkOf.get(a.property_id);
    if (!prev || day > prev) talkOf.set(a.property_id, day);
  }
  return shaped.map((p) => {
    const hit = scoreOf.get(Number(p.id));
    return { ...p, sellerScore: hit ? hit.score : 0, sellerTags: hit ? hit.tags : [], lastTalked: talkOf.get(p.id) || (p.last_contacted ? String(p.last_contacted).slice(0, 10) : '') };
  });
}
function applyFilters(rows, { state, q } = {}) {
  const st = String(state || '').trim().toUpperCase();
  const query = String(q || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (st && String(row.state || '').toUpperCase() !== st) return false;
    if (!query) return true;
    const hay = [row.address, row.city, row.owner_names, row.tenants, row.phones].join(' ').toLowerCase();
    return hay.includes(query);
  });
}
async function rankedMatches(db, need, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const candidates = await loadCandidates(db, today);
  return applyFilters(matchProperties(need, candidates, { strict: !!opts.strict }), opts);
}
module.exports = {
  SCHEMA, fromForm, summary, displayName, evaluateProperty, matchProperties, rankedMatches, capFraction,
};
