const esc = (v) => (v === null || v === undefined ? '' : String(v)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = ['New', 'Attempted', 'Talked', 'Interested', 'Not interested', 'Do not call', 'Listing / Client'];
const OUTCOMES = ['No answer', 'Left voicemail', 'Texted', 'Talked', 'Interested', 'Not interested', 'Wrong number', 'Do not call'];
const STATE_NAMES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',PR:'Puerto Rico',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
const fmtDate = (d) => { if (!d) return ''; const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); const [y, m, dd] = s.split('-'); return `${m}/${dd}/${y}`; };
const isoDate = (d) => (!d ? '' : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const money = (n) => (n === null || n === undefined || n === '' ? '' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const numf = (n, dp = 0) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: dp }));
const pct = (n) => (n === null || n === undefined || n === '' ? '' : (Number(n) * 100).toFixed(2) + '%');
const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
const firstEmail = (e) => String(e || '').split(/[;,\s]+/).find((x) => /@.+\./.test(x)) || '';
const statusClass = (s) => 's-' + String(s || 'New').toLowerCase().replace(/[^a-z]+/g, '-');
const badge = (s) => `<span class="badge ${statusClass(s)}">${esc(s || 'New')}</span>`;
const qs = (obj) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') u.set(k, v); const s = u.toString(); return s ? '?' + s : ''; };

const BANNER = { html: '' }; // set by server.js when this copy is not the live one
function layout(title, body, opts = {}) {
  const { active = '', q = '', callsToday } = opts;
  const calls = require('./calls');
  const todayN = typeof callsToday === 'number' ? callsToday : calls.get().callsToday;
  const leadsN = calls.get().leadsCount;
  const leadsLabel = typeof leadsN === 'number' ? `Leads (${leadsN})` : 'Leads';
  const nav = [['/', 'Home', 'home'], ['/states', 'States', 'states'], ['/tenants', 'Tenants', 'tenants'], ['/properties', 'Properties', 'properties'], ['/owners', 'Owners', 'owners'], ['/callbacks', 'Callbacks', 'callbacks'], ['/leads', leadsLabel, 'leads'], ['/comps', 'Comps', 'comps'], ['/buyers', 'Buyers', 'buyers'], ['/listings', 'Listings', 'listings']];
  const callsLink = typeof todayN === 'number'
    ? `<a class="calls-today" href="/calls" title="Logged calls today, Eastern Time">${esc(calls.label(todayN))}</a>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0f3d5e"><title>${esc(title)} · MOB CRM</title>
<link rel="stylesheet" href="/static/style.css"></head><body>
<div class="sticky"><header class="top"><a class="brand" href="/">MOB CRM</a>
<form class="search" action="/search" method="get"><input type="search" name="q" value="${esc(q)}" placeholder="Search address, owner, entity, city, phone…" aria-label="Search"></form>
${callsLink}<a class="logout" href="/logout">Log out</a></header>
<nav class="tabs">${nav.map(([h, l, k]) => `<a href="${h}" class="${active === k ? 'on' : ''}">${l}</a>`).join('')}</nav></div>
${BANNER.html}<main>${body}</main><script src="/static/call-date.js"></script></body></html>`;
}
function newBadge(p) {
  return p && p.is_new ? ' <span class="badge new" title="Added in the last 7 days and not yet called">New</span>' : '';
}
function leadBadge(p) {
  if (!p || p.lead_at == null || String(p.lead_at).trim() === '') return '';
  return ' <span class="badge lead" title="Owner confirmed initial interest in selling">Lead</span>';
}
function propertyRows(rows, { showState = true, list = null } = {}) {
  if (!rows.length) return '<p class="muted">No properties match.</p>';
  return `<div class="list">${rows.map((p, i) => {
    const extra = list && list.from === 'leads' ? { ld_at: i } : (list && list.from ? { cb_at: i } : null);
    const q = list ? qs(extra ? { ...list, ...extra } : list) : '';
    return `<a class="row" id="p-${p.id}" href="/properties/${p.id}${q}">
  <div class="r-main"><strong>${esc(p.address)}</strong>${newBadge(p)}${leadBadge(p)}<span class="muted">${esc([p.city, showState ? p.state || p.state_raw : null, p.zip].filter(Boolean).join(', '))}</span></div>
  <div class="r-meta"><span>${esc(p.owner_names || p.entities || '—')}</span><span class="muted small">${esc(p.tenant_names || '')}</span></div>
  <div class="r-side">${badge(p.status)}${p.callback_date ? `<span class="small ${p.cb_due ? 'due' : 'muted'}">CB ${fmtDate(p.callback_date)}</span>` : ''}</div></a>`;
  }).join('')}</div>`;
}
function filterForm(f, tenants, states, action = '/properties') {
  const opt = (v, l, sel) => `<option value="${esc(v)}"${String(sel) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
  return `<form class="filters" method="get" action="${action}">
<input type="search" name="q" value="${esc(f.q)}" placeholder="Search…">
<select name="state"><option value="">All states</option>${states.map((s) => opt(s.state, `${s.state} (${s.n})`, f.state)).join('')}</select>
<select name="tenant"><option value="">All tenants</option>${tenants.map((t) => opt(t.id, t.name, f.tenant)).join('')}</select>
<select name="status"><option value="">Any status</option>${STATUSES.map((s) => opt(s, s, f.status)).join('')}</select>
<select name="cb"><option value="">Any callback</option>${opt('due', 'Callback due', f.cb)}${opt('week', 'Due within 7 days', f.cb)}${opt('any', 'Has callback', f.cb)}${opt('none', 'No callback', f.cb)}</select>
${f.sort ? `<input type="hidden" name="sort" value="${esc(f.sort)}">` : ''}<button>Filter</button> <a class="btn ghost" href="${action}">Reset</a></form>`;
}
module.exports = { BANNER,  esc, layout, propertyRows, filterForm, badge, newBadge, leadBadge, fmtDate, isoDate, money, numf, pct, telHref, firstEmail, qs, STATUSES, OUTCOMES, STATE_NAMES };
