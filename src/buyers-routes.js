// Buyers tab (purchasers from sale comps) and Listings tab (our listings + ranked likely buyers).
const multer = require('multer'); const { parse } = require('csv-parse/sync');
const { esc, layout, fmtDate, isoDate, money, numf, pct, qs, telHref, STATE_NAMES } = require('./views');
const C = require('./comps-core'); const Att = require('./attachments'); const B = require('./buyers');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const nz = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s === '' ? null : s; };
const STATUSES = ['Active', 'Under contract', 'Sold', 'Dead'];
const LEASE_TYPES = C.LEASE_TYPES || ['NNN', 'Modified Gross', 'Full Service', 'Gross'];
const stBadge = (s) => `<span class="badge ${s === 'Active' ? 's-interested' : s === 'Under contract' ? 's-talked' : s === 'Sold' ? 's-listing-client' : 's-not-interested'}">${esc(s)}</span>`;
const yrs = (v) => (v === null || v === undefined || v === '' ? '' : numf(v, 1) + ' yrs');
const place = (c) => [c.city, c.state].filter(Boolean).join(', ');
const contactCell = (b) => { const c = b.best; if (!c) return ''; const who = c.contact_name || c.officer_name; return `${esc(who || '')}${c.officer_title ? ` <span class="muted">(${esc(c.officer_title)})</span>` : ''}${c.phone ? `<br><a href="${telHref(c.phone)}">${esc(c.phone)}</a>` : ''}${!c.phone && c.email ? `<br><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}`; };
const num = (v) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(+v) ? null : +v);

module.exports = function mountBuyers(app, getDb, wrap) {
  const db = { query: (...a) => getDb().query(...a) };

  // ---------------- Buyers ----------------
  app.get('/buyers', wrap(async (req, res) => {
    const f = Object.fromEntries(['q', 'state', 'city', 'pmin', 'pmax', 'cmin', 'cmax', 'ymin', 'sort', 'dir'].map((k) => [k, nz(req.query[k]) || '']));
    const all = await B.loadBuyers(db);
    const states = [...new Set(all.flatMap((b) => b.purchases.map((c) => c.state)).filter(Boolean))].sort();
    const q = f.q.toLowerCase();
    let rows = all.filter((b) => {
      const L = b.last;
      if (q && ![b.name, b.entity, b.owner_name, ...b.contacts.map((c) => c.contact_name || c.officer_name), ...b.purchases.map((c) => c.address)].some((x) => String(x || '').toLowerCase().includes(q))) return false;
      if (f.state && !b.purchases.some((c) => c.state === f.state.toUpperCase())) return false;
      if (f.city && !b.purchases.some((c) => String(c.city || '').toLowerCase() === f.city.toLowerCase())) return false;
      const P = num(L.price); const cap = num(L.cap_rate);
      if (num(f.pmin) !== null && !(P >= num(f.pmin))) return false;
      if (num(f.pmax) !== null && !(P !== null && P <= num(f.pmax))) return false;
      if (num(f.cmin) !== null && !(cap !== null && cap * 100 >= num(f.cmin))) return false;
      if (num(f.cmax) !== null && !(cap !== null && cap * 100 <= num(f.cmax))) return false;
      if (num(f.ymin) !== null && !(L.years_remaining !== null && L.years_remaining >= num(f.ymin))) return false;
      return true;
    });
    const sort = ['date', 'price', 'cap', 'years', 'name', 'count'].includes(f.sort) ? f.sort : 'date';
    const dir = f.dir === 'asc' ? 1 : f.dir === 'desc' ? -1 : sort === 'name' ? 1 : -1;
    const key = { date: (b) => isoDate(b.last.sale_date) || null, price: (b) => num(b.last.price), cap: (b) => num(b.last.cap_rate), years: (b) => b.last.years_remaining, name: (b) => b.display.toLowerCase(), count: (b) => b.purchases.length }[sort];
    rows.sort((a, b) => { const x = key(a); const y = key(b); if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return (x < y ? -1 : 1) * dir; });
    const total = rows.length; rows = rows.slice(0, 300);
    const th = (col, label, numc) => { const on = sort === col; const nd = on && dir === 1 ? 'desc' : 'asc';
      return `<th class="${numc ? 'num' : ''}"><a class="sortable${on ? ' on' : ''}" href="/buyers${qs({ ...f, sort: col, dir: nd })}">${label}${on ? (dir === 1 ? ' ▲' : ' ▼') : ''}</a></th>`; };
    const opt = (v, l, sel) => `<option value="${esc(v)}"${String(sel) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
    res.send(layout('Buyers', `<h1>Buyers</h1>
      <p class="muted small">Purchasers from sale comps: purchaser name/entity when a comp has them, otherwise the recorded buyer (grantee). Phones and emails appear only when a comp's purchaser fields or a linked owner have them.</p>
      <p class="actions"><a class="btn ghost small" href="/buyers/import">Import buyer contacts CSV</a></p>
      <form class="filters" method="get" action="/buyers">
        <input type="search" name="q" value="${esc(f.q)}" placeholder="Search name, entity, address…">
        <select name="state"><option value="">All states</option>${states.map((s) => opt(s, s, f.state)).join('')}</select>
        <input name="city" value="${esc(f.city)}" placeholder="City" size="10">
        <input name="pmin" value="${esc(f.pmin)}" placeholder="Min price" inputmode="numeric" size="9"><input name="pmax" value="${esc(f.pmax)}" placeholder="Max price" inputmode="numeric" size="9">
        <input name="cmin" value="${esc(f.cmin)}" placeholder="Min cap %" inputmode="decimal" size="6"><input name="cmax" value="${esc(f.cmax)}" placeholder="Max cap %" inputmode="decimal" size="6">
        <input name="ymin" value="${esc(f.ymin)}" placeholder="Min lease yrs left" inputmode="decimal" size="8">
        <input type="hidden" name="sort" value="${esc(f.sort)}"><input type="hidden" name="dir" value="${esc(f.dir)}">
        <button>Filter</button> <a class="btn ghost" href="/buyers">Reset</a></form>
      <p class="muted small">State and city match any purchase; price, cap rate and lease years filter on the last purchase. ${total} buyer${total === 1 ? '' : 's'}${total > rows.length ? ` (showing ${rows.length})` : ''}.</p>
      ${!all.length ? '<p class="box muted">No buyers with purchase history yet. Buyers appear here as sale comps with a buyer or purchaser are added (Comps › Import, or the sync API).</p>'
        : rows.length ? `<div class="tblwrap"><table class="tbl comps"><thead><tr>${th('name', 'Buyer')}${th('date', 'Last purchase')}<th>Address</th><th>City, ST</th>${th('price', 'Price', 1)}${th('cap', 'Cap', 1)}${th('years', 'Lease yrs left', 1)}${th('count', 'Buys', 1)}<th>Contact</th></tr></thead><tbody>
        ${rows.map((b) => { const L = b.last; return `<tr><td><a href="/buyers/${b.id}"><b>${esc(b.display)}</b></a>${b.sub ? `<br><span class="small muted">${esc(b.sub)}</span>` : ''}${b.owner_id ? ' <span class="small" title="Linked CRM owner">👤</span>' : ''}</td>
          <td>${fmtDate(L.sale_date)}</td><td>${L.property_id ? `<a href="/properties/${L.property_id}?from=buyer&bid=${b.id}&cb_at=0">${esc(L.address)}</a>` : `<a href="/comps/sales/${L.id}">${esc(L.address)}</a>`}</td><td>${esc(place(L))}</td>
          <td class="num">${money(L.price)}</td><td class="num">${pct(L.cap_rate)}</td><td class="num">${yrs(L.years_remaining)}</td><td class="num">${b.purchases.length}</td><td class="small">${contactCell(b)}</td></tr>`; }).join('')}</tbody></table></div>`
        : '<p class="muted">No buyers match.</p>'}`, { active: 'buyers' }));
  }));

  app.get('/buyers/:id', wrap(async (req, res) => {
    const [b] = await B.loadBuyers(db, { id: parseInt(req.params.id) || 0 });
    if (!b) return res.status(404).send(layout('Not found', '<h1>Buyer not found</h1><p><a href="/buyers">Back to buyers</a></p>', { active: 'buyers' }));
    const [o] = b.owner_id ? await db.query('SELECT id, name, entity, phone1, phone2, phone3, email FROM owners WHERE id=$1', [b.owner_id]) : [];
    const phones = [b.phone, o && o.phone1, o && o.phone2, o && o.phone3].filter(Boolean); const email = b.email || (o && o.email);
    const states = [...new Set(b.purchases.map((c) => c.state).filter(Boolean))];
    const priced = b.purchases.filter((c) => Number(c.price) > 0);
    res.send(layout(b.display, `<p class="crumbs"><a href="/buyers">Buyers</a> ›</p>
      <h1>${esc(b.display)}</h1>${b.sub ? `<p class="muted">${esc(b.sub)}</p>` : ''}
      <p><a class="btn" href="/buyer-needs/new?buyer_id=${b.id}">Add need</a></p>
      <dl class="facts"><div><dt>Purchases</dt><dd>${b.purchases.length}</dd></div><div><dt>States</dt><dd>${esc(states.join(', '))}</dd></div>
        ${priced.length ? `<div><dt>Price range</dt><dd>${money(Math.min(...priced.map((c) => +c.price)))} – ${money(Math.max(...priced.map((c) => +c.price)))}</dd></div>` : ''}
        ${phones.length ? `<div><dt>Phone</dt><dd>${phones.map((p) => `<a href="${telHref(p)}">${esc(p)}</a>`).join('<br>')}</dd></div>` : ''}
        ${email ? `<div><dt>Email</dt><dd><a href="mailto:${esc(email)}">${esc(email)}</a></dd></div>` : ''}
        ${o ? `<div><dt>CRM owner</dt><dd><a href="/owners/${o.id}">${esc(o.name || o.entity)}</a></dd></div>` : ''}</dl>
      ${b.contacts.length ? `<h2>Contacts</h2><div class="tblwrap"><table class="tbl comps"><thead><tr><th>Name</th><th>Title</th><th>Phone</th><th>Email</th><th>Mailing address</th><th>Entity (state · doc #)</th><th>Registered agent</th><th>Source</th><th>Confidence</th><th>Linked comp</th><th>Notes</th></tr></thead><tbody>
        ${b.contacts.map((c) => `<tr><td><b>${esc(c.contact_name || c.officer_name || '')}</b>${c.contact_name && c.officer_name && c.contact_name !== c.officer_name ? `<br><span class="small muted">Officer: ${esc(c.officer_name)}</span>` : ''}</td><td>${esc(c.officer_title)}</td>
          <td>${c.phone ? `<a href="${telHref(c.phone)}">${esc(c.phone)}</a>${c.phone_type ? ` <span class="small muted">${esc(c.phone_type)}</span>` : ''}` : ''}</td><td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</td>
          <td class="small">${esc(c.mailing_address)}</td><td class="small">${esc([c.buyer_entity, [c.entity_state, c.entity_doc].filter(Boolean).join(' · ')].filter(Boolean).join(' — '))}</td><td class="small">${esc(c.registered_agent)}</td>
          <td class="small">${esc(c.contact_source)}</td><td>${esc(c.confidence)}</td><td class="small">${c.sale_comp_id ? `<a href="/comps/sales/${c.sale_comp_id}">${esc(c.linked_comp_address || 'comp')}</a>` : esc(c.linked_comp_address || '')}${c.linked_sale_date ? ' · ' + fmtDate(c.linked_sale_date) : ''}</td><td class="small">${esc(c.notes)}</td></tr>`).join('')}</tbody></table></div>`
        : !phones.length && !email ? '<p class="muted small">No contact details on file for this buyer.</p>' : ''}
      ${b.purchases.length ? '' : '<p class="muted">No linked purchases yet (added from a buyer-contacts file).</p>'}<h2>Purchases</h2><div class="tblwrap"><table class="tbl comps"><thead><tr><th>Date</th><th>Address</th><th>City, ST</th><th class="num">Price</th><th class="num">RBA</th><th class="num">$/SF</th><th class="num">Cap</th><th class="num">Lease yrs left</th><th>Tenant</th><th>Seller</th></tr></thead><tbody>
      ${(() => { const seen = new Set(); let n = 0; const at = new Map(); for (const c of b.purchases) { if (!c.property_id || seen.has(c.property_id)) continue; seen.add(c.property_id); at.set(c.property_id, n++); } return b.purchases.map((c) => `<tr><td><a href="/comps/sales/${c.id}">${fmtDate(c.sale_date) || '(no date)'}</a></td>
        <td>${c.property_id ? `<a href="/properties/${c.property_id}?from=buyer&bid=${b.id}&cb_at=${at.get(c.property_id)}"><b>${esc(c.address)}</b></a>` : esc(c.address)}</td><td>${esc(place(c))}</td>
        <td class="num">${money(c.price)}</td><td class="num">${numf(c.rba)}</td><td class="num">${c.ppsf ? '$' + numf(c.ppsf) : ''}</td><td class="num">${pct(c.cap_rate)}</td>
        <td class="num">${c.lease_id ? `<a href="/comps/leases/${c.lease_id}">${yrs(c.years_remaining) || '—'}</a>` : ''}</td><td class="small">${esc(c.tenants || c.prop_tenants || '')}</td><td class="small">${esc(c.seller)}</td></tr>`).join(''); })()}
      </tbody></table></div>`, { active: 'buyers' }));
  }));

  app.get('/buyers/import', wrap(async (req, res) => {
    res.send(layout('Import buyer contacts', `<p class="crumbs"><a href="/buyers">Buyers</a> ›</p><h1>Import buyer contacts</h1>
      ${req.query.done ? `<p class="box">${esc(req.query.done)}</p>` : ''}
      <p class="muted small">CSV columns: Buyer Entity (required), Entity State, Entity Doc #, Registered Agent, Officer/Manager Name, Officer Title, Buyer Contact Name, Phone, Phone Type, Email, Mailing Address, Contact Source, Confidence, Linked Comp Address, Linked Sale Date, Notes.
      Rows attach to the buyer with the same entity (or the sale comp at the linked address and date). Re-importing the same file adds nothing new; existing contacts only get blank fields filled.</p>
      <form method="post" action="/buyers/import" enctype="multipart/form-data" class="form">
        <label>CSV file<input type="file" name="file" accept=".csv,text/csv" required></label>
        <label>Source label (used when Contact Source is blank)<input name="source" placeholder="e.g. Analyst – SOS lookups Nov 2026"></label>
        <label><input type="checkbox" name="dry" value="1" checked> Preview only (don't save)</label>
        <button>Upload</button></form>`, { active: 'buyers' }));
  }));
  app.post('/buyers/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return res.redirect('/buyers/import');
    const rows = parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''), { relax_column_count: true, skip_empty_lines: true });
    const dry = req.body.dry === '1';
    const r = await B.importBuyerContacts(getDb(), rows, { dryRun: dry, source: nz(req.body.source) });
    const msg = `${dry ? 'Preview (nothing saved)' : 'Imported'}: ${r.rows} rows, ${r.inserted} new contacts, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped} skipped (no entity); ${r.comps_linked} rows matched a sale comp (${r.comps_filled} comps got purchaser details); ${r.buyers_created} new buyers${r.unmatched_entities.length ? ` (not yet in comps: ${r.unmatched_entities.slice(0, 10).join(', ')}${r.unmatched_entities.length > 10 ? '…' : ''})` : ''}.`;
    res.redirect('/buyers/import' + qs({ done: msg }));
  }));

  // ---------------- Listings ----------------
  async function hydrate(L) {
    const exp = L.lease_expiration ? isoDate(L.lease_expiration) : null;
    L.years_remaining = exp ? B.yearsBetween(B.todayIso(), exp) : (L.years_remaining !== null && L.years_remaining !== undefined ? Number(L.years_remaining) : null);
    if ((L.years_remaining === null) && L.property_id) { // fall back to the linked property's lease comp
      const [lc] = await db.query('SELECT * FROM lease_comps WHERE property_id=$1 ORDER BY start_date DESC NULLS LAST, id DESC LIMIT 1', [L.property_id]);
      const e = B.leaseExpiration(lc); if (e) { L.years_remaining = B.yearsBetween(B.todayIso(), e); L.years_source = 'lease comp'; }
    }
    return L;
  }
  const listSel = `SELECT l.*, p.address prop_address, t.name tenant_group FROM listings l LEFT JOIN properties p ON p.id=l.property_id LEFT JOIN tenants t ON t.id=l.tenant_id`;

  app.get('/listings', wrap(async (req, res) => {
    const st = STATUSES.includes(req.query.status) ? req.query.status : '';
    const rows = await db.query(`${listSel}${st ? ' WHERE l.status=$1' : ''} ORDER BY CASE l.status WHEN 'Active' THEN 0 WHEN 'Under contract' THEN 1 WHEN 'Sold' THEN 2 ELSE 3 END, l.updated_at DESC`, st ? [st] : []);
    for (const L of rows) await hydrate(L);
    res.send(layout('Listings', `<h1>Listings</h1>
      <nav class="subtabs"><a href="/listings" class="${st ? '' : 'on'}">All</a>${STATUSES.map((s) => `<a href="/listings?status=${encodeURIComponent(s)}" class="${st === s ? 'on' : ''}">${s}</a>`).join('')}</nav>
      <p class="actions"><a class="btn small" href="/listings/new">+ New listing</a></p>
      ${rows.length ? `<div class="tblwrap"><table class="tbl comps"><thead><tr><th>Address</th><th>City, ST</th><th>Tenant</th><th class="num">Asking</th><th class="num">Cap</th><th class="num">NOI</th><th class="num">SF</th><th class="num">Lease yrs left</th><th>Status</th></tr></thead><tbody>
      ${(() => { const seen = new Set(); const at = new Map(); for (const L of rows) { if (!L.property_id || seen.has(L.property_id)) continue; seen.add(L.property_id); at.set(L.property_id, at.size); } return rows.map((L) => `<tr><td><a href="/listings/${L.id}"><b>${esc(L.address)}</b></a>${L.property_id ? ` <a class="small" href="/properties/${L.property_id}?from=listings${st ? '&lst=' + encodeURIComponent(st) : ''}&cb_at=${at.get(L.property_id)}" title="Linked CRM property">🏢</a>` : ''}</td><td>${esc(place(L))}</td>
        <td>${esc(L.tenant || L.tenant_group || '')}</td><td class="num">${money(L.asking_price)}</td><td class="num">${pct(L.cap_rate)}</td><td class="num">${money(L.noi)}</td><td class="num">${numf(L.sf)}</td><td class="num">${yrs(L.years_remaining)}</td><td>${stBadge(L.status)}</td></tr>`).join(''); })()}
      </tbody></table></div>` : `<p class="box muted">No listings${st ? ` marked ${esc(st)}` : ''} yet. Add one to see a ranked list of likely buyers from sale-comp purchase history.</p>`}`, { active: 'listings' }));
  }));

  async function formHtml(L, action) {
    const tenants = await db.query('SELECT id, name FROM tenants ORDER BY name');
    const v = (k) => esc(L[k] ?? ''); const sel = (name, opts, cur) => `<select name="${name}"><option value="">—</option>${opts.map((o) => `<option${String(cur) === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    return `<form method="post" action="${action}" class="form grid">
      <label>Address *<input name="address" value="${v('address')}" required></label><label>City<input name="city" value="${v('city')}"></label>
      <label>State<input name="state" value="${v('state')}" maxlength="2" size="3"></label><label>ZIP<input name="zip" value="${v('zip')}" inputmode="numeric"></label>
      <label>Tenant<input name="tenant" value="${v('tenant')}" placeholder="e.g. practice or health system"></label>
      <label>Tenant group<select name="tenant_id"><option value="">—</option>${tenants.map((t) => `<option value="${t.id}"${String(L.tenant_id) === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label>Asking price<input name="asking_price" value="${v('asking_price')}" inputmode="numeric"></label>
      <label>Cap rate %<input name="cap_rate" value="${L.cap_rate ? esc((Number(L.cap_rate) * 100).toFixed(2)) : ''}" inputmode="decimal" placeholder="e.g. 6.75"></label>
      <label>NOI<input name="noi" value="${v('noi')}" inputmode="numeric"></label><label>SF<input name="sf" value="${v('sf')}" inputmode="numeric"></label>
      <label>Lease type${sel('lease_type', LEASE_TYPES, L.lease_type)}</label>
      <label>Lease expiration<input type="date" name="lease_expiration" value="${esc(isoDate(L.lease_expiration))}"></label>
      <label>Years remaining (if no expiration)<input name="years_remaining" value="${L.lease_expiration ? '' : v('years_remaining')}" inputmode="decimal"></label>
      <label>Status<select name="status">${STATUSES.map((s) => `<option${(L.status || 'Active') === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Linked property ID<input name="property_id" value="${v('property_id')}" inputmode="numeric" placeholder="auto-matched by address"></label>
      <label class="wide">Notes<textarea name="notes" rows="3">${v('notes')}</textarea></label>
      <div class="wide"><button>Save listing</button></div></form>`;
  }
  function fromBody(b) {
    const capIn = C.P.pct(b.cap_rate);
    return { address: nz(b.address), city: nz(b.city), state: C.P.state(b.state), zip: nz(b.zip), tenant: nz(b.tenant), tenant_id: parseInt(b.tenant_id) || null,
      asking_price: C.P.num(b.asking_price), cap_rate: capIn, noi: C.P.num(b.noi), sf: C.P.num(b.sf), lease_type: LEASE_TYPES.includes(b.lease_type) ? b.lease_type : null,
      lease_expiration: C.P.date(b.lease_expiration), years_remaining: C.P.date(b.lease_expiration) ? null : C.P.num(b.years_remaining),
      status: STATUSES.includes(b.status) ? b.status : 'Active', notes: nz(b.notes), property_id: parseInt(b.property_id) || null };
  }
  // Link to an existing CRM property by address; never creates a property.
  async function linkProperty(L) {
    if (L.property_id) { const [p] = await db.query('SELECT id FROM properties WHERE id=$1', [L.property_id]); if (!p) L.property_id = null; return L; }
    const idx = await C.propertyIndex(getDb()); const m = idx.match(L.address, L.city, L.state); if (m) L.property_id = m.id; return L;
  }
  const COLS = ['property_id', 'tenant_id', 'address', 'city', 'state', 'zip', 'tenant', 'asking_price', 'cap_rate', 'noi', 'sf', 'lease_type', 'lease_expiration', 'years_remaining', 'status', 'notes'];

  app.get('/listings/new', wrap(async (req, res) => {
    let L = { status: 'Active' }; const pid = parseInt(req.query.property_id) || 0;
    if (pid) { const [p] = await db.query('SELECT id, address, city, state, zip FROM properties WHERE id=$1', [pid]); if (p) L = { ...L, property_id: p.id, address: p.address, city: p.city, state: p.state, zip: p.zip }; }
    res.send(layout('New listing', `<p class="crumbs"><a href="/listings">Listings</a> ›</p><h1>New listing</h1>
      <p class="muted small">If the address matches a CRM property, the listing links to it. No new property is created.</p>${await formHtml(L, '/listings')}`, { active: 'listings' }));
  }));
  app.post('/listings', wrap(async (req, res) => {
    const L = await linkProperty(fromBody(req.body)); if (!L.address) return res.redirect('/listings/new');
    const [r] = await db.query(`INSERT INTO listings (${COLS.join(',')}) VALUES (${COLS.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, COLS.map((c) => L[c]));
    res.redirect('/listings/' + r.id);
  }));
  app.post('/listings/:id', wrap(async (req, res) => {
    const id = parseInt(req.params.id) || 0; const L = await linkProperty(fromBody(req.body)); if (!L.address) return res.redirect('/listings/' + id);
    await db.query(`UPDATE listings SET ${COLS.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...COLS.map((c) => L[c])]);
    res.redirect('/listings/' + id);
  }));
  app.post('/listings/:id/delete', wrap(async (req, res) => { await db.query('DELETE FROM listings WHERE id=$1', [parseInt(req.params.id) || 0]); res.redirect('/listings'); }));
  app.post('/listings/:id/attach', upload.single('file'), wrap(async (req, res) => {
    const id = parseInt(req.params.id) || 0; const [L] = await db.query('SELECT id FROM listings WHERE id=$1', [id]);
    if (!L) return res.status(404).send(layout('Not found', '<h1>Not found</h1>')); if (!req.file) return res.redirect('/listings/' + id);
    await Att.upsert(getDb(), { kind: 'listing', record_id: id, filename: req.file.originalname || 'OM.pdf', mime_type: req.file.mimetype || 'application/pdf', data: req.file.buffer });
    res.redirect('/listings/' + id);
  }));

  app.get('/listings/:id', wrap(async (req, res) => {
    const [L] = await db.query(`${listSel} WHERE l.id=$1`, [parseInt(req.params.id) || 0]);
    if (!L) return res.status(404).send(layout('Not found', '<h1>Listing not found</h1><p><a href="/listings">Back to listings</a></p>', { active: 'listings' }));
    await hydrate(L); const atts = await Att.listFor(getDb(), 'listing', L.id);
    const { total_buyers, ranked } = await B.likelyBuyers(db, L, { limit: 25 });
    const note = B.recommendation(L, ranked, total_buyers);
    const facts = [['Asking price', money(L.asking_price)], ['Cap rate', pct(L.cap_rate)], ['NOI', money(L.noi)], ['SF', numf(L.sf)], ['$/SF', L.asking_price && L.sf ? '$' + numf(L.asking_price / L.sf) : ''],
      ['Tenant', L.tenant], ['Tenant group', L.tenant_group], ['Lease type', L.lease_type], ['Lease expiration', fmtDate(L.lease_expiration)],
      ['Years remaining', L.years_remaining !== null ? yrs(L.years_remaining) + (L.years_source ? ` (from ${L.years_source})` : '') : '']].filter((x) => x[1]);
    const cell = (v, max) => `<td class="num">${v ? `<b>${v}</b>` : '<span class="muted">0</span>'}<span class="muted small">/${max}</span></td>`;
    res.send(layout(L.address, `<p class="crumbs"><a href="/listings">Listings</a> ›</p>
      <div class="ph"><div><h1>${esc(L.address)}</h1><p class="muted">${esc([L.city, L.state, L.zip].filter(Boolean).join(', '))}</p></div><div>${stBadge(L.status)}</div></div>
      ${L.property_id ? `<p>Linked property: <a href="/properties/${L.property_id}?from=listings${L.status ? '&lst=' + encodeURIComponent(L.status) : ''}&cb_at=0">${esc(L.prop_address)}</a></p>` : '<p class="muted small">Not linked to a CRM property (no address match).</p>'}
      ${atts.length ? `<p class="box" style="display:inline-block">${Att.linksHtml(atts)}</p>` : ''}
      <dl class="facts">${facts.map(([a, b]) => `<div><dt>${a}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>
      ${L.notes ? `<h2>Notes</h2><div class="pre box">${esc(L.notes)}</div>` : ''}
      <h2>Likely buyers</h2><p class="box">${esc(note)}</p>
      ${ranked.length ? `<div class="tblwrap"><table class="tbl comps"><thead><tr><th>#</th><th>Buyer</th><th class="num">Score</th><th class="num">Market</th><th class="num">Price</th><th class="num">Cap</th><th class="num">Lease</th><th class="num">Tenant</th><th class="num">Recent+Med</th><th>Last purchase</th><th>Contact</th><th>Why</th></tr></thead><tbody>
      ${ranked.map((r, i) => { const b = r.buyer; const l = b.last; return `<tr><td>${i + 1}</td><td><a href="/buyers/${b.id}"><b>${esc(b.display)}</b></a>${b.sub ? `<br><span class="small muted">${esc(b.sub)}</span>` : ''}</td>
        <td class="num"><b>${r.score}</b></td>${cell(r.parts.market, 30)}${cell(r.parts.price, 20)}${cell(r.parts.cap, 15)}${cell(r.parts.lease, 15)}${cell(r.parts.tenant, 15)}${cell(r.parts.recency + r.parts.medical, 10)}
        <td class="small">${l.property_id ? `<a href="/properties/${l.property_id}">${esc(l.address)}</a>` : `<a href="/comps/sales/${l.id}">${esc(l.address)}</a>`}<br>${esc(place(l))} · ${fmtDate(l.sale_date)}${l.price ? ' · ' + money(l.price) : ''}</td>
        <td class="small">${contactCell(b) || '<span class="muted">none on file</span>'}</td><td class="small">${esc(r.reasons.join('; '))}</td></tr>`; }).join('')}</tbody></table></div>`
        : `<p class="muted">${total_buyers ? 'No buyers score above the minimum for this listing yet.' : 'No buyers with purchase history yet.'}</p>`}
      <details class="box"><summary>Edit listing</summary>${await formHtml(L, '/listings/' + L.id)}
        <form method="post" action="/listings/${L.id}/attach" enctype="multipart/form-data" class="form" style="margin-top:1rem"><label>Attach OM (PDF)<input type="file" name="file" accept=".pdf,application/pdf" required></label><button>Upload</button></form>
        <form method="post" action="/listings/${L.id}/delete" onsubmit="return confirm('Delete this listing?')"><button class="danger">Delete listing</button></form></details>`, { active: 'listings' }));
  }));
};
