const Needs = require('./buyer-needs');
const { esc, layout, qs, money, numf, pct, leadBadge } = require('./views');

function val(row, key) {
  const v = row && row[key];
  return v == null ? '' : esc(v);
}
function form(row, action, hint) {
  const n = row || {};
  const on = (v) => (String(n.tenancy || '') === v ? ' selected' : '');
  return `<form method="post" action="${action}" class="form grid">
    ${n.buyer_id ? `<input type="hidden" name="buyer_id" value="${esc(n.buyer_id)}">` : '<input type="hidden" name="buyer_id" value="">'}
    ${hint || ''}
    <label>Buyer name<input name="buyer_name" value="${val(n, 'buyer_name')}"></label>
    <label>Company<input name="company" value="${val(n, 'company')}"></label>
    <label>Phone<input name="phone" value="${val(n, 'phone')}"></label>
    <label>Email<input name="email" value="${val(n, 'email')}"></label>
    <label>States<input name="states" value="${val(n, 'states')}" placeholder="FL, GA"></label>
    <label>Cities or counties<input name="places" value="${val(n, 'places')}" placeholder="Tampa, Hillsborough"></label>
    <label>Center city<input name="center_city" value="${val(n, 'center_city')}"></label>
    <label>Center state<input name="center_state" value="${val(n, 'center_state')}" maxlength="2" placeholder="FL"></label>
    <label>Center ZIP<input name="center_zip" value="${val(n, 'center_zip')}"></label>
    <label>Radius miles<input name="radius_miles" value="${val(n, 'radius_miles')}" inputmode="decimal"></label>
    <label>Price min<input name="price_min" value="${val(n, 'price_min')}" inputmode="decimal"></label>
    <label>Price max<input name="price_max" value="${val(n, 'price_max')}" inputmode="decimal"></label>
    <label>Cap min<input name="cap_min" value="${val(n, 'cap_min')}" inputmode="decimal" placeholder="6.5 or 0.065"></label>
    <label>Cap max<input name="cap_max" value="${val(n, 'cap_max')}" inputmode="decimal"></label>
    <label>SF min<input name="sf_min" value="${val(n, 'sf_min')}" inputmode="decimal"></label>
    <label>SF max<input name="sf_max" value="${val(n, 'sf_max')}" inputmode="decimal"></label>
    <label>Min years remaining<input name="min_years" value="${val(n, 'min_years')}" inputmode="decimal"></label>
    <label class="wide">Tenant keywords<input name="tenant_keywords" value="${val(n, 'tenant_keywords')}" placeholder="hospital-affiliated, dialysis"></label>
    <label>Tenancy<select name="tenancy"><option value="">Any</option><option value="single"${on('single')}>Single tenant</option><option value="multi"${on('multi')}>Multi tenant</option></select></label>
    <label>Year built min<input name="year_built_min" value="${val(n, 'year_built_min')}" inputmode="numeric"></label>
    <label class="chk"><input type="checkbox" name="sellers_only" value="1"${n.sellers_only ? ' checked' : ''}> Likely sellers and leads only</label>
    <label class="chk"><input type="hidden" name="active" value="0"><input type="checkbox" name="active" value="1"${n.active === false ? '' : ' checked'}> Active</label>
    <label class="wide">Notes<textarea name="notes" rows="3">${val(n, 'notes')}</textarea></label>
    <div class="wide"><button>Save</button></div>
  </form>
  <p class="muted small">Price and cap rate on a property are the recorded sale, not an asking price. A linked listing can supply an asking price or cap rate, and it is labeled that way. A blank field on a property stays unknown. Counties are not a stored field; a city or county name is matched to the city or the notes. Distance uses property coordinates when they exist, otherwise a Census city or ZIP center.</p>`;
}
function reasonHtml(reasons) {
  return (reasons || []).map((r) => `<div class="small reason ${esc(r.status).replace(/\s+/g, '-')}"><b>${esc(r.label)}: ${esc(r.status)}</b> ${esc(r.detail || '')}</div>`).join('');
}
module.exports = function buyerNeedsRoutes(app, getDb, wrap) {
  const db = () => getDb();
  app.get('/buyer-needs', wrap(async (req, res) => {
    const rows = await db().query('SELECT * FROM buyer_needs ORDER BY active DESC, updated_at DESC, id DESC');
    const body = [];
    for (const row of rows) {
      const matches = await Needs.rankedMatches(db(), row, { strict: false });
      body.push(`<tr>
        <td><a href="/buyer-needs/${row.id}"><b>${esc(Needs.displayName(row))}</b></a>${row.company && row.buyer_name ? `<div class="muted small">${esc(row.company)}</div>` : ''}${row.active ? '' : ' <span class="badge">Inactive</span>'}</td>
        <td class="small">${esc(Needs.summary(row))}</td>
        <td class="num">${matches.length}</td>
        <td class="small"><a href="/buyer-needs/${row.id}/edit">Edit</a></td>
      </tr>`);
    }
    res.send(layout('Buyer Needs', `<h1>Buyer Needs</h1>
      <p class="muted">What a buyer is looking for, matched to properties already in the CRM. The count is the lenient match list.</p>
      <p><a class="btn" href="/buyer-needs/new">+ Add need</a></p>
      ${rows.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Buyer</th><th>Criteria</th><th class="num">Matches</th><th></th></tr></thead><tbody>${body.join('')}</tbody></table></div>` : '<p class="muted">No buyer needs yet.</p>'}`, { active: 'needs' }));
  }));
  app.get('/buyer-needs/new', wrap(async (req, res) => {
    const buyerId = parseInt(req.query.buyer_id, 10) || 0;
    let row = { active: true };
    let hint = '';
    if (buyerId) {
      const Buyers = require('./buyers');
      const [b] = await Buyers.loadBuyers(db(), { id: buyerId });
      if (b) {
        const last = b.last;
        row = {
          buyer_id: b.id,
          buyer_name: b.name || b.owner_name || '',
          company: b.entity || '',
          phone: b.phone || (b.best && b.best.phone) || '',
          email: b.email || (b.best && b.best.email) || '',
          states: last && last.state ? last.state : '',
          price_min: last && last.price ? last.price : '',
          price_max: last && last.price ? last.price : '',
          cap_min: last && last.cap_rate ? last.cap_rate : '',
          cap_max: last && last.cap_rate ? last.cap_rate : '',
          min_years: last && last.years_remaining != null ? Number(last.years_remaining).toFixed(1) : '',
          active: true,
        };
        hint = `<p class="wide muted small">${last ? `Suggested from the last capped purchase${last.sale_date ? ' on ' + esc(String(last.sale_date).slice(0, 10)) : ''}: state, recorded sale price, recorded cap rate${last.years_remaining != null ? ', and lease years then remaining' : ''}. These are editable defaults, not an asking price.` : 'This buyer has no capped purchase on file, so no price or cap rate was suggested.'}</p>`;
      }
    }
    res.send(layout('New buyer need', `<p class="crumbs"><a href="/buyer-needs">Buyer Needs</a> ›</p><h1>New buyer need</h1>${form(row, '/buyer-needs', hint)}`, { active: 'needs' }));
  }));
  app.post('/buyer-needs', wrap(async (req, res) => {
    const n = Needs.fromForm(req.body);
    const [row] = await db().query(`INSERT INTO buyer_needs (buyer_id, buyer_name, company, phone, email, states, places, center_city, center_state, center_zip, radius_miles, price_min, price_max, cap_min, cap_max, sf_min, sf_max, min_years, tenant_keywords, tenancy, year_built_min, sellers_only, notes, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [n.buyer_id, n.buyer_name, n.company, n.phone, n.email, n.states, n.places, n.center_city, n.center_state, n.center_zip, n.radius_miles, n.price_min, n.price_max, n.cap_min, n.cap_max, n.sf_min, n.sf_max, n.min_years, n.tenant_keywords, n.tenancy, n.year_built_min, n.sellers_only, n.notes, n.active]);
    res.redirect('/buyer-needs/' + row.id);
  }));
  app.get('/buyer-needs/:id/edit', wrap(async (req, res) => {
    const [row] = await db().query('SELECT * FROM buyer_needs WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
    if (!row) return res.status(404).send(layout('Not found', '<h1>Buyer need not found</h1>'));
    res.send(layout('Edit buyer need', `<p class="crumbs"><a href="/buyer-needs/${row.id}">${esc(Needs.displayName(row))}</a> ›</p><h1>Edit buyer need</h1>${form(row, '/buyer-needs/' + row.id, '')}
      <form method="post" action="/buyer-needs/${row.id}/delete" onsubmit="return confirm('Delete this buyer need?')"><button class="danger">Delete buyer need</button></form>`, { active: 'needs' }));
  }));
  app.post('/buyer-needs/:id/delete', wrap(async (req, res) => {
    await db().query('DELETE FROM buyer_needs WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
    res.redirect('/buyer-needs');
  }));
  app.post('/buyer-needs/:id', wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const n = Needs.fromForm(req.body);
    await db().query(`UPDATE buyer_needs SET buyer_id=$1, buyer_name=$2, company=$3, phone=$4, email=$5, states=$6, places=$7, center_city=$8, center_state=$9, center_zip=$10, radius_miles=$11, price_min=$12, price_max=$13, cap_min=$14, cap_max=$15, sf_min=$16, sf_max=$17, min_years=$18, tenant_keywords=$19, tenancy=$20, year_built_min=$21, sellers_only=$22, notes=$23, active=$24, updated_at=now() WHERE id=$25`,
      [n.buyer_id, n.buyer_name, n.company, n.phone, n.email, n.states, n.places, n.center_city, n.center_state, n.center_zip, n.radius_miles, n.price_min, n.price_max, n.cap_min, n.cap_max, n.sf_min, n.sf_max, n.min_years, n.tenant_keywords, n.tenancy, n.year_built_min, n.sellers_only, n.notes, n.active, id]);
    res.redirect('/buyer-needs/' + id);
  }));
  app.get('/buyer-needs/:id', wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const [row] = await db().query('SELECT * FROM buyer_needs WHERE id=$1', [id]);
    if (!row) return res.status(404).send(layout('Not found', '<h1>Buyer need not found</h1><p><a href="/buyer-needs">Back</a></p>', { active: 'needs' }));
    const strict = req.query.strict === '1';
    const state = String(req.query.state || '').trim().toUpperCase();
    const q = String(req.query.q || '').trim();
    const matches = await Needs.rankedMatches(db(), row, { strict, state, q });
    const keep = { state, q };
    if (strict) keep.strict = '1';
    const rows = matches.map((m, i) => {
      const href = `/properties/${m.id}${qs({ from: 'bn', bn_id: id, bn_at: i, bn_strict: strict ? '1' : '', state, q })}`;
      const tags = (m.sellerTags || []).map((t) => `<span class="badge">${esc(t.label)}</span>`).join(' ');
      return `<tr id="p-${m.id}">
        <td class="num"><b>${m.score}</b></td>
        <td><a href="${href}"><b>${esc(m.address)}</b></a><div class="muted small">${esc([m.city, m.state].filter(Boolean).join(', '))}</div></td>
        <td class="small">${esc(m.owner_names || '')}${m.phones ? `<div>${esc(m.phones)}</div>` : ''}</td>
        <td class="small">${esc(m.tenants || m.tenancy || '')}</td>
        <td class="num">${m.rba ? numf(m.rba) : ''}</td>
        <td class="small">${m.years_remaining != null ? Number(m.years_remaining).toFixed(1) : ''}</td>
        <td class="small">${esc(m.lastTalked || '')}</td>
        <td class="small">${m.lead ? leadBadge({ lead_at: m.lead_at }) : ''}${tags}</td>
        <td class="small">${reasonHtml(m.reasons)}</td>
      </tr>`;
    }).join('');
    res.send(layout(Needs.displayName(row), `<p class="crumbs"><a href="/buyer-needs">Buyer Needs</a> ›</p>
      <h1>${esc(Needs.displayName(row))}</h1>
      <p class="muted">${esc(Needs.summary(row))}${row.notes ? ' · ' + esc(row.notes) : ''}</p>
      <p class="muted small">Price and cap on a property are the recorded sale. Asking price is used only from a linked listing and is labeled asking. Missing fields are unknown${strict ? ' and hidden while strict is on' : ''}. Leads and high Most likely to sell scores are boosted.</p>
      <form class="filters" method="get" action="/buyer-needs/${id}">
        ${strict ? '<input type="hidden" name="strict" value="1">' : ''}
        <input type="search" name="q" value="${esc(q)}" placeholder="Address, owner, tenant">
        <input name="state" value="${esc(state)}" maxlength="2" placeholder="ST">
        <button>Filter</button>
        <a class="btn ghost" href="/buyer-needs/${id}${strict ? '?strict=1' : ''}">Reset</a>
        ${strict ? `<a class="btn ghost" href="/buyer-needs/${id}${qs({ q, state })}">Lenient</a>` : `<a class="btn ghost" href="/buyer-needs/${id}${qs({ q, state, strict: '1' })}">Strict</a>`}
      </form>
      <p><a class="btn ghost" href="/buyer-needs/${id}/edit">Edit</a></p>
      <h2>${matches.length} match${matches.length === 1 ? '' : 'es'}</h2>
      ${matches.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th class="num">Score</th><th>Property</th><th>Owner</th><th>Tenant</th><th class="num">SF</th><th>Lease yrs</th><th>Last talked</th><th>Signals</th><th>Criteria</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No matches for this view.</p>'}`, { active: 'needs', q }));
  }));
};
