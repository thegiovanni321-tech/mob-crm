// Free, public, no-login sources of recent commercial sale records, normalized into sale comps (marked unverified).
// Each source returns [{...sale comp fields, source, source_key}]; upsertComps() de-dupes on source_key.
const { parse } = require('csv-parse/sync');
const UA = 'Mozilla/5.0 (MOB-CRM comps feed; contact: owner of this CRM)';
const isoDay = (d) => d.toISOString().slice(0, 10);
const title = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Ltd|Inc|Pllc|Ii|Iii|Iv|Md|Tr|Ttee)\b/g, (w) => w.toUpperCase());
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

// ---------- Franklin County, OH (Columbus) - Auditor daily conveyances (official API behind audr-apps.franklincountyohio.gov/Conveyance) ----------
// Ohio land-use codes: 442 Medical clinics & offices; 447 Office 1-2 stories; 448 Office walk-up 3+; 449 Office elevator 3+; 450 Office condo; 470 Dwelling converted to office.
const FRANKLIN_MEDICAL = ['442']; const FRANKLIN_OFFICE = ['447', '448', '449', '450', '470'];
const FRANKLIN_CITIES = ['CANAL WINCHESTER', 'GRANDVIEW HEIGHTS', 'UPPER ARLINGTON', 'NEW ALBANY', 'GROVE CITY', 'LEWIS CENTER', 'PLAIN CITY', 'MINERVA PARK', 'MARBLE CLIFF',
  'COLUMBUS', 'DUBLIN', 'WESTERVILLE', 'HILLIARD', 'REYNOLDSBURG', 'GAHANNA', 'WORTHINGTON', 'GROVEPORT', 'BEXLEY', 'WHITEHALL', 'LOCKBOURNE', 'GALLOWAY', 'BLACKLICK',
  'PICKERINGTON', 'OBETZ', 'URBANCREST', 'HARRISBURG', 'ORIENT', 'POWELL', 'GRANDVIEW', 'VALLEYVIEW', 'BRICE', 'GALENA', 'SUNBURY', 'ASHVILLE', 'COMMERCIAL POINT'];
function splitOhAddress(s) {
  const m = String(s || '').trim().match(/^(.*)\s+OH\s+(\d{5})(-\d{4})?$/i); if (!m) return { address: s, city: null, zip: null };
  let rest = m[1].trim(); let city = null;
  for (const c of FRANKLIN_CITIES) if (rest.toUpperCase().endsWith(' ' + c)) { city = c; rest = rest.slice(0, -c.length).trim(); break; }
  return { address: title(rest).replace(/\b(N|S|E|W|Ne|Nw|Se|Sw)\b/g, (w) => w.toUpperCase()), city: city ? title(city) : null, zip: m[2] };
}
async function franklinOH({ days = 30, includeOffice = true, minPrice = 100000 } = {}) {
  // The county API accepts at most ~30 days per request, so longer look-backs are fetched in 30-day windows.
  const rows = []; const end = Date.now(); const start = end - days * 864e5;
  for (let a = start; a < end; a += 30 * 864e5) {
    const b = Math.min(end, a + 30 * 864e5);
    const url = `https://audr-apps.franklincountyohio.gov/conveyance/api/download/csv?minDate=${new Date(a).toISOString()}&maxDate=${new Date(b).toISOString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error(`Franklin County OH: HTTP ${r.status} for ${isoDay(new Date(a))}..${isoDay(new Date(b))}`);
    rows.push(...parse(await r.text(), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }));
  }
  const codes = new Set([...FRANKLIN_MEDICAL, ...(includeOffice ? FRANKLIN_OFFICE : [])]);
  const byConv = new Map();
  for (const x of rows) {
    if (!codes.has(String(x['Land Use']).trim())) continue;
    if (String(x['Is Exempt?']).toLowerCase() === 'true') continue; // exempt = no consideration / related-party transfer
    const amt = num(x.Amount); if (!amt || amt < minPrice) continue;
    const k = x['Convey #']; if (!byConv.has(k)) byConv.set(k, []); if (!byConv.get(k).some((y) => y['Parcel #'] === x['Parcel #'])) byConv.get(k).push(x);
  }
  const out = [];
  for (const [conv, list] of byConv) {
    const x = list.find((y) => /^\d/.test(y['Site Address'])) || list[0]; const a = splitOhAddress(x['Site Address']);
    const [mm, dd, yy] = String(x.Date).split('/');
    const lu = [...new Set(list.map((y) => `${y['Land Use']} ${y.LandUse}`.trim()))].join('; ');
    out.push({ ...a, state: 'OH', sale_date: `${yy}-${mm}-${dd}`, price: num(x.Amount), buyer: title(x.Owner), seller: title(x.PriorOwnerName1), land_use: lu,
      source: 'Franklin County OH Auditor (public conveyances)', source_key: `franklin-oh:${conv}`, verified: false,
      notes: [`Conveyance #${conv}, parcel ${list.map((y) => y['Parcel #']).join(', ')}`, x.InstrumentType, Number(x['Parcel Count']) > 1 ? `${x['Parcel Count']} parcels in this conveyance (price is for all of them)` : null,
        'Imported automatically - confirm SF, tenant, and cap rate before using in a proposal.'].filter(Boolean).join('\n') });
  }
  return out;
}

// ---------- Wake County, NC (Raleigh/Cary) - qualified sales, past 24 months, refreshed daily ----------
const WAKE_URL = 'https://services.wake.gov/realdata_extracts/Qualified_Sales_Past_24Months.xlsx';
const WAKE_MEDICAL = ['MED OFC GROSS']; const WAKE_OFFICE = ['OFC GROSS', 'HR OFFC'];
const WAKE_JUR = { RA: 'Raleigh', CA: 'Cary', AP: 'Apex', FV: 'Fuquay-Varina', HS: 'Holly Springs', GA: 'Garner', KN: 'Knightdale', MO: 'Morrisville', RO: 'Rolesville', WF: 'Wake Forest', WE: 'Wendell', ZB: 'Zebulon', WC: 'Wake County' };
async function wakeNC({ days = 30, includeOffice = true, minPrice = 100000 } = {}) {
  const ExcelJS = require('exceljs');
  const r = await fetch(WAKE_URL, { headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error(`Wake County NC: HTTP ${r.status}`);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0]; const hdr = ws.getRow(1).values.map((v) => String(v || '').trim());
  const uses = new Set([...WAKE_MEDICAL, ...(includeOffice ? WAKE_OFFICE : [])]); const since = isoDay(new Date(Date.now() - days * 864e5));
  const groups = new Map();
  ws.eachRow((row, i) => {
    if (i === 1) return; const o = {}; row.values.forEach((v, j) => { o[hdr[j]] = v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? null) : v; });
    if (!uses.has(String(o.BLDG_USE_DESC || '').trim())) return;
    const d = o.SALE_DATE instanceof Date ? isoDay(o.SALE_DATE) : null; if (!d || d < since) return;
    if (!(num(o.SALE_PRICE) >= minPrice)) return;
    const k = `${o.SALE_DEED_BOOK}-${o.SALE_DEED_PAGE}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o);
  });
  const out = [];
  for (const [deed, list] of groups) {
    const o = list[0];
    const address = [o.STREET_NUM, o.DIRECTIONAL_PREFIX, title(o.STREET_NAME), title(o.STREET_TYPE), o.DIRECTIONAL_SUFFIX, o.STREET_MISC ? 'Unit ' + o.STREET_MISC : ''].filter((x) => x !== null && x !== undefined && String(x).trim()).join(' ');
    const rba = list.reduce((a, y) => a + (num(y.TOTAL_HEATED_AREA_ATSALE) || 0), 0) || null;
    const acres = list.reduce((a, y) => a + (num(y.PARCEL_DEEDED_ACREAGE_ATSALE) || 0), 0) || null;
    out.push({ address, city: o.CORP_LIMIT_DESC ? title(o.CORP_LIMIT_DESC) : WAKE_JUR[o.PLANNING_JURISDICTION] || 'Wake County', state: 'NC', zip: o.ZIP ? String(o.ZIP).slice(0, 5) : null,
      sale_date: isoDay(o.SALE_DATE), price: num(o.SALE_PRICE), rba, acres: acres ? Math.round(acres * 100) / 100 : null, year_built: o.YEAR_BUILT ? String(o.YEAR_BUILT) : null,
      land_use: [...new Set(list.map((y) => y.BLDG_USE_DESC))].join('; '), source: 'Wake County NC Tax Administration (qualified sales)', source_key: `wake-nc:${deed}`, verified: false,
      notes: [`Deed book ${o.SALE_DEED_BOOK} page ${o.SALE_DEED_PAGE}; REID ${list.map((y) => y.REID).join(', ')}`, `Sale type: ${o.SALE_TYPE || ''}${list.length > 1 ? ` (${list.length} parcels)` : ''}`, `Zoning ${o.ZONING || ''}`,
        'Qualified (arms-length) per Wake County. Buyer/seller not in this file. Imported automatically - confirm before using in a proposal.'].join('\n') });
  }
  return out;
}

const SOURCES = { 'franklin-oh': franklinOH, 'wake-nc': wakeNC };
module.exports = { SOURCES, franklinOH, wakeNC, splitOhAddress };
