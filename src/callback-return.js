// Which list a property was opened from. Previous/Next and Back use this, not the property's state.
const FROM = new Set(['cb', 'cbdue', 'cbsoon', 'cbhide', 'listings', 'buyer', 'state', 'leads']);
const ORDERED = new Set(['cb', 'cbdue', 'cbsoon', 'cbhide', 'listings', 'buyer', 'leads']);
const KEYS = ['from', 'fu_state', 'cb_at', 'lst', 'bid', 'ld_at', 'ret'];

function propertyRet(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 100000000 ? n : null;
}
function returnFromQuery(q) {
  const src = q || {};
  const from = String(src.from || '').trim();
  const ret = propertyRet(src.ret);
  if (!FROM.has(from)) return ret ? { from: '', fu_state: '', cb_at: null, lst: '', bid: null, ret } : null;
  const state = String(src.fu_state || '').trim().toUpperCase();
  const fu_state = /^[A-Z]{2}$/.test(state) ? state : '';
  const atRaw = from === 'leads' ? src.ld_at : src.cb_at;
  const at = Number.parseInt(atRaw, 10);
  const lst = String(src.lst || '').trim().slice(0, 40);
  const bid = Number.parseInt(src.bid, 10);
  return {
    from,
    fu_state,
    cb_at: Number.isInteger(at) && at >= 0 && at < 100000 ? at : null,
    lst,
    bid: Number.isInteger(bid) && bid > 0 ? bid : null,
    ret,
  };
}
function returnQuery(ctx) {
  if (!ctx) return {};
  const out = {};
  if (FROM.has(ctx.from)) {
    out.from = ctx.from;
    if (ctx.fu_state) out.fu_state = ctx.fu_state;
    if (ctx.from === 'leads') {
      if (ctx.cb_at != null && ctx.cb_at !== '') out.ld_at = String(ctx.cb_at);
    } else if (ctx.cb_at != null && ctx.cb_at !== '') out.cb_at = String(ctx.cb_at);
    if (ctx.lst) out.lst = ctx.lst;
    if (ctx.bid) out.bid = String(ctx.bid);
  }
  if (ctx.ret) out.ret = String(ctx.ret);
  return out;
}
function listUrl(ctx, anchorId) {
  if (!ctx) return '/callbacks';
  if (ctx.from === 'cbhide') {
    const q = ctx.fu_state ? `?fu_state=${encodeURIComponent(ctx.fu_state)}` : '';
    return '/callbacks/not-selling' + q + (anchorId ? `#p-${Number(anchorId)}` : '');
  }
  if (ctx.from === 'cb' || ctx.from === 'cbdue' || ctx.from === 'cbsoon') {
    const q = ctx.fu_state ? `?fu_state=${encodeURIComponent(ctx.fu_state)}` : '';
    const hash = anchorId ? `#p-${Number(anchorId)}` : (ctx.from === 'cbdue' ? '#due' : ctx.from === 'cbsoon' ? '#soon' : '#likely');
    return '/callbacks' + q + hash;
  }
  if (ctx.from === 'listings') return '/listings' + (ctx.lst ? `?status=${encodeURIComponent(ctx.lst)}` : '');
  if (ctx.from === 'leads') {
    const q = new URLSearchParams();
    if (ctx.fu_state) q.set('state', ctx.fu_state);
    const s = q.toString();
    return '/leads' + (s ? '?' + s : '') + (anchorId ? `#p-${Number(anchorId)}` : '');
  }
  if (ctx.from === 'buyer' && ctx.bid) return '/buyers/' + ctx.bid;
  if (ctx.from === 'state') return '/states/' + encodeURIComponent(ctx.stateCode || 'Unknown');
  return '/properties';
}
function backTarget(list, ret, anchorId) {
  const src = list || {};
  if (ret && (ret.from === 'cb' || ret.from === 'cbdue' || ret.from === 'cbsoon' || ret.from === 'cbhide')) {
    return { href: listUrl(ret, anchorId), label: '← Back to Callbacks' };
  }
  if (ret && ret.from === 'leads') {
    const q = new URLSearchParams();
    if (src.state) q.set('state', src.state);
    if (src.q) q.set('q', src.q);
    const s = q.toString();
    return { href: '/leads' + (s ? '?' + s : '') + (anchorId ? '#p-' + Number(anchorId) : ''), label: '← Back to Leads' };
  }
  if (ret && ret.from === 'listings') return { href: listUrl(ret), label: '← Back to Listings' };
  if (ret && ret.from === 'buyer') return { href: listUrl(ret), label: '← Back to buyer' };
  if (ret && ret.from === 'state' && src.state) {
    const rest = { ...src };
    delete rest.state;
    delete rest.from;
    const q = Object.keys(rest).length ? '?' + new URLSearchParams(rest).toString() : '';
    return { href: '/states/' + encodeURIComponent(src.state) + q, label: '← Back to ' + src.state };
  }
  if (src.owner && !src.q && !src.tenant && !src.status && !src.cb && !src.state) {
    return { href: '/owners/' + encodeURIComponent(src.owner), label: '← Back to owner' };
  }
  if (src.tenant && !src.q && !src.state && !src.status && !src.cb && !src.owner) {
    return { href: '/tenants/' + encodeURIComponent(src.tenant), label: '← Back to tenant' };
  }
  if (src.q && !src.state && !src.tenant && !src.status && !src.cb && !src.owner) {
    return { href: '/search?q=' + encodeURIComponent(src.q), label: '← Back to search' };
  }
  const filters = { ...src };
  delete filters.from;
  if (Object.keys(filters).some((k) => filters[k])) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v != null && v !== '') q.set(k, v);
    const s = q.toString();
    return { href: '/properties' + (s ? '?' + s : ''), label: '← Back to properties' };
  }
  return null;
}
function neighborsInCallbackList(rows, id, at) {
  const list = rows || [];
  const idx = list.findIndex((r) => Number(r.id) === Number(id));
  if (idx >= 0) {
    return {
      index: idx,
      total: list.length,
      prev: idx > 0 ? list[idx - 1] : null,
      next: idx < list.length - 1 ? list[idx + 1] : null,
      fellOut: false,
      anchorId: Number(id),
    };
  }
  const pos = at == null ? 0 : Math.min(Math.max(at, 0), list.length);
  const next = pos < list.length ? list[pos] : null;
  const prev = pos > 0 ? list[pos - 1] : null;
  return {
    index: pos,
    total: list.length,
    prev,
    next,
    fellOut: true,
    anchorId: next ? Number(next.id) : (prev ? Number(prev.id) : null),
  };
}

module.exports = { FROM, ORDERED, KEYS, returnFromQuery, returnQuery, listUrl, backTarget, neighborsInCallbackList };
