// Call-ready area comps for one CRM property.
// Closed sales and leases in the same medical / professional office market.
// Distance is shown only when both the subject and the comp have coordinates.
// Otherwise the label is "Same city" or "Same state". Proximity is never guessed.
const C = require('./comps-core');

const RADIUS_MILES = 10;
const SHOW_LIMIT = 6;
const CREXI_NOI_SF_SOURCE = 'Crexi Inventory Export (medical office) 2026-11-06';
const OUT_OF_SCOPE = /\b(retail|industrial|warehouse|multifamily|multi-family|apartment|hotel|motel|self[-\s]?storage|restaurant|shopping center|residential|vacant land)\b/i;
const IN_SCOPE = /\b(medical|professional office|office|clinic|mob|healthcare|health care|physician|dental|outpatient|surgery)\b/i;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function coord(v, max) {
  const n = num(v);
  if (n === null || n < -max || n > max) return null;
  return n;
}
function latLng(row) {
  const lat = coord(row && row.lat, 90);
  const lng = coord(row && row.lng, 180);
  if (lat === null || lng === null) return null;
  // (0, 0) is an unset placeholder, not a location we will turn into a distance.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}
function haversineMiles(a, b) {
  const R = 3958.7613;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function iso(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function samePlace(a, b) {
  return C.normCity(a) === C.normCity(b) && String(a || '').length > 0;
}
function proximity(subject, comp) {
  const s = latLng(subject);
  const c = latLng(comp);
  if (s && c) {
    const miles = haversineMiles(s, c);
    const label = (miles < 0.1 ? '<0.1' : miles.toFixed(1)) + ' mi';
    return { kind: 'distance', miles, label };
  }
  const st = subject.state && comp.state && String(subject.state).toUpperCase() === String(comp.state).toUpperCase();
  const city = st && subject.city && comp.city && samePlace(subject.city, comp.city);
  if (city) return { kind: 'city', miles: null, label: 'Same city' };
  if (st) return { kind: 'state', miles: null, label: 'Same state — fallback, not nearby' };
  return { kind: 'unknown', miles: null, label: 'Proximity unknown' };
}
function inMarket(subject, comp) {
  const p = proximity(subject, comp);
  if (p.kind === 'distance') {
    const city = subject.state && comp.state && String(subject.state).toUpperCase() === String(comp.state).toUpperCase()
      && subject.city && comp.city && samePlace(subject.city, comp.city);
    if (p.miles <= RADIUS_MILES || city) return p;
    return null;
  }
  if (p.kind === 'city') return p;
  // Same-state-only is the fallback when the subject has no city to match, and no distance can be computed.
  if (p.kind === 'state' && !subject.city) return p;
  return null;
}
function inOfficeScope(row) {
  const use = String(row.land_use || '').trim();
  if (!use) {
    const blob = [row.notes, row.tenants, row.tenant].filter(Boolean).join(' ');
    if (blob && OUT_OF_SCOPE.test(blob) && !IN_SCOPE.test(blob)) return false;
    return true;
  }
  if (OUT_OF_SCOPE.test(use) && !IN_SCOPE.test(use)) return false;
  return IN_SCOPE.test(use) || /\boffice\b/i.test(use);
}
function isSubject(subject, comp) {
  if (subject.id && comp.property_id && Number(subject.id) === Number(comp.property_id)) return true;
  const a = C.normAddr(subject.address);
  const b = C.normAddr(comp.address);
  if (!a || a !== b) return false;
  const stOk = !subject.state || !comp.state || String(subject.state).toUpperCase() === String(comp.state).toUpperCase();
  const cityOk = !subject.city || !comp.city || samePlace(subject.city, comp.city);
  return stOk && cityOk;
}
function leaseRentBasis(comp) {
  const source = String(comp && comp.source || '').trim();
  const value = num(comp && comp.rent_psf);
  if (source === CREXI_NOI_SF_SOURCE) {
    return value === null ? { basis: 'unknown', value: null, sourceBatch: true } : { basis: 'noi_psf', value, sourceBatch: true };
  }
  if (value === null) return { basis: 'unknown', value: null, sourceBatch: false };
  return { basis: 'actual', value, sourceBatch: false };
}
function salePosture(comp) {
  if (comp && (comp.record_kind === 'listing' || comp._kind === 'listing')) return 'asking';
  const blob = `${comp && comp.source || ''} ${comp && comp.notes || ''} ${comp && comp.status || ''}`;
  const saysAsking = /\basking\b|\bfor sale\b|\blisting\b/i.test(blob);
  if (!iso(comp && comp.sale_date) && saysAsking) return 'asking';
  return 'closed';
}
function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function scoreSale(c) {
  let s = 0;
  if (c.verified) s += 10;
  if (num(c.price) > 0) s += 3;
  if (num(c.rba) > 0) s += 2;
  if (num(c.cap_rate) > 0) s += 2;
  if (iso(c.sale_date)) s += 2;
  if (c.source) s += 1;
  s += Math.min(Number(c.id) || 0, 1e6) / 1e9;
  return s;
}
function scoreLease(c) {
  const rent = leaseRentBasis(c);
  let s = 0;
  if (rent.basis === 'actual') s += 20;
  if (c.verified) s += 10;
  if (c.tenant) s += 2;
  if (num(c.term_months) > 0) s += 2;
  if (c.lease_type) s += 1;
  if (iso(c.start_date)) s += 1;
  if (c.source) s += 1;
  s += Math.min(Number(c.id) || 0, 1e6) / 1e9;
  return s;
}
function groupKeep(items, keyFn, scoreFn, conflictFn) {
  const groups = new Map();
  let hidden = 0;
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const kept = [];
  for (const list of groups.values()) {
    if (conflictFn && list.length > 1 && conflictFn(list)) {
      kept.push(...list);
      continue;
    }
    list.sort((a, b) => scoreFn(b) - scoreFn(a));
    kept.push(list[0]);
    hidden += list.length - 1;
  }
  return { kept, hidden };
}
function saleKey(c) {
  const price = num(c.price);
  return [C.normAddr(c.address), String(c.state || '').toUpperCase(), iso(c.sale_date) || 'nodate', price === null ? 'noprice' : String(Math.round(price))].join('|');
}
function leaseGroupKey(c) {
  return [C.normAddr(c.address), String(c.state || '').toUpperCase(), String(c.tenant || '').toLowerCase().trim(), iso(c.start_date) || 'nodate', num(c.sf_leased) === null ? '' : String(Math.round(num(c.sf_leased)))].join('|');
}
function leasesConflict(list) {
  const actuals = list.map(leaseRentBasis).filter((r) => r.basis === 'actual').map((r) => r.value);
  if (actuals.length <= 1) return false;
  const lo = Math.min(...actuals); const hi = Math.max(...actuals);
  return hi > 0 && (hi - lo) / hi > 0.01;
}
function textOrNull(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

function buildAreaComps(subject, sales, leases, listings) {
  const subjectRow = subject || {};
  const hasMarket = Boolean(textOrNull(subjectRow.city) || textOrNull(subjectRow.state) || latLng(subjectRow));
  const base = {
    shown: hasMarket,
    city: textOrNull(subjectRow.city),
    state: textOrNull(subjectRow.state) ? String(subjectRow.state).toUpperCase() : null,
    radiusMiles: RADIUS_MILES,
    subjectHasCoords: Boolean(latLng(subjectRow)),
    closed: [],
    leases: [],
    asking: [],
    hiddenSaleDupes: 0,
    hiddenLeaseDupes: 0,
    noiSuppressed: 0,
    emptyReason: hasMarket ? null : 'City, state, and coordinates are unknown, so area comps are not shown.',
  };
  if (!hasMarket) return summarize(base);

  const prep = (rows, kind) => (rows || []).filter((row) => row && inOfficeScope(row) && !isSubject(subjectRow, row)).map((row) => {
    const prox = inMarket(subjectRow, row);
    return prox ? { ...row, _kind: kind, _prox: prox } : null;
  }).filter(Boolean);

  let saleRows = prep(sales, 'sale');
  const closed = []; const askingFromSales = [];
  for (const row of saleRows) (salePosture(row) === 'asking' ? askingFromSales : closed).push(row);
  const saleDedup = groupKeep(closed, saleKey, scoreSale);
  const leasePrep = prep(leases, 'lease');
  const leaseDedup = dedupeLeases(leasePrep);
  const askingListings = prep(listings, 'listing').filter((row) => {
    const st = String(row.status || 'Active');
    return st === 'Active' || st === 'Under contract';
  });

  const byRecent = (dateField) => (a, b) => {
    const da = a._prox.kind === 'distance' ? a._prox.miles : (a._prox.kind === 'city' ? 1000 : 2000);
    const db = b._prox.kind === 'distance' ? b._prox.miles : (b._prox.kind === 'city' ? 1000 : 2000);
    if (da !== db) return da - db;
    const ta = iso(a[dateField]) || '';
    const tb = iso(b[dateField]) || '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  };
  saleDedup.kept.sort(byRecent('sale_date'));
  leaseDedup.kept.sort(byRecent('start_date'));
  const asking = [...askingFromSales, ...askingListings].sort(byRecent('sale_date'));

  base.closed = saleDedup.kept;
  base.leases = leaseDedup.kept;
  base.asking = asking;
  base.hiddenSaleDupes = saleDedup.hidden;
  base.hiddenLeaseDupes = leaseDedup.hidden;
  base.noiSuppressed = leasePrep.filter((c) => leaseRentBasis(c).basis === 'noi_psf').length;
  return summarize(base);
}
function dedupeLeases(list) {
  const groups = new Map();
  for (const item of list) {
    const key = leaseGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const kept = [];
  let hidden = 0;
  for (const group of groups.values()) {
    const actuals = group.filter((c) => leaseRentBasis(c).basis === 'actual');
    let pool = group;
    if (actuals.length) {
      hidden += group.length - actuals.length;
      pool = actuals;
    }
    if (leasesConflict(pool)) { kept.push(...pool); continue; }
    pool.sort((a, b) => scoreLease(b) - scoreLease(a));
    kept.push(pool[0]);
    hidden += pool.length - 1;
  }
  return { kept, hidden };
}

function summarize(base) {
  const shownSales = base.closed.slice(0, SHOW_LIMIT);
  const shownLeases = base.leases.slice(0, SHOW_LIMIT);
  const shownAsking = base.asking.slice(0, SHOW_LIMIT);
  const ppsf = base.closed.map((c) => (num(c.price) > 0 && num(c.rba) > 0 ? num(c.price) / num(c.rba) : null)).filter((n) => n !== null);
  const caps = base.closed.map((c) => (num(c.cap_rate) > 0 ? num(c.cap_rate) : null)).filter((n) => n !== null);
  const actualRents = base.leases.map(leaseRentBasis).filter((r) => r.basis === 'actual').map((r) => r.value);
  const q = (city, state) => {
    const u = new URLSearchParams();
    if (city) u.set('city', city);
    if (state) u.set('state', state);
    const s = u.toString();
    return s ? '?' + s : '';
  };
  const query = q(base.city, base.state);
  return {
    ...base,
    showLimit: SHOW_LIMIT,
    shownSales,
    shownLeases,
    shownAsking,
    medianPpsf: median(ppsf),
    salesWithPpsf: ppsf.length,
    medianCap: median(caps),
    salesWithCap: caps.length,
    missingCap: base.closed.filter((c) => !(num(c.cap_rate) > 0)).length,
    missingPrice: base.closed.filter((c) => !(num(c.price) > 0)).length,
    medianActualRent: median(actualRents),
    leasesWithActualRent: actualRents.length,
    salesHref: '/comps/sales' + query,
    leasesHref: '/comps/leases' + query,
  };
}

function renderAreaComps(model) {
  const { esc, fmtDate, money, numf, pct } = require('./views');
  const money2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const unk = '<span class="unknown">Unknown</span>';
  const orUnk = (v) => (v ? esc(v) : unk);
  const dateCell = (d) => (iso(d) ? esc(fmtDate(d)) : unk);
  const proxCell = (p) => `<span class="prox ${p.kind === 'distance' ? 'prox-mi' : 'prox-fallback'}">${esc(p.label)}</span>`;
  const verified = (v) => `<span class="badge ${v ? 's-interested' : 's-attempted'}">${v ? 'Verified' : 'Unverified'}</span>`;
  const sourceLine = (c) => `${verified(Boolean(c.verified))} <span class="muted">${c.source ? esc(c.source) : unk}</span>`;
  const place = [model.city, model.state].filter(Boolean).join(', ') || 'this market';
  const how = !model.city && model.state
    ? `City is unknown. These rows are a same-state fallback for ${model.state}, not a nearby or distance match.`
    : model.subjectHasCoords
      ? `A mile figure is shown only when both this property and the comp have coordinates. Comps in other cities are included only within ${model.radiusMiles} miles. Same-city comps without coordinates are labeled Same city, not a guessed distance.`
      : 'This property has no coordinates, so no mileage is shown. Rows are the same city only. The rest of the state is not treated as nearby.';

  if (!model.shown) {
    return `<section id="area-comps" class="area-comps"><h2>Area comps</h2><p class="muted">${esc(model.emptyReason)}</p></section>`;
  }

  const ppsfTxt = model.medianPpsf === null ? 'Median sale $/SF unknown (no closed sale has both a sold price and building SF).' : `Median sale $${numf(model.medianPpsf, model.medianPpsf >= 100 ? 0 : 2)}/SF across ${model.salesWithPpsf} closed sale${model.salesWithPpsf === 1 ? '' : 's'} with price and SF.`;
  const capTxt = model.medianCap === null ? 'Median cap unknown.' : `Median cap ${pct(model.medianCap)} (${model.salesWithCap} with a cap).`;
  const miss = [];
  if (model.missingCap) miss.push(`${model.missingCap} missing a cap`);
  if (model.missingPrice) miss.push(`${model.missingPrice} missing a sold price`);
  const rentTxt = model.medianActualRent === null
    ? 'Median actual rent unknown.'
    : `Median actual rent $${money2(model.medianActualRent)}/SF across ${model.leasesWithActualRent} lease${model.leasesWithActualRent === 1 ? '' : 's'}.`;
  const noiNote = model.noiSuppressed ? ` ${model.noiSuppressed} Crexi NOI/SF figure${model.noiSuppressed === 1 ? '' : 's'} excluded from actual rent.` : '';

  const saleRows = model.shownSales.map((c) => {
    const price = num(c.price);
    const rba = num(c.rba);
    const ppsf = price > 0 && rba > 0 ? price / rba : null;
    const href = `/comps/sales/${c.id}`;
    return `<tr>
      <td class="addr"><a href="${href}"><b>${esc(c.address || 'Address unknown')}</b></a><div class="small">${sourceLine(c)}</div></td>
      <td class="num">${price > 0 ? esc(money(price)) : unk}</td>
      <td>${dateCell(c.sale_date)}</td>
      <td class="num">${rba > 0 ? esc(numf(rba) + ' SF') : unk}</td>
      <td class="num">${ppsf ? '$' + esc(numf(ppsf, ppsf >= 100 ? 0 : 2)) : unk}</td>
      <td class="num">${num(c.cap_rate) > 0 ? esc(pct(c.cap_rate)) : unk}</td>
      <td>${proxCell(c._prox)}</td>
    </tr>`;
  }).join('');
  const leaseRows = model.shownLeases.map((c) => {
    const rent = leaseRentBasis(c);
    const rentHtml = rent.basis === 'actual' ? `<span class="actual">Actual $${esc(money2(rent.value))}/SF</span>`
      : rent.basis === 'noi_psf' ? `<span class="noi" title="This source stored NOI per SF in rent_psf. It is not actual rent. The record is unchanged.">NOI/SF $${esc(money2(rent.value))}</span>`
      : unk;
    const term = num(c.term_months) > 0 ? esc(numf(c.term_months, num(c.term_months) % 1 ? 1 : 0) + ' mo') : unk;
    const href = `/comps/leases/${c.id}`;
    return `<tr>
      <td class="addr"><a href="${href}"><b>${esc(c.address || 'Address unknown')}</b></a><div class="small">${sourceLine(c)}</div></td>
      <td class="num">${rentHtml}</td>
      <td>${textOrNull(c.tenant) ? esc(c.tenant) : unk}</td>
      <td>${term}</td>
      <td>${textOrNull(c.lease_type) ? esc(c.lease_type) : unk}</td>
      <td>${proxCell(c._prox)}</td>
    </tr>`;
  }).join('');
  const askRows = model.shownAsking.map((c) => {
    const price = num(c.asking_price != null ? c.asking_price : c.price);
    const href = c._kind === 'listing' ? `/listings/${c.id}` : `/comps/sales/${c.id}`;
    const kind = c._kind === 'listing' ? `Listing${c.status ? ' · ' + c.status : ''}` : 'Sale record marked asking';
    return `<li><a href="${href}"><b>${esc(c.address || 'Address unknown')}</b></a> · <span class="badge s-talked">Asking</span> not closed · ${price > 0 ? esc(money(price)) : unk} · ${proxCell(c._prox)} · <span class="muted small">${esc(kind)}${c.source ? ' · ' + esc(c.source) : ''}</span></li>`;
  }).join('');

  const moreSales = model.closed.length > model.shownSales.length ? ` Showing ${model.shownSales.length} of ${model.closed.length}.` : '';
  const moreLeases = model.leases.length > model.shownLeases.length ? ` Showing ${model.shownLeases.length} of ${model.leases.length}.` : '';
  const dupe = [];
  if (model.hiddenSaleDupes) dupe.push(`${model.hiddenSaleDupes} duplicate closed sale${model.hiddenSaleDupes === 1 ? '' : 's'} hidden`);
  if (model.hiddenLeaseDupes) dupe.push(`${model.hiddenLeaseDupes} duplicate lease${model.hiddenLeaseDupes === 1 ? '' : 's'} hidden`);

  return `<section id="area-comps" class="area-comps">
    <h2>Area comps <span class="muted small">for this call</span></h2>
    <p class="muted small">${esc(place)}. ${esc(how)} Medical and professional office only. This property's own comps are left out. ${esc(dupe.join('. '))}${dupe.length ? '.' : ''}</p>
    <div class="area-grid">
      <div>
        <h3>Closed sales <span class="muted small">${model.closed.length} in area</span></h3>
        <p class="call-line">${esc(ppsfTxt)} ${esc(capTxt)}${miss.length ? ' ' + esc(miss.join('; ')) + '.' : ''}${esc(moreSales)}</p>
        ${saleRows ? `<div class="tblwrap"><table class="tbl comps area"><thead><tr><th>Address</th><th class="num">Sold</th><th>Date</th><th class="num">Bldg SF</th><th class="num">Sale $/SF</th><th class="num">Cap</th><th>Where</th></tr></thead><tbody>${saleRows}</tbody></table></div>` : '<p class="muted">No closed area sales.</p>'}
        <p class="small"><a href="${esc(model.salesHref)}">Full sale comps list${model.city ? ' for ' + esc(model.city) + (model.state ? ', ' + esc(model.state) : '') : ''}</a></p>
      </div>
      <div>
        <h3>Leases <span class="muted small">${model.leases.length} in area</span></h3>
        <p class="call-line">${esc(rentTxt)}${esc(noiNote)}${esc(moreLeases)}</p>
        ${leaseRows ? `<div class="tblwrap"><table class="tbl comps area"><thead><tr><th>Address</th><th class="num">Rent</th><th>Tenant</th><th>Term</th><th>Type</th><th>Where</th></tr></thead><tbody>${leaseRows}</tbody></table></div>` : '<p class="muted">No area leases.</p>'}
        <p class="small"><a href="${esc(model.leasesHref)}">Full lease comps list${model.city ? ' for ' + esc(model.city) + (model.state ? ', ' + esc(model.state) : '') : ''}</a></p>
      </div>
    </div>
    ${askRows ? `<h3>Asking, not closed</h3><ul class="acts plain area-ask">${askRows}</ul>` : '<p class="small muted">No asking prices in this area set.</p>'}
  </section>`;
}

module.exports = {
  RADIUS_MILES, SHOW_LIMIT, CREXI_NOI_SF_SOURCE,
  latLng, proximity, inMarket, inOfficeScope, isSubject, leaseRentBasis, salePosture,
  buildAreaComps, renderAreaComps,
};
