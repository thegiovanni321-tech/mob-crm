// Property previous/next follows the same filter and sort as the list the user opened.
// The order is not the raw id sequence. A direct link with no list query uses newest-added.
const LIST_KEYS = ['q', 'state', 'tenant', 'status', 'cb', 'sort', 'owner'];
const SORT_SQL = {
  added: 'p.created_at DESC NULLS LAST, p.state NULLS LAST, p.city NULLS LAST, p.address NULLS LAST, p.id DESC',
  addr: 'p.state NULLS LAST, p.city NULLS LAST, p.address NULLS LAST, p.id ASC',
  cb: 'p.callback_date NULLS LAST, p.address NULLS LAST, p.id ASC',
  cbdesc: 'p.callback_date DESC NULLS LAST, p.address NULLS LAST, p.id ASC',
  recent: 'p.updated_at DESC NULLS LAST, p.id DESC',
  city: 'p.city NULLS LAST, p.address NULLS LAST, p.id ASC',
};
function sortSql(sort) { return SORT_SQL[sort] || SORT_SQL.added; }
function cleanListValue(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s || s.length > 80) return '';
  return s;
}
function listFromQuery(q) {
  const src = q || {};
  const out = {};
  for (const k of LIST_KEYS) {
    const v = cleanListValue(src[k]);
    if (v) out[k] = v;
  }
  return out;
}
function neighborsOf(rows, id) {
  const idx = rows.findIndex((r) => Number(r.id) === Number(id));
  if (idx < 0) return { index: -1, total: rows.length, prev: null, next: null, inList: false };
  return {
    index: idx,
    total: rows.length,
    prev: idx > 0 ? rows[idx - 1] : null,
    next: idx < rows.length - 1 ? rows[idx + 1] : null,
    inList: true,
  };
}

module.exports = { LIST_KEYS, SORT_SQL, sortSql, listFromQuery, neighborsOf };
