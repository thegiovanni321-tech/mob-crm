const express = require('express'); const path = require('path');
const { migrate } = require('./db');
const auth = require('./auth');
const V = require('./views');
const { esc, layout, propertyRows, filterForm, badge, fmtDate, isoDate, money, numf, pct, telHref, firstEmail, qs, STATUSES, OUTCOMES, STATE_NAMES } = V;
const TZ = process.env.TZ_NAME || 'America/New_York';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plusDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const nz = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s === '' ? null : s; };
const nnum = (v) => { const s = nz(v); if (s === null) return null; const n = Number(s.replace(/[$,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
const ndate = (v) => { const s = nz(v); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const STATE_CODES = new Set(Object.keys(STATE_NAMES));
const nstate = (v) => { const s = (nz(v) || '').toUpperCase(); if (STATE_CODES.has(s)) return s; const hit = Object.entries(STATE_NAMES).find(([, n]) => n.toUpperCase() === s); return hit ? hit[0] : null; };

let db;
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/healthz', (req, res) => res.send('ok'));
require('./sync-api')(app, () => db); // token-protected push API used by the box (no-op without SYNC_TOKEN)
app.get('/login', (req, res) => res.send(loginPage(req.query.next, req.query.e)));
app.post('/login', (req, res) => {
  const ip = req.ip; const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
  if (auth.rateLimited(ip)) return res.status(429).send(loginPage(next, 'Too many attempts. Try again in 15 minutes.'));
  if (!auth.checkPassword(req.body.password || '')) { auth.noteFail(ip); return res.status(401).send(loginPage(next, 'Wrong password.')); }
  auth.setSession(res, req.secure); res.redirect(next);
});
app.get('/logout', (req, res) => { auth.clearSession(res); res.redirect('/login'); });
app.use(auth.requireAuth);
const Calls = require('./calls');
// One DB hit per request: today's call count for the header (AsyncLocalStorage so layout() can read it).
app.use(async (req, res, next) => {
  let n = 0;
  try { n = await Calls.todayCount(db); } catch (e) { console.error('[calls] today count', e.message); }
  res.locals.callsToday = n;
  Calls.run({ callsToday: n }, () => next());
});
const Att = require('./attachments');
app.get('/files/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(404).send('Not found');
  const row = await Att.getWithData(db, id);
  if (!row) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
  const name = String(row.filename || 'file').replace(/[\r\n"]/g, '_');
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', row.size_bytes);
  res.setHeader('Content-Disposition', `inline; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  res.end(buf);
}));
// When .remote-sync.json exists (and no DATABASE_URL), this box copy is a read-only snapshot: the hosted app is live.
const REMOTE = require('./remote-sync').loadConfig();
if (REMOTE) {
  V.BANNER.html = `<div class="notlive" style="background:#b42318;color:#fff;padding:.6rem 1rem;font-weight:600">Not live: read-only snapshot on the box. Use the live CRM at <a style="color:#fff;text-decoration:underline" href="${esc(REMOTE.url)}">${esc(REMOTE.url.replace(/^https?:\/\//, ''))}</a>. Changes here are blocked.</div>`;
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.status(403).send(layout('Read-only', `<h1>This copy is read-only</h1><p>Edits made here would not reach the live CRM. Make this change at <a href="${esc(REMOTE.url + req.originalUrl)}">${esc(REMOTE.url)}</a>.</p>`));
  });
}

// ---------- shared queries ----------
// "New" badge: added in the last 7 days, and not part of the CRM's initial load (the first import batch)
const PROP_SELECT = `SELECT p.*, (p.callback_date IS NOT NULL AND p.callback_date <= $1::date) AS cb_due,
  (p.created_at > now() - interval '7 days' AND p.created_at > (SELECT min(created_at) + interval '1 hour' FROM properties)) AS is_new,
  (SELECT string_agg(DISTINCT o.name, ', ') FROM property_owners po JOIN owners o ON o.id=po.owner_id WHERE po.property_id=p.id) AS owner_names,
  (SELECT string_agg(DISTINCT o.entity, ', ') FROM property_owners po JOIN owners o ON o.id=po.owner_id WHERE po.property_id=p.id) AS entities,
  (SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM property_tenants pt JOIN tenants t ON t.id=pt.tenant_id WHERE pt.property_id=p.id) AS tenant_names
  FROM properties p`;
function buildFilter(f) {
  const where = ['$1::date IS NOT NULL']; const params = [today()]; // $1 = today (used by cb filters / cb_due)
  const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, '$' + params.length)); };
  if (f.state) { if (f.state === 'Unknown') where.push('p.state IS NULL'); else add('p.state = ?', f.state); }
  if (f.tenant) add('EXISTS (SELECT 1 FROM property_tenants pt WHERE pt.property_id=p.id AND pt.tenant_id = ?::int)', f.tenant);
  if (f.status) add('p.status = ?', f.status);
  if (f.cb === 'due') where.push('p.callback_date <= $1::date');
  if (f.cb === 'week') where.push("p.callback_date <= $1::date + 7");
  if (f.cb === 'any') where.push('p.callback_date IS NOT NULL');
  if (f.cb === 'none') where.push('p.callback_date IS NULL');
  if (f.owner) add('EXISTS (SELECT 1 FROM property_owners po WHERE po.property_id=p.id AND po.owner_id = ?::int)', f.owner);
  if (f.q) {
    const q = '%' + f.q.trim() + '%'; const digits = f.q.replace(/\D/g, '');
    params.push(q); const i = params.length;
    let phone = 'false';
    if (digits.length >= 4) { params.push('%' + digits + '%'); phone = `regexp_replace(concat_ws(' ',o.phone1,o.phone2,o.phone3,o.phone4,o.phone5),'\\D','','g') LIKE $${params.length}`; }
    where.push(`(p.address ILIKE $${i} OR p.city ILIKE $${i} OR p.zip ILIKE $${i} OR p.notes ILIKE $${i} OR p.tenancy ILIKE $${i}
      OR EXISTS (SELECT 1 FROM property_owners po JOIN owners o ON o.id=po.owner_id WHERE po.property_id=p.id AND
        (o.name ILIKE $${i} OR o.entity ILIKE $${i} OR o.email ILIKE $${i} OR o.mailing_address ILIKE $${i} OR ${phone}))
      OR EXISTS (SELECT 1 FROM property_tenants pt JOIN tenants t ON t.id=pt.tenant_id WHERE pt.property_id=p.id AND t.name ILIKE $${i}))`);
  }
  return { where: ' WHERE ' + where.join(' AND '), params };
}
const SORTS = { added: 'p.created_at DESC, p.state NULLS LAST, p.city, p.address, p.id DESC', addr: 'p.state NULLS LAST, p.city, p.address', cb: 'p.callback_date NULLS LAST, p.address', cbdesc: 'p.callback_date DESC NULLS LAST, p.address', recent: 'p.updated_at DESC', city: 'p.city, p.address' };
const sortLinks = (f, base, keep, addrKey = 'addr') => `<span class="sort small">Sort: ${[['added', 'Newest added'], [addrKey, addrKey === 'city' ? 'City/Address' : 'State/City'], ['cb', 'Callback'], ['recent', 'Recently updated']]
  .map(([k, l]) => `<a class="${(f.sort || 'added') === k ? 'on' : ''}" href="${base}${qs({ ...keep, sort: k, page: '' })}">${l}</a>`).join(' ')}</span>`;
async function listProps(f, limit = 200, offset = 0) {
  const { where, params } = buildFilter(f);
  const order = SORTS[f.sort] || SORTS.added; // default: newest added first (same-batch rows keep the State/City order)
  const [{ n }] = await db.query(`SELECT count(*)::int n FROM properties p${where}`, params);
  const rows = await db.query(`${PROP_SELECT}${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params);
  return { n, rows };
}
const stateCounts = () => db.query(`SELECT COALESCE(state,'Unknown') state, count(*)::int n FROM properties GROUP BY 1 ORDER BY 1`);
const tenantList = () => db.query('SELECT id, name FROM tenants ORDER BY name');
const pick = (q) => ({ q: nz(q.q) || '', state: nz(q.state) || '', tenant: nz(q.tenant) || '', status: nz(q.status) || '', cb: nz(q.cb) || '', sort: nz(q.sort) || '', owner: nz(q.owner) || '' });
function pager(n, page, per, base) {
  const pages = Math.ceil(n / per); if (pages <= 1) return '';
  const link = (p, l) => `<a class="btn ghost" href="${base}${base.includes('?') ? '&' : '?'}page=${p}">${l}</a>`;
  return `<div class="pager">${page > 1 ? link(page - 1, '‹ Prev') : ''}<span class="muted">Page ${page} of ${pages}</span>${page < pages ? link(page + 1, 'Next ›') : ''}</div>`;
}

// ---------- pages ----------
app.get('/', wrap(async (req, res) => {
  const t = today();
  const [c] = await db.query(`SELECT count(*)::int props, count(*) FILTER (WHERE callback_date <= $1::date)::int due,
    count(*) FILTER (WHERE callback_date BETWEEN $1::date + 1 AND $1::date + 7)::int week, count(*) FILTER (WHERE status='New')::int fresh,
    (SELECT count(*) FROM owners)::int owners, (SELECT count(*) FROM tenants)::int tenants FROM properties`, [t]);
  const states = await stateCounts();
  const recent = await db.query(`SELECT a.*, p.address, p.city, p.state, o.name owner_name FROM activities a JOIN properties p ON p.id=a.property_id
    LEFT JOIN owners o ON o.id=a.owner_id WHERE a.kind <> 'import' ORDER BY a.created_at DESC LIMIT 8`);
  res.send(layout('Home', `<h1>Dashboard</h1>
  <div class="cards">
    <a class="card" href="/properties"><b>${c.props}</b><span>Properties</span></a>
    <a class="card warn" href="/callbacks"><b>${c.due}</b><span>Callbacks due</span></a>
    <a class="card" href="/properties?cb=week"><b>${c.week}</b><span>Due next 7 days</span></a>
    <a class="card" href="/properties?status=New"><b>${c.fresh}</b><span>Never called</span></a>
    <a class="card" href="/owners"><b>${c.owners}</b><span>Owners</span></a>
    <a class="card" href="/tenants"><b>${c.tenants}</b><span>Tenants</span></a>
  </div>
  <div class="actions"><a class="btn" href="/properties/new">+ Add property</a> <a class="btn ghost" href="/owners/new">+ Add owner</a> <a class="btn ghost" href="/export.csv">Export CSV</a></div>
  <h2>Properties by state</h2>${stateGrid(states)}
  <h2>Recent activity</h2>${recent.length ? activityList(recent, true) : '<p class="muted">No calls logged in the app yet.</p>'}`, { active: 'home' }));
}));
function stateGrid(states) {
  return `<div class="states">${states.map((s) => `<a href="/states/${esc(s.state)}"><b>${esc(s.state)}</b><span>${esc(STATE_NAMES[s.state] || 'No state')}</span><em>${s.n}</em></a>`).join('')}</div>`;
}
app.get('/states', wrap(async (req, res) => {
  const states = await db.query(`SELECT COALESCE(state,'Unknown') state, count(*)::int n, count(*) FILTER (WHERE status <> 'New')::int worked,
    count(*) FILTER (WHERE callback_date <= $1::date)::int due FROM properties GROUP BY 1 ORDER BY n DESC, 1`, [today()]);
  res.send(layout('States', `<h1>Properties by state</h1><p class="muted">${states.length} states · ${states.reduce((a, s) => a + s.n, 0)} properties</p>
  <table class="tbl"><thead><tr><th>State</th><th class="num">Properties</th><th class="num">Contacted</th><th class="num">Callbacks due</th></tr></thead><tbody>
  ${states.map((s) => `<tr><td><a href="/states/${esc(s.state)}"><b>${esc(s.state)}</b> ${esc(STATE_NAMES[s.state] || '')}</a></td><td class="num">${s.n}</td><td class="num">${s.worked}</td><td class="num">${s.due ? `<a class="due" href="/properties?state=${esc(s.state)}&cb=due">${s.due}</a>` : 0}</td></tr>`).join('')}
  </tbody></table>`, { active: 'states' }));
}));
app.get('/states/:st', wrap(async (req, res) => {
  const st = req.params.st.toUpperCase() === 'UNKNOWN' ? 'Unknown' : req.params.st.toUpperCase();
  const f = { ...pick(req.query), state: st }; const page = Math.max(1, parseInt(req.query.page) || 1);
  const { n, rows } = await listProps(f, 200, (page - 1) * 200);
  const tenants = await db.query(`SELECT t.id, t.name, count(*)::int n FROM tenants t JOIN property_tenants pt ON pt.tenant_id=t.id JOIN properties p ON p.id=pt.property_id
    WHERE ${st === 'Unknown' ? 'p.state IS NULL' : 'p.state = $1'} GROUP BY t.id ORDER BY n DESC, t.name`, st === 'Unknown' ? [] : [st]);
  res.send(layout(st, `<p class="crumbs"><a href="/states">States</a> ›</p><h1>${esc(STATE_NAMES[st] || st)} <span class="muted">(${n})</span></h1>
  <details class="box"><summary>Tenants in ${esc(st)} (${tenants.length})</summary><div class="chips">${tenants.map((t) => `<a href="/states/${esc(st)}?tenant=${t.id}">${esc(t.name)} <em>${t.n}</em></a>`).join('')}</div></details>
  ${filterForm(f, await tenantList(), await stateCounts(), '/properties')}
  <p><a class="btn ghost small" href="/export.csv${qs({ ...f })}">Export these to CSV</a> ${sortLinks(f, '/states/' + encodeURIComponent(st), { ...f, state: '' }, 'city')}</p>
  ${propertyRows(rows, { showState: false })}${pager(n, page, 200, '/states/' + encodeURIComponent(st) + qs({ ...f, state: '' }))}`, { active: 'states' }));
}));
app.get('/tenants', wrap(async (req, res) => {
  const q = nz(req.query.q);
  const rows = await db.query(`SELECT t.id, t.name, count(pt.property_id)::int n, count(DISTINCT p.state)::int states,
    count(*) FILTER (WHERE p.status <> 'New')::int worked FROM tenants t LEFT JOIN property_tenants pt ON pt.tenant_id=t.id LEFT JOIN properties p ON p.id=pt.property_id
    ${q ? 'WHERE t.name ILIKE $1' : ''} GROUP BY t.id ORDER BY t.name`, q ? ['%' + q + '%'] : []);
  res.send(layout('Tenants', `<h1>Tenants <span class="muted">(${rows.length})</span></h1>
  <form class="filters" action="/tenants"><input type="search" name="q" value="${esc(q)}" placeholder="Filter tenants…"><button>Filter</button> <a class="btn ghost" href="/tenants/new">+ Add tenant</a></form>
  <table class="tbl"><thead><tr><th>Tenant group</th><th class="num">Properties</th><th class="num">States</th><th class="num">Contacted</th></tr></thead><tbody>
  ${rows.map((t) => `<tr><td><a href="/tenants/${t.id}">${esc(t.name)}</a></td><td class="num">${t.n}</td><td class="num">${t.states}</td><td class="num">${t.worked}</td></tr>`).join('')}</tbody></table>`, { active: 'tenants' }));
}));
app.get('/tenants/new', (req, res) => res.send(layout('New tenant', `<h1>New tenant</h1><form method="post" action="/tenants" class="form">
  <label>Name<input name="name" required></label><label>Notes<textarea name="notes" rows="3"></textarea></label><button>Create</button></form>`, { active: 'tenants' })));
app.post('/tenants', wrap(async (req, res) => {
  const name = nz(req.body.name); if (!name) return res.redirect('/tenants/new');
  const [t] = await db.query('INSERT INTO tenants (name, notes) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [name, nz(req.body.notes)]);
  res.redirect('/tenants/' + t.id);
}));
app.get('/tenants/:id', wrap(async (req, res) => {
  const [t] = await db.query('SELECT * FROM tenants WHERE id=$1', [parseInt(req.params.id) || 0]); if (!t) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
  const f = { ...pick(req.query), tenant: String(t.id) }; const { n, rows } = await listProps(f, 1000);
  const byState = await db.query(`SELECT COALESCE(p.state,'Unknown') state, count(*)::int n FROM property_tenants pt JOIN properties p ON p.id=pt.property_id WHERE pt.tenant_id=$1 GROUP BY 1 ORDER BY n DESC`, [t.id]);
  const tenancy = await db.query(`SELECT COALESCE(p.tenancy,'(blank)') tenancy, count(*)::int n FROM property_tenants pt JOIN properties p ON p.id=pt.property_id WHERE pt.tenant_id=$1 GROUP BY 1 ORDER BY n DESC`, [t.id]);
  res.send(layout(t.name, `<p class="crumbs"><a href="/tenants">Tenants</a> ›</p><h1>${esc(t.name)} <span class="muted">(${n})</span></h1>
  <div class="chips">${byState.map((s) => `<a href="/tenants/${t.id}?state=${esc(s.state)}">${esc(s.state)} <em>${s.n}</em></a>`).join('')}</div>
  <p class="muted small">Tenancy: ${tenancy.map((x) => `${esc(x.tenancy)} (${x.n})`).join(' · ')}</p>
  <details class="box"${t.notes ? ' open' : ''}><summary>Tenant notes</summary><form method="post" action="/tenants/${t.id}" class="form">
  <label>Name<input name="name" value="${esc(t.name)}" required></label><label>Notes<textarea name="notes" rows="3">${esc(t.notes)}</textarea></label><button>Save</button></form></details>
  <p><a class="btn ghost small" href="/export.csv?tenant=${t.id}">Export to CSV</a> <a class="btn ghost small" href="/properties/new?tenant=${t.id}">+ Add property for this tenant</a></p>
  ${propertyRows(rows)}`, { active: 'tenants' }));
}));
app.post('/tenants/:id', wrap(async (req, res) => {
  await db.query('UPDATE tenants SET name=COALESCE($2,name), notes=$3 WHERE id=$1', [parseInt(req.params.id), nz(req.body.name), nz(req.body.notes)]);
  res.redirect('/tenants/' + parseInt(req.params.id));
}));
app.get('/properties', wrap(async (req, res) => {
  const f = pick(req.query); const page = Math.max(1, parseInt(req.query.page) || 1);
  const { n, rows } = await listProps(f, 100, (page - 1) * 100);
  res.send(layout('Properties', `<h1>Properties <span class="muted">(${n})</span></h1>
  ${filterForm(f, await tenantList(), await stateCounts())}
  <p><a class="btn small" href="/properties/new">+ Add property</a> <a class="btn ghost small" href="/export.csv${qs(f)}">Export ${n} to CSV</a>
  ${sortLinks(f, '/properties', f)}</p>
  ${propertyRows(rows)}${pager(n, page, 100, '/properties' + qs(f))}`, { active: 'properties', q: f.q }));
}));
app.get('/search', wrap(async (req, res) => {
  const q = nz(req.query.q) || '';
  if (!q) return res.redirect('/properties');
  const { n, rows } = await listProps({ q }, 200);
  const digits = q.replace(/\D/g, ''); const like = '%' + q + '%';
  const owners = await db.query(`SELECT o.*, (SELECT count(*) FROM property_owners po WHERE po.owner_id=o.id)::int n FROM owners o
    WHERE o.name ILIKE $1 OR o.entity ILIKE $1 OR o.email ILIKE $1 ${digits.length >= 4 ? `OR regexp_replace(concat_ws(' ',phone1,phone2,phone3,phone4,phone5),'\\D','','g') LIKE $2` : ''}
    ORDER BY o.name LIMIT 50`, digits.length >= 4 ? [like, '%' + digits + '%'] : [like]);
  const tenants = await db.query('SELECT id, name FROM tenants WHERE name ILIKE $1 ORDER BY name LIMIT 20', [like]);
  res.send(layout('Search', `<h1>Results for “${esc(q)}”</h1>
  ${tenants.length ? `<h2>Tenants (${tenants.length})</h2><div class="chips">${tenants.map((t) => `<a href="/tenants/${t.id}">${esc(t.name)}</a>`).join('')}</div>` : ''}
  ${owners.length ? `<h2>Owners (${owners.length})</h2>${ownerRows(owners)}` : ''}
  <h2>Properties (${n})</h2>${propertyRows(rows)}`, { q }));
}));
function ownerRows(owners) {
  return `<div class="list">${owners.map((o) => `<a class="row" href="/owners/${o.id}"><div class="r-main"><strong>${esc(o.name || o.entity || 'Unnamed')}</strong><span class="muted">${esc(o.name ? o.entity : '')}</span></div>
  <div class="r-meta"><span>${esc(o.phone1 || '')}</span><span class="muted small">${esc(firstEmail(o.email))}</span></div><div class="r-side"><span class="small muted">${o.n} propert${o.n === 1 ? 'y' : 'ies'}</span></div></a>`).join('')}</div>`;
}
app.get('/callbacks', wrap(async (req, res) => {
  const t = today();
  const due = await listProps({ cb: 'due', sort: 'cbdesc' }, 2000);
  const soon = await db.query(`${PROP_SELECT} WHERE p.callback_date > $1::date AND p.callback_date <= $1::date + 14 ORDER BY p.callback_date`, [t]);
  res.send(layout('Callbacks', `<h1>Callbacks</h1><p class="muted">Today is ${fmtDate(t)} (${esc(TZ)}).</p>
  <h2>Due or overdue <span class="muted">(${due.n}, most recent first)</span></h2>${propertyRows(due.rows)}
  <h2>Next 14 days <span class="muted">(${soon.length})</span></h2>${propertyRows(soon)}`, { active: 'callbacks' }));
}));

// ---------- property detail / edit ----------
async function loadProperty(id) {
  const [p] = await db.query(`${PROP_SELECT} WHERE p.id=$2`, [today(), id]); if (!p) return null;
  p.owners = await db.query('SELECT o.* FROM property_owners po JOIN owners o ON o.id=po.owner_id WHERE po.property_id=$1 ORDER BY o.id', [id]);
  p.tenants = await db.query('SELECT t.* FROM property_tenants pt JOIN tenants t ON t.id=pt.tenant_id WHERE pt.property_id=$1 ORDER BY t.name', [id]);
  p.activities = await db.query(`SELECT a.*, o.name owner_name FROM activities a LEFT JOIN owners o ON o.id=a.owner_id WHERE a.property_id=$1
    ORDER BY a.activity_date DESC NULLS LAST, a.id DESC`, [id]);
  return p;
}
function ownerCard(o, pid) {
  const phones = [o.phone1, o.phone2, o.phone3, o.phone4, o.phone5].filter(Boolean);
  const em = firstEmail(o.email);
  const web = o.website ? (/^https?:/i.test(o.website) ? o.website : 'https://' + o.website) : '';
  return `<div class="owner"><div class="o-head"><a href="/owners/${o.id}"><strong>${esc(o.name || o.entity || 'Unnamed owner')}</strong></a>${o.age ? ` <span class="muted">· ${/^\d+$/.test(o.age) ? 'Age ' : ''}${esc(o.age)}</span>` : ''}</div>
  ${o.name && o.entity ? `<div class="muted small">${esc(o.entity)}</div>` : ''}
  <div class="phones">${phones.map((p) => `<a class="call" href="${telHref(p)}">📞 ${esc(p)}</a>`).join('') || '<span class="muted small">No phone on file</span>'}</div>
  ${em ? `<div><a href="mailto:${esc(em)}">✉️ ${esc(o.email)}</a></div>` : o.email ? `<div class="small">✉️ ${esc(o.email)}</div>` : ''}
  ${web ? `<div><a href="${esc(web)}" target="_blank" rel="noopener">🌐 ${esc(o.website)}</a></div>` : ''}
  ${o.mailing_address ? `<div class="small">📬 ${esc(o.mailing_address)}</div>` : ''}
  ${o.notes ? `<div class="small muted pre">${esc(o.notes)}</div>` : ''}
  ${pid ? `<div class="o-actions small"><a href="/owners/${o.id}/edit?back=/properties/${pid}">Edit</a> · <form method="post" action="/properties/${pid}/owners/${o.id}/unlink" class="inline" onsubmit="return confirm('Unlink this owner from the property?')"><button class="link">Unlink</button></form></div>` : ''}</div>`;
}
function activityList(acts, withProp = false) {
  return `<ul class="acts">${acts.map((a) => `<li class="k-${esc(a.kind)}"><div><b>${esc(a.outcome || (a.kind === 'note' ? 'Note' : a.kind))}</b>
  <span class="muted small">${a.activity_date ? fmtDate(a.activity_date) : a.kind === 'import' ? 'date not recorded' : ''}${a.owner_name ? ' · ' + esc(a.owner_name) : ''}${a.callback_date ? ' · callback ' + fmtDate(a.callback_date) : ''}</span></div>
  ${withProp ? `<div class="small"><a href="/properties/${a.property_id}">${esc(a.address)}, ${esc(a.city || '')} ${esc(a.state || '')}</a></div>` : ''}
  ${a.notes ? `<div class="pre small">${esc(a.notes)}</div>` : ''}</li>`).join('')}</ul>`;
}
app.get('/properties/new', wrap(async (req, res) => {
  res.send(layout('New property', `<h1>New property</h1>${propertyForm({ status: 'New' }, await tenantList(), '/properties', req.query.tenant ? [String(req.query.tenant)] : [])}`, { active: 'properties' }));
}));
function propertyForm(p, tenants, action, selTenants = [], withOwner = true) {
  const v = (k) => esc(p[k]); const sel = new Set(selTenants.map(String));
  return `<form method="post" action="${action}" class="form grid">
  <label class="wide">Building address<input name="address" value="${v('address')}" required></label>
  <label>City<input name="city" value="${v('city')}"></label>
  <label>State<input name="state" value="${esc(p.state || p.state_raw || '')}" maxlength="20" placeholder="FL"></label>
  <label>Zip<input name="zip" value="${v('zip')}" inputmode="numeric"></label>
  <label>Tenancy<input name="tenancy" value="${v('tenancy')}" list="tenancies" placeholder="Single Tenant / Multi Tenant…"></label>
  <datalist id="tenancies"><option>Single Tenant</option><option>Small Multi</option><option>Multi Tenant</option><option>Condo</option></datalist>
  <label>Status<select name="status">${STATUSES.map((s) => `<option${p.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
  <label>Callback date<input type="date" name="callback_date" value="${isoDate(p.callback_date)}"></label>
  <label>RBA (sf)<input name="rba" value="${v('rba')}" inputmode="decimal"></label>
  <label>Acres<input name="acres" value="${v('acres')}" inputmode="decimal"></label>
  <label>Year built<input name="year_built" value="${v('year_built')}"></label>
  <label>Sale date<input type="date" name="sale_date" value="${isoDate(p.sale_date)}"></label>
  <label>Price<input name="price" value="${v('price')}" inputmode="decimal"></label>
  <label>Cap rate (e.g. 0.065)<input name="cap_rate" value="${v('cap_rate')}" inputmode="decimal"></label>
  <label class="wide">Tenants (tenant groups)<select name="tenants" multiple size="6">${tenants.map((t) => `<option value="${t.id}"${sel.has(String(t.id)) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
  <span class="muted small">Ctrl/Cmd-click to select several.</span></label>
  <label class="wide">New tenant group (optional)<input name="new_tenant" placeholder="Creates it if it doesn't exist"></label>
  <label class="wide">Notes<textarea name="notes" rows="4">${v('notes')}</textarea></label>
  ${withOwner ? `<fieldset class="wide"><legend>Owner (optional)</legend><div class="grid">
  <label>Owner name<input name="o_name"></label><label>Entity<input name="o_entity"></label><label>Phone<input name="o_phone1" type="tel"></label><label>Email<input name="o_email" type="email"></label></div></fieldset>` : ''}
  <div class="wide"><button>Save</button></div></form>`;
}
function propValues(b) {
  const stRaw = nz(b.state); const st = stRaw ? nstate(stRaw) : null;
  return [nz(b.address), nz(b.city), st, st ? null : stRaw, nz(b.zip), nz(b.tenancy), nnum(b.rba), nnum(b.acres), nz(b.year_built), ndate(b.sale_date), nnum(b.price), nnum(b.cap_rate), nz(b.notes), STATUSES.includes(b.status) ? b.status : 'New', ndate(b.callback_date)];
}
async function setTenants(t, pid, b) {
  const ids = [].concat(b.tenants || []).map((x) => parseInt(x)).filter(Boolean);
  if (nz(b.new_tenant)) { const [r] = await t.query('INSERT INTO tenants (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [nz(b.new_tenant)]); ids.push(r.id); }
  await t.query('DELETE FROM property_tenants WHERE property_id=$1', [pid]);
  for (const id of new Set(ids)) await t.query('INSERT INTO property_tenants VALUES ($1,$2) ON CONFLICT DO NOTHING', [pid, id]);
}
app.post('/properties', wrap(async (req, res) => {
  const b = req.body; if (!nz(b.address)) return res.redirect('/properties/new');
  const id = await db.tx(async (t) => {
    const [p] = await t.query(`INSERT INTO properties (address, city, state, state_raw, zip, tenancy, rba, acres, year_built, sale_date, price, cap_rate, notes, status, callback_date, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Added in app') RETURNING id`, propValues(b));
    await setTenants(t, p.id, b);
    await saveCoords(t, p.id, b);
    if (nz(b.o_name) || nz(b.o_entity)) {
      const [o] = await t.query('INSERT INTO owners (name, entity, phone1, email) VALUES ($1,$2,$3,$4) RETURNING id', [nz(b.o_name), nz(b.o_entity), nz(b.o_phone1), nz(b.o_email)]);
      await t.query('INSERT INTO property_owners VALUES ($1,$2)', [p.id, o.id]);
    }
    return p.id;
  });
  res.redirect('/properties/' + id);
}));
app.get('/properties/:id', wrap(async (req, res) => {
  const p = await loadProperty(parseInt(req.params.id) || 0); if (!p) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
  const facts = [['Tenancy', p.tenancy], ['RBA', p.rba ? numf(p.rba) + ' sf' : ''], ['Acres', numf(p.acres, 2)], ['Year built', p.year_built], ['Sale date', fmtDate(p.sale_date)], ['Price', money(p.price)], ['Cap rate', pct(p.cap_rate)], ['Last contacted', fmtDate(p.last_contacted)]].filter((x) => x[1]);
  const mapQ = encodeURIComponent([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '));
  p._openComp = req.query.logcomp === '1'; const compsHtml = await comps.compsPanel(p);
  const compSaved = req.query.comp === 'sale' || req.query.comp === 'lease' ? `<p class="box ok">${req.query.comp === 'sale' ? 'Sale' : 'Lease'} comp saved.</p>` : '';
  res.send(layout(p.address, `<p class="crumbs"><a href="/states/${esc(p.state || 'Unknown')}">${esc(p.state || p.state_raw || 'Unknown state')}</a> ›</p>
  <div class="ph"><div><h1>${esc(p.address)}</h1><p class="muted">${esc([p.city, p.state || p.state_raw, p.zip].filter(Boolean).join(', '))} · <a href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener">Map</a></p></div>
  <div>${badge(p.status)} ${p.callback_date ? `<span class="${p.cb_due ? 'due' : 'muted'}">Callback ${fmtDate(p.callback_date)}</span>` : ''}</div></div>
  <div class="chips">${p.tenants.map((t) => `<a href="/tenants/${t.id}">${esc(t.name)}</a>`).join('')}</div>
  ${compSaved}<p class="actions"><a class="btn small" href="/properties/${p.id}?logcomp=1#comps">+ Log comp</a> <a class="btn ghost small" href="#comps">Comps</a></p>
  <div class="cols"><section>
   <h2>Owner contacts</h2>${p.owners.map((o) => ownerCard(o, p.id)).join('') || '<p class="muted">No owner linked.</p>'}
   <details class="box"><summary>+ Add / link owner</summary>
    <form method="post" action="/properties/${p.id}/owners" class="form grid">
     <label class="wide">Link existing owner — search by name/entity/phone<input name="existing_q" placeholder="e.g. Smith or 813555"></label>
     <p class="wide muted small">…or create a new owner:</p>
     <label>Owner name<input name="name"></label><label>Entity<input name="entity"></label><label>Age<input name="age"></label>
     <label>Phone 1<input name="phone1" type="tel"></label><label>Phone 2<input name="phone2" type="tel"></label><label>Email<input name="email"></label>
     <label class="wide">Mailing address<input name="mailing_address"></label><div class="wide"><button>Add owner</button></div></form></details>
  </section><section>
   <h2>Log a call</h2>
   <form method="post" action="/properties/${p.id}/activities" class="form grid logcall">
    <input type="hidden" name="kind" value="call">
    <label>Outcome<select name="outcome">${OUTCOMES.map((o) => `<option>${o}</option>`).join('')}</select></label>
    <label>Date<input type="date" name="activity_date" value="${today()}"></label>
    <label>Contact<select name="owner_id"><option value="">—</option>${p.owners.map((o) => `<option value="${o.id}">${esc(o.name || o.entity)}</option>`).join('')}</select></label>
    <label>Callback date<input type="date" name="callback_date"></label>
    <label class="wide">Notes<textarea name="notes" rows="3" placeholder="What did they say?"></textarea></label>
    <label class="wide chk"><input type="checkbox" name="clear_cb" value="1"> Clear existing callback</label>
    <label class="wide chk"><input type="checkbox" name="log_comp" value="1"> They shared rent or sale numbers — log a comp next</label>
    <div class="wide"><button>Save call</button></div></form>
   <details class="box"><summary>+ Add a note</summary><form method="post" action="/properties/${p.id}/activities" class="form"><input type="hidden" name="kind" value="note">
    <textarea name="notes" rows="3" required></textarea><button>Save note</button></form></details>
   <h2>Activity</h2>${p.activities.length ? activityList(p.activities) : '<p class="muted">No activity yet.</p>'}
  </section></div>
  ${compsHtml}
  <h2>Property details</h2><dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('') || '<p class="muted">No details.</p>'}</dl>
  ${p.notes ? `<h2>Notes</h2><div class="pre box">${esc(p.notes)}</div>` : ''}
  <p class="muted small">Source: ${esc(p.source || '')}</p>
  <p><a class="btn ghost" href="/properties/${p.id}/edit">Edit property</a></p>
  ${await comps.areaCompsPanel(p)}`, { active: 'properties' }));
}));
app.get('/properties/:id/edit', wrap(async (req, res) => {
  const p = await loadProperty(parseInt(req.params.id) || 0); if (!p) return res.status(404).send('Not found');
  res.send(layout('Edit ' + p.address, `<p class="crumbs"><a href="/properties/${p.id}">${esc(p.address)}</a> ›</p><h1>Edit property</h1>
  ${propertyForm(p, await tenantList(), `/properties/${p.id}`, p.tenants.map((t) => t.id), false)}
  <form method="post" action="/properties/${p.id}/delete" onsubmit="return confirm('Delete this property and its activity log? This cannot be undone.')"><button class="danger">Delete property</button></form>`, { active: 'properties' }));
}));
app.post('/properties/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  await db.tx(async (t) => {
    await t.query(`UPDATE properties SET address=COALESCE($1,address), city=$2, state=$3, state_raw=$4, zip=$5, tenancy=$6, rba=$7, acres=$8, year_built=$9, sale_date=$10,
      price=$11, cap_rate=$12, notes=$13, status=$14, callback_date=$15, updated_at=now() WHERE id=$16`, [...propValues(req.body), id]);
    await setTenants(t, id, req.body);
    await saveCoords(t, id, req.body);
  });
  res.redirect('/properties/' + id);
}));
function saveCoords(t, id, b) {
  if (!b || (!Object.prototype.hasOwnProperty.call(b, 'lat') && !Object.prototype.hasOwnProperty.call(b, 'lng'))) return null;
  const lat = b.lat === '' || b.lat === undefined ? null : nnum(b.lat);
  const lng = b.lng === '' || b.lng === undefined ? null : nnum(b.lng);
  return t.query('UPDATE properties SET lat=$2, lng=$3 WHERE id=$1', [id, lat, lng]);
}
app.post('/properties/:id/delete', wrap(async (req, res) => { await db.query('DELETE FROM properties WHERE id=$1', [parseInt(req.params.id)]); res.redirect('/properties'); }));
const STATUS_FROM_OUTCOME = { Talked: 'Talked', Interested: 'Interested', 'Not interested': 'Not interested', 'Do not call': 'Do not call' };
app.post('/properties/:id/activities', wrap(async (req, res) => {
  const id = parseInt(req.params.id); const b = req.body;
  const kind = b.kind === 'note' ? 'note' : 'call';
  const outcome = kind === 'call' ? (OUTCOMES.includes(b.outcome) ? b.outcome : 'No answer') : null;
  const date = ndate(b.activity_date) || today(); const cb = kind === 'call' ? ndate(b.callback_date) : null;
  await db.tx(async (t) => {
    await t.query('INSERT INTO activities (property_id, owner_id, kind, outcome, notes, activity_date, callback_date) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, parseInt(b.owner_id) || null, kind, outcome, nz(b.notes), date, cb]);
    if (kind === 'call') {
      const newStatus = STATUS_FROM_OUTCOME[outcome];
      await t.query(`UPDATE properties SET last_contacted = GREATEST(COALESCE(last_contacted, $2::date), $2::date),
        status = CASE WHEN $3::text IS NOT NULL THEN $3::text WHEN status='New' THEN 'Attempted' ELSE status END,
        callback_date = CASE WHEN $4::date IS NOT NULL THEN $4::date WHEN $5 THEN NULL ELSE callback_date END, updated_at=now() WHERE id=$1`,
        [id, date, newStatus || null, cb, b.clear_cb === '1']);
    } else await t.query('UPDATE properties SET updated_at=now() WHERE id=$1', [id]);
  });
  if (kind === 'call' && b.log_comp === '1') return res.redirect(`/comps/log?property_id=${id}&from=call`);
  res.redirect('/properties/' + id);
}));
app.post('/properties/:id/owners', wrap(async (req, res) => {
  const id = parseInt(req.params.id); const b = req.body;
  if (nz(b.existing_q) && !nz(b.name) && !nz(b.entity)) return res.redirect(`/properties/${id}/link-owner?q=${encodeURIComponent(b.existing_q)}`);
  if (!nz(b.name) && !nz(b.entity)) return res.redirect('/properties/' + id);
  await db.tx(async (t) => {
    const [o] = await t.query('INSERT INTO owners (name, entity, age, phone1, phone2, email, mailing_address) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [nz(b.name), nz(b.entity), nz(b.age), nz(b.phone1), nz(b.phone2), nz(b.email), nz(b.mailing_address)]);
    await t.query('INSERT INTO property_owners VALUES ($1,$2)', [id, o.id]);
  });
  res.redirect('/properties/' + id);
}));
app.get('/properties/:id/link-owner', wrap(async (req, res) => {
  const id = parseInt(req.params.id); const q = nz(req.query.q) || ''; const digits = q.replace(/\D/g, '');
  const owners = await db.query(`SELECT o.*, 0 n FROM owners o WHERE o.name ILIKE $1 OR o.entity ILIKE $1 ${digits.length >= 4 ? `OR regexp_replace(concat_ws(' ',phone1,phone2,phone3,phone4,phone5),'\\D','','g') LIKE $2` : ''} ORDER BY o.name LIMIT 50`,
    digits.length >= 4 ? ['%' + q + '%', '%' + digits + '%'] : ['%' + q + '%']);
  res.send(layout('Link owner', `<p class="crumbs"><a href="/properties/${id}">Back to property</a></p><h1>Link an existing owner</h1><p class="muted">Matches for “${esc(q)}”</p>
  <ul class="acts">${owners.map((o) => `<li><form method="post" action="/properties/${id}/owners/${o.id}/link" class="inline"><button>Link</button></form> <b>${esc(o.name || '')}</b> <span class="muted">${esc(o.entity || '')} ${esc(o.phone1 || '')}</span></li>`).join('') || '<li class="muted">No matches.</li>'}</ul>`));
}));
app.post('/properties/:id/owners/:oid/link', wrap(async (req, res) => { await db.query('INSERT INTO property_owners VALUES ($1,$2) ON CONFLICT DO NOTHING', [parseInt(req.params.id), parseInt(req.params.oid)]); res.redirect('/properties/' + parseInt(req.params.id)); }));
app.post('/properties/:id/owners/:oid/unlink', wrap(async (req, res) => { await db.query('DELETE FROM property_owners WHERE property_id=$1 AND owner_id=$2', [parseInt(req.params.id), parseInt(req.params.oid)]); res.redirect('/properties/' + parseInt(req.params.id)); }));

// ---------- owners ----------
app.get('/owners', wrap(async (req, res) => {
  const q = nz(req.query.q) || ''; const page = Math.max(1, parseInt(req.query.page) || 1); const like = '%' + q + '%'; const digits = q.replace(/\D/g, '');
  const where = q ? `WHERE o.name ILIKE $1 OR o.entity ILIKE $1 OR o.email ILIKE $1 ${digits.length >= 4 ? `OR regexp_replace(concat_ws(' ',phone1,phone2,phone3,phone4,phone5),'\\D','','g') LIKE $2` : ''}` : '';
  const params = q ? (digits.length >= 4 ? [like, '%' + digits + '%'] : [like]) : [];
  const [{ n }] = await db.query(`SELECT count(*)::int n FROM owners o ${where}`, params);
  const owners = await db.query(`SELECT o.*, (SELECT count(*) FROM property_owners po WHERE po.owner_id=o.id)::int n FROM owners o ${where} ORDER BY COALESCE(o.name, o.entity) LIMIT 100 OFFSET ${(page - 1) * 100}`, params);
  res.send(layout('Owners', `<h1>Owners <span class="muted">(${n})</span></h1>
  <form class="filters" action="/owners"><input type="search" name="q" value="${esc(q)}" placeholder="Name, entity, email, phone…"><button>Search</button> <a class="btn ghost" href="/owners/new">+ Add owner</a></form>
  ${ownerRows(owners)}${pager(n, page, 100, '/owners' + qs({ q }))}`, { active: 'owners' }));
}));
function ownerForm(o, action, back) {
  const v = (k) => esc(o[k]);
  return `<form method="post" action="${action}" class="form grid"><input type="hidden" name="back" value="${esc(back || '')}">
  <label>Owner name<input name="name" value="${v('name')}"></label><label>Entity (owner of record)<input name="entity" value="${v('entity')}"></label><label>Age<input name="age" value="${v('age')}"></label>
  ${[1, 2, 3, 4, 5].map((i) => `<label>Phone ${i}<input type="tel" name="phone${i}" value="${v('phone' + i)}"></label>`).join('')}
  <label>Email<input name="email" value="${v('email')}"></label><label>Website<input name="website" value="${v('website')}"></label>
  <label class="wide">Owner mailing address<input name="mailing_address" value="${v('mailing_address')}"></label>
  <label class="wide">Notes<textarea name="notes" rows="3">${v('notes')}</textarea></label><div class="wide"><button>Save</button></div></form>`;
}
const ownerVals = (b) => [nz(b.name), nz(b.entity), nz(b.age), nz(b.phone1), nz(b.phone2), nz(b.phone3), nz(b.phone4), nz(b.phone5), nz(b.email), nz(b.website), nz(b.mailing_address), nz(b.notes)];
const safeBack = (b) => (typeof b === 'string' && /^\/[a-z]/.test(b) ? b : null);
app.get('/owners/new', (req, res) => res.send(layout('New owner', `<h1>New owner</h1>${ownerForm({}, '/owners')}`, { active: 'owners' })));
app.post('/owners', wrap(async (req, res) => {
  const [o] = await db.query('INSERT INTO owners (name, entity, age, phone1, phone2, phone3, phone4, phone5, email, website, mailing_address, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id', ownerVals(req.body));
  res.redirect('/owners/' + o.id);
}));
app.get('/owners/:id', wrap(async (req, res) => {
  const [o] = await db.query('SELECT * FROM owners WHERE id=$1', [parseInt(req.params.id) || 0]); if (!o) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
  const { rows } = await listProps({ owner: String(o.id) }, 500);
  const acts = await db.query('SELECT a.*, p.address, p.city, p.state, $2::text owner_name FROM activities a JOIN properties p ON p.id=a.property_id WHERE a.owner_id=$1 ORDER BY a.activity_date DESC NULLS LAST, a.id DESC LIMIT 50', [o.id, o.name]);
  res.send(layout(o.name || o.entity || 'Owner', `<p class="crumbs"><a href="/owners">Owners</a> ›</p>
  <div class="cols"><section>${ownerCard(o, 0)}<p><a class="btn ghost" href="/owners/${o.id}/edit">Edit owner</a></p></section>
  <section><h2>Properties (${rows.length})</h2>${propertyRows(rows)}<h2>Calls with this contact</h2>${acts.length ? activityList(acts, true) : '<p class="muted">None yet.</p>'}</section></div>`, { active: 'owners' }));
}));
app.get('/owners/:id/edit', wrap(async (req, res) => {
  const [o] = await db.query('SELECT * FROM owners WHERE id=$1', [parseInt(req.params.id) || 0]); if (!o) return res.status(404).send('Not found');
  res.send(layout('Edit owner', `<h1>Edit owner</h1>${ownerForm(o, '/owners/' + o.id, safeBack(req.query.back))}
  <form method="post" action="/owners/${o.id}/delete" onsubmit="return confirm('Delete this owner? Their properties stay.')"><button class="danger">Delete owner</button></form>`, { active: 'owners' }));
}));
app.post('/owners/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  await db.query('UPDATE owners SET name=$1, entity=$2, age=$3, phone1=$4, phone2=$5, phone3=$6, phone4=$7, phone5=$8, email=$9, website=$10, mailing_address=$11, notes=$12, updated_at=now() WHERE id=$13', [...ownerVals(req.body), id]);
  res.redirect(safeBack(req.body.back) || '/owners/' + id);
}));
app.post('/owners/:id/delete', wrap(async (req, res) => { await db.query('DELETE FROM owners WHERE id=$1', [parseInt(req.params.id)]); res.redirect('/owners'); }));

// ---------- counts (used by scripts/verify.py) ----------
app.get('/api/counts', wrap(async (req, res) => {
  const st = await db.query(`SELECT COALESCE(state,'Unknown') k, count(*)::int n FROM properties GROUP BY 1`);
  const te = await db.query(`SELECT t.name k, count(pt.property_id)::int n FROM tenants t LEFT JOIN property_tenants pt ON pt.tenant_id=t.id GROUP BY t.name`);
  const [tot] = await db.query(`SELECT (SELECT count(*) FROM properties)::int p, (SELECT count(*) FROM owners)::int o, (SELECT count(*) FROM tenants)::int t, (SELECT count(*) FROM activities)::int a, (SELECT count(*) FROM property_owners)::int po`);
  res.json({ state: Object.fromEntries(st.map((r) => [r.k, r.n])), tenant: Object.fromEntries(te.map((r) => [r.k, r.n])), totals: tot });
}));

// ---------- CSV export ----------
app.get('/export.csv', wrap(async (req, res) => {
  const f = pick(req.query); const { where, params } = buildFilter(f);
  const rows = await db.query(`SELECT p.id, (SELECT string_agg(t.name, '; ' ORDER BY t.name) FROM property_tenants pt JOIN tenants t ON t.id=pt.tenant_id WHERE pt.property_id=p.id) tenants,
    p.tenancy, p.address, p.city, COALESCE(p.state, p.state_raw) state, p.zip, p.status, p.last_contacted, p.callback_date,
    o.entity, o.name owner, o.age, o.phone1, o.phone2, o.phone3, o.phone4, o.phone5, o.email, o.website, o.mailing_address,
    p.cap_rate, p.sale_date, p.price, p.rba, p.acres, p.year_built, p.notes
    FROM properties p LEFT JOIN property_owners po ON po.property_id=p.id LEFT JOIN owners o ON o.id=po.owner_id ${where}
    ORDER BY p.state NULLS LAST, p.city, p.address, o.id`, params);
  const cols = ['id', 'tenants', 'tenancy', 'address', 'city', 'state', 'zip', 'status', 'last_contacted', 'callback_date', 'entity', 'owner', 'age', 'phone1', 'phone2', 'phone3', 'phone4', 'phone5', 'email', 'website', 'mailing_address', 'cap_rate', 'sale_date', 'price', 'rba', 'acres', 'year_built', 'notes'];
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="crm-export-${today()}.csv"`);
  res.send('\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n'));
}));


app.get('/calls', wrap(async (req, res) => {
  const days = [30, 90, 365].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 90;
  const series = await Calls.dailyCounts(db, days);
  const total = series.reduce((a, r) => a + r.n, 0);
  const todayN = typeof res.locals.callsToday === 'number' ? res.locals.callsToday : await Calls.todayCount(db);
  const ranges = [30, 90, 365].map((d) => `<a href="/calls?days=${d}" class="${d === days ? 'on' : ''}">${d} days</a>`).join(' · ');
  res.send(layout('Call activity', `<h1>Call activity</h1>
  <p class="muted">Voicemails, texts, and conversations count; no-answers and wrong numbers do not. Days are Eastern Time (${esc(Calls.TZ)}).</p>
  <p class="calls-ranges">${ranges}</p>
  <p><b>${esc(Calls.label(todayN))}</b> · <b>${total.toLocaleString('en-US')}</b> in the last ${days} days</p>
  <div class="calls-chart">${Calls.svgChart(series)}</div>
  <details class="box" style="margin-top:1rem"><summary>Daily totals</summary>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Date</th><th class="num">Calls</th></tr></thead>
    <tbody>${[...series].reverse().filter((r) => r.n > 0).slice(0, 60).map((r) => `<tr><td>${esc(fmtDate(r.d))}</td><td class="num">${r.n}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No calls in this range</td></tr>'}</tbody></table></div>
  </details>`, { active: '' }));
}));

const comps = require('./comps-routes')(app, () => db, wrap);
require('./buyers-routes')(app, () => db, wrap);

app.use((err, req, res, next) => { console.error(err); res.status(500).send(layout('Error', `<h1>Something went wrong</h1><p class="muted">${esc(err.message)}</p>`)); });

function loginPage(next, err) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign in · MOB CRM</title><link rel="stylesheet" href="/static/style.css"></head>
  <body class="login"><form method="post" action="/login" class="form card-login"><h1>MOB CRM</h1><p class="muted">Medical office building owner prospects</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}<input type="hidden" name="next" value="${esc(next || '/')}">
  <label>Password<input type="password" name="password" autofocus required autocomplete="current-password"></label><button>Sign in</button></form></body></html>`;
}

const PORT = process.env.PORT || 3000;
migrate().then(async (d) => {
  db = d; await d.exec(require('./general-sync').SCHEMA);
  app.listen(PORT, () => console.log(`MOB CRM on http://localhost:${PORT} (db: ${d.kind})`));
  const log = (m) => console.log(new Date().toISOString(), m);
  d.query(`SELECT (SELECT count(*)::int FROM properties) properties, (SELECT count(*)::int FROM sale_comps) sales,
    (SELECT count(*)::int FROM lease_comps) leases, (SELECT count(*)::int FROM buyers) buyers`)
    .then(([c]) => log('[baseline] ' + JSON.stringify(c)))
    .catch((e) => log('[baseline] count failed: ' + e.message));
  if (!REMOTE) require('./buyers').syncBuyers(d).then((r) => log('[buyers] ' + JSON.stringify(r))).catch((e) => log('[buyers] sync failed: ' + e.message));
  if (REMOTE) require('./remote-sync').startRemoteWorker(REMOTE, { log }); // push deltas/workbook to the hosted app instead of importing locally
  else if (process.env.DELTA_WATCH !== '0') require('./general-sync').startWatcher(() => db, { log });
})
  .catch((e) => { console.error(e); process.exit(1); });
