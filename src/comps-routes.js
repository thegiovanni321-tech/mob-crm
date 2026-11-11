// Comps section: sale + lease comps lists (filters, sorting, CSV export), add/edit/delete, quick "Log comp",
// generic CSV import with column mapping, and the public-records feed runner.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const multer = require('multer'); const { parse } = require('csv-parse/sync');
const { esc, layout, fmtDate, isoDate, money, numf, pct, qs, STATE_NAMES } = require('./views');
const C = require('./comps-core'); const Att = require('./attachments'); const { SOURCES } = require('./feeds');
const Area = require('./area-comps'); const geo = require('./geo/reference'); const paths = require('./paths');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const nz = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s === '' ? null : s; };
const vbadge = (v) => `<span class="badge ${v ? 's-interested' : 's-attempted'}">${v ? 'Verified' : 'Unverified'}</span>`;
const money2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function leaseRentText(c) {
  const b = C.leaseRentBasis(c);
  if (b.basis === 'actual') return '$' + money2(b.value) + '/SF actual';
  if (b.basis === 'noi_psf') return 'NOI/SF $' + money2(b.value) + ' (not actual rent)';
  return 'Unknown';
}
function leaseRentHtml(c) {
  const b = C.leaseRentBasis(c);
  if (b.basis === 'actual') return '$' + money2(b.value);
  if (b.basis === 'noi_psf') return `<span class="noi" title="This source stored NOI per SF in the rent field. Not actual rent. The stored value is unchanged.">NOI/SF $${money2(b.value)}</span>`;
  return '<span class="unknown">Unknown</span>';
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ_NAME || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const KIND = {
  sale: { table: 'sale_comps', base: '/comps/sales', label: 'Sale comps', one: 'sale comp', dateCol: 'sale_date', sizeCol: 'rba', fields: C.SALE_FIELDS,
    cols: [['sale_date', 'Date', (c) => fmtDate(c.sale_date)], ['address', 'Address', null], ['city', 'City', (c) => esc(c.city)], ['state', 'ST', (c) => esc(c.state)],
      ['price', 'Price', (c) => money(c.price), 1], ['cap_rate', 'Cap', (c) => pct(c.cap_rate), 1], ['rba', 'RBA', (c) => numf(c.rba), 1], ['ppsf', '$/SF', (c) => (c.ppsf ? '$' + numf(c.ppsf, 0) : ''), 1],
      ['buyer', 'Buyer', (c) => esc(c.buyer)], ['seller', 'Seller', (c) => esc(c.seller)], ['tenants', 'Tenant(s)', (c) => esc(c.tenants || c.tenant_name)], ['verified', 'Status', (c) => vbadge(c.verified)]],
    csv: ['id', 'address', 'city', 'state', 'zip', 'sale_date', 'price', 'rba', 'ppsf', 'cap_rate', 'year_built', 'acres', 'buyer', 'seller', 'tenants', 'tenant_group', 'land_use', 'source', 'status', 'property_id', 'notes'] },
  lease: { table: 'lease_comps', base: '/comps/leases', label: 'Lease comps', one: 'lease comp', dateCol: 'start_date', sizeCol: 'sf_leased', fields: C.LEASE_FIELDS,
    cols: [['start_date', 'Start', (c) => fmtDate(c.start_date)], ['address', 'Address', null], ['city', 'City', (c) => esc(c.city)], ['state', 'ST', (c) => esc(c.state)],
      ['tenant', 'Tenant', (c) => esc(c.tenant || c.tenant_name)], ['sf_leased', 'SF', (c) => numf(c.sf_leased), 1], ['rent_psf', 'Rent/SF', (c) => leaseRentHtml(c), 1],
      ['lease_type', 'Type', (c) => esc(c.lease_type)], ['term_months', 'Term (mo)', (c) => numf(c.term_months), 1], ['ti_psf', 'TI/SF', (c) => (c.ti_psf ? '$' + numf(c.ti_psf, 2) : ''), 1],
      ['free_rent_months', 'Free (mo)', (c) => numf(c.free_rent_months, 1), 1], ['verified', 'Status', (c) => vbadge(c.verified)]],
    csv: ['id', 'address', 'city', 'state', 'zip', 'tenant', 'tenant_group', 'sf_leased', 'rent_psf', 'lease_type', 'term_months', 'start_date', 'escalations', 'ti_psf', 'free_rent_months', 'source', 'status', 'property_id', 'notes', 'rent_basis'] },
};
const SELECT = (k) => `SELECT c.*${k === 'sale' ? ', CASE WHEN c.rba > 0 AND c.price > 0 THEN round(c.price / c.rba, 2) END AS ppsf' : ''}, t.name tenant_name, p.address prop_address
  FROM ${KIND[k].table} c LEFT JOIN tenants t ON t.id=c.tenant_id LEFT JOIN properties p ON p.id=c.property_id`;
const pickF = (q) => Object.fromEntries(['q', 'state', 'city', 'from', 'to', 'min', 'max', 'verified', 'tenant', 'property', 'source', 'cap', 'sort', 'dir'].map((k) => [k, nz(q[k]) || '']));
function where(k, f) {
  const K = KIND[k]; const w = []; const params = [];
  const add = (sql, v) => { params.push(v); w.push(sql.replace(/\?/g, '$' + params.length)); };
  if (f.state) add('c.state = ?', f.state.toUpperCase());
  if (f.city) add('lower(c.city) = lower(?)', f.city);
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) add(`c.${K.dateCol} >= ?::date`, f.from);
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) add(`c.${K.dateCol} <= ?::date`, f.to);
  if (f.min && Number.isFinite(+f.min)) add(`c.${K.sizeCol} >= ?::numeric`, +f.min);
  if (f.max && Number.isFinite(+f.max)) add(`c.${K.sizeCol} <= ?::numeric`, +f.max);
  if (f.verified === '1' || f.verified === '0') add('c.verified = ?::boolean', f.verified === '1');
  if (f.tenant) add('c.tenant_id = ?::int', parseInt(f.tenant) || 0);
  if (f.property) add('c.property_id = ?::int', parseInt(f.property) || 0);
  if (f.source) add('c.source = ?', f.source);
  if (k === 'sale' && f.cap === 'yes') w.push('(c.cap_rate IS NOT NULL AND c.cap_rate > 0)');
  if (k === 'sale' && f.cap === 'no') w.push('(c.cap_rate IS NULL OR c.cap_rate <= 0)');
  if (f.q) {
    params.push('%' + f.q + '%'); const i = '$' + params.length;
    w.push(k === 'sale' ? `(c.address ILIKE ${i} OR c.city ILIKE ${i} OR c.buyer ILIKE ${i} OR c.seller ILIKE ${i} OR c.tenants ILIKE ${i} OR c.notes ILIKE ${i} OR c.source ILIKE ${i} OR c.zip ILIKE ${i} OR t.name ILIKE ${i})`
      : `(c.address ILIKE ${i} OR c.city ILIKE ${i} OR c.tenant ILIKE ${i} OR c.notes ILIKE ${i} OR c.source ILIKE ${i} OR c.zip ILIKE ${i} OR c.escalations ILIKE ${i} OR t.name ILIKE ${i})`);
  }
  return { sql: w.length ? ' WHERE ' + w.join(' AND ') : '', params };
}
function orderBy(k, f) {
  const allowed = new Set(KIND[k].cols.map((c) => c[0]).concat(['zip', 'created_at']));
  const col = allowed.has(f.sort) ? f.sort : KIND[k].dateCol; const dir = f.dir === 'asc' ? 'ASC' : f.dir === 'desc' ? 'DESC' : col === KIND[k].dateCol ? 'DESC' : 'ASC';
  const expr = col === 'ppsf' ? 'ppsf' : col === 'tenants' ? 'COALESCE(c.tenants, t.name)' : col === 'tenant' ? 'COALESCE(c.tenant, t.name)' : 'c.' + col;
  return ` ORDER BY ${expr} ${dir} NULLS LAST, c.id DESC`;
}

module.exports = function mountComps(app, getDb, wrap) {
  const db = { query: (...a) => getDb().query(...a), tx: (...a) => getDb().tx(...a) };
  const tenantList = () => db.query('SELECT id, name FROM tenants ORDER BY name');
  const loadProp = async (id) => { if (!id) return null; const [p] = await db.query(`SELECT p.*, (SELECT min(pt.tenant_id) FROM property_tenants pt WHERE pt.property_id=p.id) tenant_id,
    (SELECT string_agg(t.name, '; ' ORDER BY t.name) FROM property_tenants pt JOIN tenants t ON t.id=pt.tenant_id WHERE pt.property_id=p.id) tenant_names FROM properties p WHERE p.id=$1`, [id]); return p || null; };

  const subnav = (k) => `<nav class="subtabs"><a href="/comps/sales" class="${k === 'sale' ? 'on' : ''}">Sale comps</a><a href="/comps/leases" class="${k === 'lease' ? 'on' : ''}">Lease comps</a>
    <a href="/comps/import" class="${k === 'import' ? 'on' : ''}">Import / feeds</a></nav>`;

  app.get('/comps', (req, res) => res.redirect('/comps/sales'));
  for (const k of ['sale', 'lease']) {
    const K = KIND[k];
    app.get(K.base, wrap(async (req, res) => {
      const f = pickF(req.query); const page = Math.max(1, parseInt(req.query.page) || 1); const per = 100;
      const w = where(k, f);
      const [agg] = await db.query(`SELECT count(*)::int n, ${k === 'sale' ? `round(avg(c.cap_rate) FILTER (WHERE c.cap_rate > 0), 4) avg_cap, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price / NULLIF(c.rba,0)) FILTER (WHERE c.rba > 0 AND c.price > 0)::numeric, 0) med_ppsf, round(avg(c.price) FILTER (WHERE c.price > 0), 0) avg_price`
        : `round(avg(c.rent_psf) FILTER (WHERE c.rent_psf > 0 AND btrim(c.source) IS DISTINCT FROM '${C.CREXI_NOI_SF_SOURCE.replace(/'/g, "''")}'), 2) avg_rent, round(avg(c.term_months) FILTER (WHERE c.term_months > 0), 0) avg_term, round(sum(c.sf_leased), 0) total_sf`}
        FROM ${K.table} c LEFT JOIN tenants t ON t.id=c.tenant_id${w.sql}`, w.params);
      const rows = await db.query(`${SELECT(k)}${w.sql}${orderBy(k, f)} LIMIT ${per} OFFSET ${(page - 1) * per}`, w.params);
      const states = await db.query(`SELECT state, count(*)::int n FROM ${K.table} WHERE state IS NOT NULL GROUP BY 1 ORDER BY 1`);
      const sources = await db.query(`SELECT source, count(*)::int n FROM ${K.table} WHERE source IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);
      const tenants = await db.query(`SELECT DISTINCT t.id, t.name FROM ${K.table} c JOIN tenants t ON t.id=c.tenant_id ORDER BY t.name`);
      const opt = (v, l, sel) => `<option value="${esc(v)}"${String(sel) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
      const sortLink = ([col, label, , num]) => { const on = (f.sort || K.dateCol) === col; const nd = on && (f.dir || (col === K.dateCol ? 'desc' : 'asc')) === 'asc' ? 'desc' : 'asc';
        const extra = col === 'cap_rate' ? ' sticky-cap' : (col === K.dateCol ? ' sticky-date' : (col === 'address' ? ' addr' : ''));
        return `<th class="${num ? 'num' : ''}${extra}"><a class="sortable${on ? ' on' : ''}" href="${K.base}${qs({ ...f, sort: col, dir: nd })}">${label}${on ? (nd === 'asc' ? ' ▼' : ' ▲') : ''}</a></th>`; };
      let capSplit = null;
      if (k === 'sale') {
        const [cs] = await db.query(`SELECT count(*) FILTER (WHERE c.cap_rate IS NOT NULL AND c.cap_rate > 0)::int with_cap,
          count(*) FILTER (WHERE c.cap_rate IS NULL OR c.cap_rate <= 0)::int no_cap FROM ${K.table} c LEFT JOIN tenants t ON t.id=c.tenant_id${w.sql}`, w.params);
        // When cap filter is on, recompute unfiltered split for the quick links
        if (f.cap) {
          const fAll = { ...f, cap: '' }; const wAll = where(k, fAll);
          const [cs2] = await db.query(`SELECT count(*) FILTER (WHERE c.cap_rate IS NOT NULL AND c.cap_rate > 0)::int with_cap,
            count(*) FILTER (WHERE c.cap_rate IS NULL OR c.cap_rate <= 0)::int no_cap FROM ${K.table} c LEFT JOIN tenants t ON t.id=c.tenant_id${wAll.sql}`, wAll.params);
          capSplit = cs2;
        } else capSplit = cs;
      }
      const stats = k === 'sale' ? [['Comps', agg.n], ['Avg price', money(agg.avg_price)], ['Median $/SF', agg.med_ppsf ? '$' + numf(agg.med_ppsf) : '—'], ['Avg cap rate', agg.avg_cap ? pct(agg.avg_cap) : '—']]
        : [['Comps', agg.n], ['Avg actual rent/SF', agg.avg_rent ? '$' + numf(agg.avg_rent, 2) : '—'], ['Avg term', agg.avg_term ? agg.avg_term + ' mo' : '—'], ['Total SF', numf(agg.total_sf) || '—']];
      const capLinks = k === 'sale' && capSplit ? `<p class="actions small">Cap rate: <a class="btn ghost small${f.cap === '' ? ' on' : ''}" href="${K.base}${qs({ ...f, cap: '' })}">All (${capSplit.with_cap + capSplit.no_cap})</a>
        <a class="btn ghost small${f.cap === 'yes' ? ' on' : ''}" href="${K.base}${qs({ ...f, cap: 'yes' })}">Has cap (${capSplit.with_cap})</a>
        <a class="btn ghost small${f.cap === 'no' ? ' on' : ''}" href="${K.base}${qs({ ...f, cap: 'no' })}">No cap (${capSplit.no_cap})</a></p>` : '';
      res.send(layout(K.label, `<h1>Comps</h1>${subnav(k)}
      <form class="filters" method="get" action="${K.base}">
        <input type="search" name="q" value="${esc(f.q)}" placeholder="Search address, ${k === 'sale' ? 'buyer, seller' : 'tenant'}, notes…">
        <select name="state"><option value="">All states</option>${states.map((s) => opt(s.state, `${s.state} (${s.n})`, f.state)).join('')}</select>
        <input name="city" value="${esc(f.city)}" placeholder="City" size="10">
        <label class="fl">${k === 'sale' ? 'Sold' : 'Started'} from <input type="date" name="from" value="${esc(f.from)}"></label><label class="fl">to <input type="date" name="to" value="${esc(f.to)}"></label>
        <input name="min" value="${esc(f.min)}" placeholder="Min SF" inputmode="numeric" size="7"><input name="max" value="${esc(f.max)}" placeholder="Max SF" inputmode="numeric" size="7">
        <select name="verified"><option value="">Verified + unverified</option>${opt('1', 'Verified only', f.verified)}${opt('0', 'Unverified only', f.verified)}</select>
        <select name="tenant"><option value="">All tenant groups</option>${tenants.map((t) => opt(t.id, t.name, f.tenant)).join('')}</select>
        <select name="source"><option value="">All sources</option>${sources.map((s) => opt(s.source, `${s.source} (${s.n})`, f.source)).join('')}</select>
        ${k === 'sale' ? `<select name="cap"><option value="">Cap: all</option>${opt('yes', 'Has cap rate', f.cap)}${opt('no', 'No cap rate', f.cap)}</select>` : ''}
        ${f.property ? `<input type="hidden" name="property" value="${esc(f.property)}">` : ''}<input type="hidden" name="sort" value="${esc(f.sort)}"><input type="hidden" name="dir" value="${esc(f.dir)}">
        <button>Filter</button> <a class="btn ghost" href="${K.base}">Reset</a></form>
      ${capLinks}
      <div class="cards stats">${stats.map(([l, v]) => `<div class="card"><b>${esc(v)}</b><span>${l}</span></div>`).join('')}</div>
      <p class="actions"><a class="btn small" href="${K.base}/new">+ Add ${K.one}</a> <a class="btn ghost small" href="${K.base}.csv${qs(f)}">Export ${agg.n} to CSV</a></p>
      ${rows.length ? `<div class="tblwrap"><table class="tbl comps"><thead><tr>${K.cols.map(sortLink).join('')}</tr></thead><tbody>
      ${rows.map((c) => `<tr>${K.cols.map(([col, , fn, num]) => col === 'address'
        ? `<td class="addr"><a href="${K.base}/${c.id}"><b>${esc(c.address || '(no address)')}</b></a>${c.property_id ? ` <a class="small" href="/properties/${c.property_id}" title="Linked CRM property">🏢</a>` : ''}</td>`
        : `<td class="${num ? 'num' : ''}${col === 'cap_rate' ? ' sticky-cap' : ''}${col === 'sale_date' || col === 'start_date' ? ' sticky-date' : ''}">${fn(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">No comps match.</p>'}
      ${pagerHtml(agg.n, page, per, K.base + qs(f))}`, { active: 'comps' }));
    }));
    app.get(K.base + '.csv', wrap(async (req, res) => {
      const f = pickF(req.query); const w = where(k, f);
      const rows = await db.query(`${SELECT(k)}${w.sql}${orderBy(k, f)}`, w.params);
      const cell = (v) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
      const val = (c, col) => (col === 'status' ? (c.verified ? 'verified' : 'unverified') : col === 'tenant_group' ? c.tenant_name : col === 'rent_basis' ? C.leaseRentBasis(c).basis : c[col]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${k}-comps-${today()}.csv"`);
      res.send('\ufeff' + [K.csv.join(','), ...rows.map((c) => K.csv.map((col) => cell(val(c, col))).join(','))].join('\r\n'));
    }));
    app.get(K.base + '/new', wrap(async (req, res) => {
      const p = await loadProp(parseInt(req.query.property_id) || 0);
      const c = p ? { property_id: p.id, tenant_id: p.tenant_id, address: p.address, city: p.city, state: p.state, zip: p.zip, ...(k === 'sale' ? { tenants: p.tenant_names, rba: p.rba, year_built: p.year_built, acres: p.acres } : { tenant: p.tenant_names }) } : { verified: k === 'sale' ? false : false };
      res.send(layout('New ' + K.one, `<p class="crumbs"><a href="${K.base}">${K.label}</a> ›</p><h1>New ${K.one}</h1>${compForm(k, c, K.base, await tenantList())}`, { active: 'comps' }));
    }));
    app.post(K.base, wrap(async (req, res) => {
      const c = fromBody(k, req.body); if (!c.address) return res.redirect(K.base + '/new');
      c.source = c.source || 'Entered in app'; c.source_key = 'app:' + crypto.randomUUID();
      const r = await C.upsertComps(getDb(), k, [c], { autoMatch: !c.property_id });
      res.redirect(nz(req.body.back) && /^\/properties\/\d+$/.test(req.body.back) ? req.body.back + '#comps' : `${K.base}/${r.ids[0]}`);
    }));
    app.get(K.base + '/:id', wrap(async (req, res) => {
      const [c] = await db.query(`${SELECT(k)} WHERE c.id=$1`, [parseInt(req.params.id) || 0]); if (!c) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
      const facts = (k === 'sale' ? [['Sale date', fmtDate(c.sale_date)], ['Price', money(c.price)], ['RBA', c.rba ? numf(c.rba) + ' sf' : ''], ['$/SF', c.ppsf ? '$' + numf(c.ppsf, 2) : ''], ['Cap rate', pct(c.cap_rate)],
        ['Year built', c.year_built], ['Acres', numf(c.acres, 2)], ['Buyer (as recorded)', c.buyer], ['Purchaser contact', c.purchaser_name], ['Purchaser entity', c.purchaser_entity], ['Purchaser phone', c.purchaser_phone], ['Purchaser email', c.purchaser_email], ['Seller', c.seller], ['Tenant(s)', c.tenants], ['Land use', c.land_use]]
        : [['Tenant', c.tenant], ['SF leased', numf(c.sf_leased)], ['Rent', leaseRentText(c)], ['Lease type', c.lease_type], ['Term', c.term_months ? c.term_months + ' months' : ''],
          ['Start date', fmtDate(c.start_date)], ['Lease expiration', fmtDate(c.expiration_date)], ['Escalations', c.escalations], ['TI $/SF', c.ti_psf ? '$' + numf(c.ti_psf, 2) : ''], ['Free rent', c.free_rent_months ? c.free_rent_months + ' months' : '']]).filter((x) => x[1]);
      const mapQ = encodeURIComponent([c.address, c.city, c.state, c.zip].filter(Boolean).join(', '));
      const attKind = k === 'lease' ? 'lease_comp' : 'sale_comp';
      const atts = await Att.listFor(db, attKind, c.id);
      res.send(layout(c.address || K.one, `<p class="crumbs"><a href="${K.base}">${K.label}</a> ›</p>
      <div class="ph"><div><h1>${esc(c.address)}</h1><p class="muted">${esc([c.city, c.state, c.zip].filter(Boolean).join(', '))} · <a href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener">Map</a></p></div><div>${k === 'sale' ? `<span class="badge ${Area.salePosture(c) === 'asking' ? 's-talked' : 's-listing-client'}">${Area.salePosture(c) === 'asking' ? 'Asking — not closed' : 'Closed sale'}</span> ` : ''}${vbadge(c.verified)}</div></div>
      ${c.property_id ? `<p>Linked property: <a href="/properties/${c.property_id}">${esc(c.prop_address)}</a>${c.tenant_name ? ` · Tenant group: <a href="/tenants/${c.tenant_id}">${esc(c.tenant_name)}</a>` : ''}</p>` : c.tenant_name ? `<p>Tenant group: <a href="/tenants/${c.tenant_id}">${esc(c.tenant_name)}</a></p>` : ''}
      ${atts.length ? `<p class="box" style="display:inline-block">${Att.linksHtml(atts)}</p>` : ''}
      ${k === 'sale' && c.buyer_id ? `<p>Buyer page: <a href="/buyers/${c.buyer_id}">${esc(c.purchaser_name || c.purchaser_entity || c.buyer)}</a></p>` : ''}
      <dl class="facts">${facts.map(([a, b]) => `<div><dt>${a}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>
      ${c.notes ? `<h2>Notes</h2><div class="pre box">${esc(c.notes)}</div>` : ''}
      <p class="muted small">Source: ${esc(c.source || '')} · added ${fmtDate(c.created_at)}</p>
      ${!c.verified ? `<form method="post" action="${K.base}/${c.id}/verify" class="inline"><button>Mark verified</button></form>` : ''}
      <details class="box"><summary>Edit this comp</summary>${compForm(k, c, `${K.base}/${c.id}`, await tenantList())}
      <form method="post" action="${K.base}/${c.id}/attach" enctype="multipart/form-data" class="form" style="margin-top:1rem">
        <label>Attach file (PDF)<input type="file" name="file" accept=".pdf,application/pdf" required></label>
        <button>Upload attachment</button>
      </form>
      <form method="post" action="${K.base}/${c.id}/delete" onsubmit="return confirm('Delete this comp? This cannot be undone.')"><button class="danger">Delete comp</button></form></details>`, { active: 'comps' }));
    }));
    app.post(K.base + '/:id', wrap(async (req, res) => {
      const id = parseInt(req.params.id); const c = fromBody(k, req.body); if (!c.address) return res.redirect(`${K.base}/${id}`);
      const cols = C[k === 'sale' ? 'SALE_COLS' : 'LEASE_COLS'].filter((x) => !['source_key'].includes(x));
      c.norm_addr = C.normAddr(c.address); if (k === 'sale' && c.land_use === undefined) delete c.land_use;
      const set = cols.filter((x) => c[x] !== undefined); await db.query(`UPDATE ${K.table} SET ${set.map((x, i) => `${x}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...set.map((x) => c[x])]);
      res.redirect(`${K.base}/${id}`);
    }));
    app.post(K.base + '/:id/verify', wrap(async (req, res) => { const id = parseInt(req.params.id); await db.query(`UPDATE ${K.table} SET verified=true, updated_at=now() WHERE id=$1`, [id]); res.redirect(`${K.base}/${id}`); }));
    app.post(K.base + '/:id/delete', wrap(async (req, res) => { await db.query(`DELETE FROM ${K.table} WHERE id=$1`, [parseInt(req.params.id)]); res.redirect(K.base); }));
    app.post(K.base + '/:id/attach', upload.single('file'), wrap(async (req, res) => {
      const id = parseInt(req.params.id) || 0;
      const [c] = await db.query(`SELECT id FROM ${K.table} WHERE id=$1`, [id]); if (!c) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
      if (!req.file) return res.redirect(`${K.base}/${id}`);
      const kind = k === 'lease' ? 'lease_comp' : 'sale_comp';
      await Att.upsert(db, { kind, record_id: id, filename: req.file.originalname || 'attachment.pdf', mime_type: req.file.mimetype || 'application/pdf', data: req.file.buffer });
      res.redirect(`${K.base}/${id}`);
    }));
  }

  // ---------- quick "Log comp" (30-second form) ----------
  app.get('/comps/log', wrap(async (req, res) => {
    const p = await loadProp(parseInt(req.query.property_id) || 0);
    res.send(layout('Log comp', `${p ? `<p class="crumbs"><a href="/properties/${p.id}">${esc(p.address)}</a> ›</p>` : ''}<h1>Log a comp</h1>
    ${req.query.from === 'call' ? '<p class="muted">Call saved. Log what you learned about rent or a sale:</p>' : ''}${quickCompForm(p || {}, '', req.query.from === 'call' ? 'call' : '')}`, { active: 'comps' }));
  }));
  app.post('/comps/quick', wrap(async (req, res) => {
    const b = req.body; const k = b.type === 'lease' ? 'lease' : 'sale'; const c = fromBody(k, b);
    if (!c.address) return res.redirect('/comps/log' + (b.property_id ? '?property_id=' + parseInt(b.property_id) : ''));
    c.source = c.source || (b.from === 'call' ? 'Owner call' : 'Logged in app'); c.source_key = 'app:' + crypto.randomUUID();
    const r = await C.upsertComps(getDb(), k, [c], { autoMatch: !c.property_id });
    res.redirect(c.property_id ? `/properties/${c.property_id}?comp=${k}#comps` : `${KIND[k].base}/${r.ids[0]}`);
  }));

  // ---------- CSV import with column mapping + public feeds ----------
  const IMPORT_DIR = path.join(os.tmpdir(), 'mobcrm-imports'); fs.mkdirSync(IMPORT_DIR, { recursive: true });
  app.get('/comps/import', wrap(async (req, res) => {
    const runs = await db.query(`SELECT source, count(*)::int n, count(*) FILTER (WHERE verified)::int v, max(created_at) last FROM sale_comps GROUP BY 1
      UNION ALL SELECT source || ' (lease)', count(*)::int, count(*) FILTER (WHERE verified)::int, max(created_at) FROM lease_comps GROUP BY 1 ORDER BY 4 DESC NULLS LAST`);
    const syncs = await db.query('SELECT * FROM crm_sync_runs ORDER BY started_at DESC LIMIT 15').catch(() => []);
    const when = (d) => (d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '');
    res.send(layout('Import comps', `<h1>Comps</h1>${subnav('import')}
    ${req.query.done ? `<p class="box ok">${esc(req.query.done)}</p>` : ''}
    <h2>Prospect list sync</h2><p class="muted small">New rows from the research team flow in automatically: any <code>crm-delta-*.csv</code> saved in <code>${esc(paths.deltaDir())}</code> is imported within about a minute
    (set <code>DELTA_DIR</code> or <code>DATA_DIR</code>; workbook path is <code>${esc(paths.workbookPath())}</code> via <code>WORKBOOK_PATH</code>).
    (format: <code>./docs/CRM_DELTA_FORMAT.md</code>). Imports only add new properties and contacts and fill empty fields; nothing you edited here is overwritten.</p>
    <form method="post" action="/sync/general" class="box" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Syncing…'">
      <button>Sync General tab now</button> <span class="muted small">Re-reads the General tab of Prospects_updated.xlsx (from a read-only copy).</span></form>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>When</th><th>What</th><th>Status</th><th class="num">New props</th><th class="num">Enriched</th><th class="num">New contacts</th><th class="num">Skipped rows</th><th>Unmatched tenant groups</th></tr></thead><tbody>
    ${syncs.map((r) => { const x = r.result || {}; return `<tr><td>${when(r.started_at)}</td><td><a href="/sync/runs/${r.id}">${esc(r.kind === 'delta' ? r.file : r.kind === 'workbook-request' ? 'General tab sync requested' : 'General tab (workbook)')}</a></td>
      <td>${r.status === 'ok' ? 'OK' : r.status === 'failed' ? `<b>Failed</b> <span class="small">${esc((r.error || '').slice(0, 120))}</span>` : esc(r.status)}</td>
      <td class="num">${x.new_properties ?? ''}</td><td class="num">${x.existing_properties_enriched ?? ''}</td><td class="num">${x.new_owners ?? ''}</td><td class="num">${x.skipped ? x.skipped.length : ''}</td><td class="small">${esc(Object.entries(x.unmatched_groups || {}).map(([n, c]) => c > 1 ? `${n} (${c})` : n).join('; '))}</td></tr>`; }).join('')
      || '<tr><td colspan="8" class="muted">No syncs yet.</td></tr>'}</tbody></table></div>
    ${(() => { const agg = {}; for (const r of syncs) for (const [n, c] of Object.entries((r.result || {}).unmatched_groups || {})) agg[n] = (agg[n] || 0) + c; const e = Object.entries(agg).sort((a, b) => b[1] - a[1]);
      return e.length ? `<div class="box"><b>Tenant groups named in recent syncs that are not in the CRM</b> <span class="muted small">(matched ignoring case, spaces and punctuation; no group is created automatically; add the group or an alias, then re-import the file)</span><p>${e.map(([n, c]) => `${esc(n)} <span class="muted">×${c}</span>`).join(' · ')}</p></div>` : ''; })()}
    <h2>Import a CSV</h2><p class="muted small">CoStar, LoopNet, LightBox, Crexi, or your own spreadsheet (save it as CSV). You'll match the columns on the next screen. Imported comps are marked <b>unverified</b>; rows already imported from the same source are skipped.</p>
    <form method="post" action="/comps/import" enctype="multipart/form-data" class="form grid box">
      <label>Comp type<select name="type"><option value="sale">Sale comps</option><option value="lease">Lease comps</option></select></label>
      <label>Source label<input name="source" required placeholder="e.g. CoStar export Nov 2026"></label>
      <label class="wide">CSV file<input type="file" name="file" accept=".csv,text/csv" required></label><div class="wide"><button>Next: match columns</button></div></form>
    <h2>Public-records feed</h2><p class="muted small">Pulls recent medical-office and office sales from free county records and adds them as <b>unverified</b> sale comps (no duplicates).
    Sources: Franklin County, OH (Columbus) auditor conveyances (buyer, seller, price) and Wake County, NC (Raleigh/Cary) qualified sales (price, SF, year built).</p>
    <form method="post" action="/comps/feeds/run" class="form grid box">
      <label>Source<select name="source"><option value="all">All sources</option>${Object.keys(SOURCES).map((s) => `<option>${s}</option>`).join('')}</select></label>
      <label>Look back (days)<input name="days" value="30" inputmode="numeric"></label>
      <label>Property types<select name="office"><option value="1">Medical + general office</option><option value="0">Medical only</option></select></label>
      <div class="wide"><button>Fetch now</button></div></form>
    <h2>Comps by source</h2><table class="tbl"><thead><tr><th>Source</th><th class="num">Comps</th><th class="num">Verified</th><th>Last added</th></tr></thead><tbody>
    ${runs.map((r) => `<tr><td>${esc(r.source || '(none)')}</td><td class="num">${r.n}</td><td class="num">${r.v}</td><td>${fmtDate(r.last)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No comps yet.</td></tr>'}</tbody></table>`, { active: 'comps' }));
  }));
  app.post('/comps/import', upload.single('file'), wrap(async (req, res) => {
    const k = req.body.type === 'lease' ? 'lease' : 'sale'; const source = nz(req.body.source) || 'CSV import';
    if (!req.file) return res.redirect('/comps/import');
    let rows; try { rows = parse(req.file.buffer.toString('utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true }); }
    catch (e) { return res.status(400).send(layout('Import', `<h1>Couldn't read that CSV</h1><p class="muted">${esc(e.message)}</p><p><a href="/comps/import">Back</a></p>`, { active: 'comps' })); }
    if (rows.length < 2) return res.status(400).send(layout('Import', '<h1>That CSV has no data rows</h1><p><a href="/comps/import">Back</a></p>', { active: 'comps' }));
    const token = crypto.randomBytes(12).toString('hex'); fs.writeFileSync(path.join(IMPORT_DIR, token + '.json'), JSON.stringify(rows));
    const headers = rows[0]; const guess = C.guessMapping(k, headers);
    res.send(layout('Match columns', `<p class="crumbs"><a href="/comps/import">Import</a> ›</p><h1>Match columns</h1>
    <p class="muted">${rows.length - 1} rows · ${headers.length} columns · importing as <b>${k === 'sale' ? 'sale' : 'lease'} comps</b> from “${esc(source)}”. Leave a field on “—” to skip it.</p>
    <form method="post" action="/comps/import/run" class="form grid box"><input type="hidden" name="token" value="${token}"><input type="hidden" name="type" value="${k}"><input type="hidden" name="source" value="${esc(source)}">
    ${C.fieldsFor(k).map((f) => `<label>${esc(f.l)}${f.req ? ' *' : ''}<select name="map_${f.k}"><option value="">—</option>${headers.map((h, i) => `<option value="${i}"${guess[f.k] === i ? ' selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select></label>`).join('')}
    <div class="wide"><button>Import ${rows.length - 1} rows</button></div></form>
    <h2>Preview</h2><div class="tblwrap"><table class="tbl"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
    ${rows.slice(1, 6).map((r) => `<tr>${headers.map((_, i) => `<td class="small">${esc(r[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`, { active: 'comps' }));
  }));
  app.post('/comps/import/run', wrap(async (req, res) => {
    const token = String(req.body.token || '').replace(/[^a-f0-9]/g, ''); const file = path.join(IMPORT_DIR, token + '.json');
    if (!token || !fs.existsSync(file)) return res.redirect('/comps/import');
    const k = req.body.type === 'lease' ? 'lease' : 'sale'; const source = nz(req.body.source) || 'CSV import';
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')); const mapping = {};
    for (const f of C.fieldsFor(k)) { const v = req.body['map_' + f.k]; if (v !== undefined && v !== '') mapping[f.k] = parseInt(v); }
    if (mapping.address === undefined) return res.status(400).send(layout('Import', '<h1>Pick the Address column</h1><p>Address is required to import comps.</p><p><a href="/comps/import">Start over</a></p>', { active: 'comps' }));
    const { comps, skipped } = C.mapRows(k, rows.slice(1), mapping, source);
    const r = await C.upsertComps(getDb(), k, comps); fs.unlinkSync(file);
    res.redirect('/comps/import' + qs({ done: `Imported from “${source}”: ${r.inserted} new ${k} comps, ${r.updated} already existed (not duplicated), ${skipped} rows skipped (no address). ${r.matched} matched to CRM properties.` }));
  }));
  app.post('/comps/feeds/run', wrap(async (req, res) => {
    const days = Math.min(730, Math.max(1, parseInt(req.body.days) || 30)); const includeOffice = req.body.office !== '0';
    const names = req.body.source && SOURCES[req.body.source] ? [req.body.source] : Object.keys(SOURCES); const msgs = [];
    for (const n of names) {
      try { const comps = await SOURCES[n]({ days, includeOffice }); const r = await C.upsertComps(getDb(), 'sale', comps); msgs.push(`${n}: ${comps.length} found, ${r.inserted} new, ${r.updated} already had`); }
      catch (e) { msgs.push(`${n}: failed (${e.message})`); }
    }
    res.redirect('/comps/import' + qs({ done: `Feed (last ${days} days): ` + msgs.join(' · ') }));
  }));

  // ---------- prospect list sync (General tab + crm-delta-*.csv) ----------
  const SYNC = require('./general-sync');
  app.post('/sync/general', wrap(async (req, res) => {
    let msg;
    if (!fs.existsSync(SYNC.LIVE)) { // hosted copy: the workbook lives on the box, so ask the box worker to push it now
      await getDb().query("INSERT INTO crm_sync_runs (kind, file, status, finished_at) VALUES ('workbook-request', 'Prospects_updated.xlsx / General', 'requested', NULL)");
      console.log('[sync] General tab sync requested from the box');
      return res.redirect('/comps/import' + qs({ done: 'Sync requested. The workbook lives on the box; it will be pushed and imported within about a minute (refresh this page to see the result).' }));
    }
    try { const r = await SYNC.syncWorkbook(getDb()); console.log(`[sync] General tab: ${r.new_properties} new properties, ${r.existing_properties_enriched} enriched, ${r.new_owners} new owners, ${r.skipped.length} rows skipped, ${r.comps_linked} comps linked`);
      msg = `General tab synced: ${r.new_properties} new properties, ${r.existing_properties_enriched} existing properties enriched, ${r.new_owners} new contacts, ${r.skipped.length} rows skipped, ${r.comps_linked} comps linked.`; }
    catch (e) { console.log('[sync] General tab FAILED: ' + e.message); msg = 'Sync failed: ' + e.message; }
    res.redirect('/comps/import' + qs({ done: msg }));
  }));
  app.get('/sync/runs/:id', wrap(async (req, res) => {
    const [r] = await db.query('SELECT * FROM crm_sync_runs WHERE id=$1', [parseInt(req.params.id) || 0]); if (!r) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
    const x = r.result || {}; const ids = x.new_property_ids || [];
    const facts = [['Rows read', x.rows_read], ['New properties', x.new_properties], ['Existing properties matched', x.existing_properties_matched], ['Existing properties enriched', x.existing_properties_enriched],
      ['Empty fields filled', x.fields_filled], ['New contacts', x.new_owners], ['Contacts reused from other properties', x.owners_reused_from_other_properties], ['Contacts enriched', x.owners_enriched],
      ['New tenant groups', x.new_tenants], ['Tenant links added', x.tenant_links_added], ['Call-history entries added', x.activities_added], ['Comps linked', x.comps_linked]].filter((f) => f[1] !== undefined);
    res.send(layout('Sync run', `<p class="crumbs"><a href="/comps/import">Import / feeds</a> ›</p><h1>${esc(r.kind === 'delta' ? r.file : 'General tab sync')}</h1>
      <p class="muted">${esc(r.status)} · ${esc(new Date(r.started_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))} ET</p>${r.error ? `<p class="box">${esc(r.error)}</p>` : ''}
      <dl class="facts">${facts.map(([a, b]) => `<div><dt>${a}</dt><dd>${esc(String(b))}</dd></div>`).join('')}</dl>
      ${x.new_by_state && Object.keys(x.new_by_state).length ? `<p>New by state: ${Object.entries(x.new_by_state).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>` : ''}
      ${(x.skipped || []).length ? `<h2>Skipped / flagged rows</h2><div class="tblwrap"><table class="tbl"><thead><tr><th>Row</th><th>Reason</th><th>Text</th></tr></thead><tbody>${x.skipped.map((k) => `<tr><td>${k.row}</td><td>${esc(k.reason)}</td><td>${esc(k.text || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${(x.tenant_rows || []).length ? (() => { const tr = x.tenant_rows; const n = (o) => tr.filter((k) => k.outcome === o).length; const label = { linked: 'Linked', already_linked: 'Already linked', unmatched: '<b>Group not in CRM</b>' };
        return `<h2>Tenant groups named in the file</h2><p>${n('linked')} linked · ${n('already_linked')} already linked · ${n('unmatched')} not matched</p><div class="tblwrap"><table class="tbl"><thead><tr><th>Row</th><th>Property</th><th>Group as written</th><th>Outcome</th><th>CRM group</th></tr></thead><tbody>${tr.map((k) => `<tr><td>${k.row ?? ''}</td><td><a href="/properties/${k.property_id}">${esc([k.address, k.city, k.state].filter(Boolean).join(', '))}</a></td><td>${esc(k.group_as_written)}</td><td>${label[k.outcome] || esc(k.outcome)}</td><td>${esc(k.group || '')}${k.via_alias ? ' <span class="muted small">(alias)</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`; })() : ''}
      ${ids.length ? `<h2>New properties (${ids.length})</h2><p>${ids.slice(0, 300).map((id) => `<a href="/properties/${id}">#${id}</a>`).join(' ')}${ids.length > 300 ? ' …' : ''}</p>` : ''}`, { active: 'comps' }));
  }));

  // ---------- helpers ----------
  function fromBody(k, b) {
    const c = {};
    for (const f of C.fieldsFor(k)) if (b[f.k] !== undefined) c[f.k] = C.parseField(f, b[f.k]);
    if (b.lease_type !== undefined && k === 'lease') c.lease_type = C.LEASE_TYPES.includes(b.lease_type) ? b.lease_type : C.P.leaseType(b.lease_type);
    if (b.verified !== undefined) c.verified = b.verified === '1' || b.verified === 'verified';
    if (b.source !== undefined) c.source = nz(b.source);
    if (b.property_id !== undefined) c.property_id = parseInt(b.property_id) || null;
    if (b.tenant_id !== undefined) c.tenant_id = parseInt(b.tenant_id) || null;
    if (b.lat !== undefined && b.lat !== '') c.lat = C.P.num(b.lat);
    if (b.lng !== undefined && b.lng !== '') c.lng = C.P.num(b.lng);
    return c;
  }
  function compForm(k, c, action, tenants) {
    const v = (x) => esc(c[x] instanceof Date ? isoDate(c[x]) : c[x]);
    const input = (f) => {
      if (f.k === 'notes') return `<label class="wide">Notes<textarea name="notes" rows="3">${v('notes')}</textarea></label>`;
      if (f.t === 'select') return `<label>${f.l}<select name="${f.k}"><option value="">—</option>${f.opts.map((o) => `<option${c[f.k] === o ? ' selected' : ''}>${o}</option>`).join('')}</select></label>`;
      if (f.t === 'date') return `<label>${f.l}<input type="date" name="${f.k}" value="${isoDate(c[f.k])}"></label>`;
      if (f.t === 'pct') return `<label>${f.l} (%)<input name="${f.k}" value="${c[f.k] !== null && c[f.k] !== undefined ? +(Number(c[f.k]) * 100).toFixed(3) : ''}" inputmode="decimal" placeholder="6.5"></label>`;
      const numeric = ['num', 'money', 'int'].includes(f.t);
      return `<label class="${f.k === 'address' ? 'wide' : ''}">${f.l}<input name="${f.k}" value="${v(f.k)}"${numeric ? ' inputmode="decimal"' : ''}${f.req ? ' required' : ''}${f.k === 'state' ? ' maxlength="20" placeholder="FL"' : ''}></label>`;
    };
    return `<form method="post" action="${action}" class="form grid">${C.fieldsFor(k).map(input).join('')}
      <label>Tenant group<select name="tenant_id"><option value="">—</option>${tenants.map((t) => `<option value="${t.id}"${String(c.tenant_id) === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label>Linked property ID<input name="property_id" value="${esc(c.property_id || '')}" inputmode="numeric" placeholder="auto-matched by address"></label>
      <label>Source<input name="source" value="${v('source')}" placeholder="e.g. Owner call, CoStar, broker"></label>
      <label>Status<select name="verified"><option value="0"${!c.verified ? ' selected' : ''}>Unverified</option><option value="1"${c.verified ? ' selected' : ''}>Verified</option></select></label>
      <div class="wide"><button>Save</button></div></form>`;
  }
  function pagerHtml(n, page, per, base) {
    const pages = Math.ceil(n / per); if (pages <= 1) return '';
    const link = (p, l) => `<a class="btn ghost" href="${base}${base.includes('?') ? '&' : '?'}page=${p}">${l}</a>`;
    return `<div class="pager">${page > 1 ? link(page - 1, '‹ Prev') : ''}<span class="muted">Page ${page} of ${pages}</span>${page < pages ? link(page + 1, 'Next ›') : ''}</div>`;
  }
  return { compsPanel, areaCompsPanel, quickCompForm };

  async function areaCompsPanel(p) {
    try { return await areaCompsHtml(p); }
    catch (e) { console.error('[area-comps]', e); return `<section id="area-comps" class="area-comps"><h2>Area comps</h2><p class="muted">Area comps could not be loaded (${esc(e.message)}). The rest of this property record is unchanged.</p></section>`; }
  }
  async function areaCompsHtml(p) {
    const state = p.state ? String(p.state).toUpperCase() : '';
    const city = p.city || '';
    const origin = Area.searchOrigin(p);
    const radius = Area.radiusMiles();
    const params = [];
    const parts = [];
    const cityNorm = geo.normKey(city);
    if (state && cityNorm) {
      params.push(state, cityNorm);
      parts.push(`(c.state = $${params.length - 1} AND lower(regexp_replace(COALESCE(c.city, ''), '[^a-zA-Z]', '', 'g')) = $${params.length})`);
    }
    if (origin) {
      const dLat = radius / 69;
      const dLng = radius / (69 * Math.cos(origin.lat * Math.PI / 180) || 1);
      params.push(origin.lat - dLat, origin.lat + dLat, origin.lng - dLng, origin.lng + dLng);
      const n = params.length;
      parts.push(`(c.lat BETWEEN $${n - 3} AND $${n - 2} AND c.lng BETWEEN $${n - 1} AND $${n})`);
      const near = geo.placesWithin(origin.lat, origin.lng, radius);
      if (near.length) {
        const tuples = near.map((place) => {
          params.push(place.state, place.norm);
          return `($${params.length - 1}, $${params.length})`;
        });
        parts.push(`(c.state, lower(regexp_replace(COALESCE(c.city, ''), '[^a-zA-Z]', '', 'g'))) IN (${tuples.join(', ')})`);
      }
      const zips = geo.zipsWithin(origin.lat, origin.lng, radius);
      if (zips.length) {
        params.push(zips);
        parts.push(`left(regexp_replace(COALESCE(c.zip, ''), '\\D', '', 'g'), 5) = ANY($${params.length}::text[])`);
      }
    }
    const where = parts.length ? parts.join(' OR ') : 'FALSE';
    const sales = parts.length ? await db.query(`${SELECT('sale')} WHERE ${where} ORDER BY c.sale_date DESC NULLS LAST LIMIT 400`, params) : [];
    const leases = parts.length ? await db.query(`${SELECT('lease')} WHERE ${where} ORDER BY c.start_date DESC NULLS LAST LIMIT 400`, params) : [];
    let listings = [];
    if (state && city) listings = await db.query('SELECT * FROM listings WHERE state=$1 AND lower(city)=lower($2)', [state, city]);
    else if (state) listings = await db.query('SELECT * FROM listings WHERE state=$1', [state]);
    return Area.renderAreaComps(Area.buildAreaComps(p, sales, leases, listings));
  }

  // Panel for the property detail page: comps linked to the property + count of same-city comps.
  async function compsPanel(p) {
    const sales = await db.query(`${SELECT('sale')} WHERE c.property_id=$1 ORDER BY c.sale_date DESC NULLS LAST`, [p.id]);
    const leases = await db.query(`${SELECT('lease')} WHERE c.property_id=$1 ORDER BY c.start_date DESC NULLS LAST`, [p.id]);
    let city = { s: 0, l: 0 };
    if (p.city && p.state) [city] = await db.query(`SELECT (SELECT count(*) FROM sale_comps WHERE lower(city)=lower($1) AND state=$2 AND property_id IS DISTINCT FROM $3)::int s,
      (SELECT count(*) FROM lease_comps WHERE lower(city)=lower($1) AND state=$2 AND property_id IS DISTINCT FROM $3)::int l`, [p.city, p.state, p.id]);
    const cq = qs({ city: p.city, state: p.state });
    return `<h2 id="comps">Comps</h2><div class="box">
      ${sales.length ? `<ul class="acts plain">${sales.map((c) => `<li><a href="/comps/sales/${c.id}"><b>Sale ${fmtDate(c.sale_date) || '(no date)'}</b></a> · ${money(c.price) || 'price n/a'}${c.ppsf ? ` · $${numf(c.ppsf)}/sf` : ''}${c.cap_rate ? ` · ${pct(c.cap_rate)} cap` : ''} ${vbadge(c.verified)}
        <div class="muted small">${esc([c.buyer && 'Buyer: ' + c.buyer, c.seller && 'Seller: ' + c.seller, c.source].filter(Boolean).join(' · '))}</div></li>`).join('')}</ul>` : ''}
      ${leases.length ? `<ul class="acts plain">${(await Promise.all(leases.map(async (c) => {
        const atts = await Att.listFor(db, 'lease_comp', c.id);
        return `<li><a href="/comps/leases/${c.id}"><b>Lease ${esc(c.tenant || '')}</b></a> · ${leaseRentHtml(c)} ${esc(c.lease_type || '')}${c.sf_leased ? ` · ${numf(c.sf_leased)} sf` : ''}${c.term_months ? ` · ${c.term_months} mo` : ''} ${vbadge(c.verified)}
        <div class="muted small">${esc([c.start_date && 'Start ' + fmtDate(c.start_date), c.source].filter(Boolean).join(' · '))}${atts.length ? ' · ' + atts.map((a) => `<a href="/files/${a.id}" target="_blank" rel="noopener">Offering memorandum (PDF)</a>`).join(', ') : ''}</div></li>`;
      }))).join('')}</ul>` : ''}
      ${!sales.length && !leases.length ? '<p class="muted">No comps linked to this property yet.</p>' : ''}
      ${p.city ? `<p class="small">Full unfiltered list in ${esc(p.city)}, ${esc(p.state || '')} (includes this property and every property type): <a href="/comps/sales${cq}">${city.s} other sale comp${city.s === 1 ? '' : 's'}</a> · <a href="/comps/leases${cq}">${city.l} lease comp${city.l === 1 ? '' : 's'}</a>. The area block at the bottom of this page is the call set.</p>` : ''}
      <details${p._openComp ? ' open' : ''}><summary>+ Log comp</summary>${quickCompForm(p, `/properties/${p.id}`)}</details></div>`;
  }
};

// The 30-second form: prefilled with the property's address/state/tenant; pick Sale or Lease and type the key numbers.
function quickCompForm(p, back = '', from = '') {
  const tn = p.tenant_names || (p.tenants || []).map((t) => t.name).join('; ');
  const tid = p.tenant_id || (p.tenants && p.tenants[0] && p.tenants[0].id) || '';
  return `<form method="post" action="/comps/quick" class="form grid quickcomp">
  <input type="hidden" name="property_id" value="${esc(p.id || '')}"><input type="hidden" name="tenant_id" value="${esc(tid)}"><input type="hidden" name="from" value="${esc(from)}">
  <div class="wide seg"><label class="chk"><input type="radio" name="type" value="sale" checked> Sale</label><label class="chk"><input type="radio" name="type" value="lease"> Lease</label></div>
  <label class="wide">Address<input name="address" value="${esc(p.address || '')}" required></label>
  <label>City<input name="city" value="${esc(p.city || '')}"></label><label>State<input name="state" value="${esc(p.state || '')}" maxlength="20"></label>
  <label class="s">Sale date<input type="date" name="sale_date"></label><label class="s">Price<input name="price" inputmode="decimal" placeholder="$2,100,000"></label>
  <label class="s">RBA (sf)<input name="rba" inputmode="decimal" value="${esc(p.rba || '')}"></label><label class="s">Cap rate (%)<input name="cap_rate" inputmode="decimal" placeholder="6.5"></label>
  <label class="s">Buyer<input name="buyer"></label><label class="s">Seller<input name="seller"></label>
  <label class="l">Tenant<input name="tenant" value="${esc(tn)}"></label><label class="l">SF leased<input name="sf_leased" inputmode="decimal"></label>
  <label class="l">Rent $/SF<input name="rent_psf" inputmode="decimal" placeholder="28.50"></label>
  <label class="l">Lease type<select name="lease_type"><option value="">—</option>${C.LEASE_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></label>
  <label class="l">Term (months)<input name="term_months" inputmode="numeric"></label><label class="l">Start date<input type="date" name="start_date"></label>
  <label class="l">Escalations<input name="escalations" placeholder="3%/yr"></label><label class="l">TI $/SF<input name="ti_psf" inputmode="decimal"></label><label class="l">Free rent (months)<input name="free_rent_months" inputmode="decimal"></label>
  <input type="hidden" name="tenants" value="${esc(tn)}">
  <label>Source<input name="source" value="${from === 'call' ? 'Owner call' : ''}" placeholder="Owner call, broker, CoStar…"></label>
  <label>Status<select name="verified"><option value="0">Unverified</option><option value="1">Verified</option></select></label>
  <label class="wide">Notes<input name="notes" placeholder="Who told you, anything unusual"></label>
  <div class="wide"><button>Save comp</button></div></form>`;
}
module.exports.quickCompForm = quickCompForm;
