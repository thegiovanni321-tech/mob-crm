// File attachments stored in Postgres BYTEA (no separate volume/bucket).
// kind: 'lease_comp' | 'sale_comp' | 'property' (and future). Unique on (kind, record_id, filename).
const KINDS = new Set(['lease_comp', 'sale_comp', 'property', 'listing']);
const LABEL = {
  lease_comp: 'Offering memorandum (PDF)',
  sale_comp: 'Sale document (PDF)',
  property: 'Property document (PDF)',
};

function friendlyLabel(filename, mime) {
  const f = String(filename || '');
  if (/offering|memorandum|\bOM\b/i.test(f) || (mime || '').includes('pdf')) return 'Offering memorandum (PDF)';
  if (/\.pdf$/i.test(f)) return f;
  return f || 'Attachment';
}

async function listFor(db, kind, recordId) {
  return db.query(
    'SELECT id, kind, record_id, filename, mime_type, size_bytes, created_at FROM attachments WHERE kind=$1 AND record_id=$2 ORDER BY id',
    [kind, recordId],
  );
}

async function getMeta(db, id) {
  const [r] = await db.query(
    'SELECT id, kind, record_id, filename, mime_type, size_bytes, created_at FROM attachments WHERE id=$1',
    [id],
  );
  return r || null;
}

async function getWithData(db, id) {
  const [r] = await db.query('SELECT * FROM attachments WHERE id=$1', [id]);
  return r || null;
}

// Idempotent upsert by (kind, record_id, filename). Returns {id, created, size_bytes, filename}.
async function upsert(db, { kind, record_id, filename, mime_type, data }) {
  if (!KINDS.has(kind)) throw new Error('kind must be lease_comp, sale_comp, property, or listing');
  const rid = parseInt(record_id, 10);
  if (!Number.isFinite(rid) || rid < 1) throw new Error('record_id required');
  const name = String(filename || '').trim().replace(/[/\\]/g, '_');
  if (!name) throw new Error('filename required');
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (!buf.length) throw new Error('empty file');
  if (buf.length > 20 * 1024 * 1024) throw new Error('file too large (max 20 MB)');
  const mime = String(mime_type || 'application/octet-stream').slice(0, 120);
  const existing = await db.query(
    'SELECT id, size_bytes FROM attachments WHERE kind=$1 AND record_id=$2 AND filename=$3',
    [kind, rid, name],
  );
  if (existing.length) {
    return { id: existing[0].id, created: false, size_bytes: existing[0].size_bytes, filename: name };
  }
  const [r] = await db.query(
    `INSERT INTO attachments (kind, record_id, filename, mime_type, size_bytes, data)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, size_bytes`,
    [kind, rid, name, mime, buf.length, buf],
  );
  return { id: r.id, created: true, size_bytes: r.size_bytes, filename: name };
}

function linksHtml(atts, { labelFn } = {}) {
  if (!atts || !atts.length) return '';
  return `<ul class="acts plain" style="margin:.4rem 0">${atts.map((a) => {
    const label = (labelFn && labelFn(a)) || friendlyLabel(a.filename, a.mime_type);
    const kb = a.size_bytes >= 1048576 ? (a.size_bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(a.size_bytes / 1024)) + ' KB';
    return `<li><a href="/files/${a.id}" target="_blank" rel="noopener"><b>${escapeHtml(label)}</b></a>
      <span class="muted small"> · ${escapeHtml(a.filename)} · ${kb}</span></li>`;
  }).join('')}</ul>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON export/import helpers: BYTEA <-> {__bytea_b64: "..."} so backups stay text-safe.
function encodeRow(row) {
  if (!row || !row.data) return row;
  const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  return { ...row, data: { __bytea_b64: buf.toString('base64') } };
}
function decodeRow(row) {
  if (!row) return row;
  const d = row.data;
  if (d && typeof d === 'object' && d.__bytea_b64) return { ...row, data: Buffer.from(d.__bytea_b64, 'base64') };
  if (d && typeof d === 'object' && d.type === 'Buffer' && Array.isArray(d.data)) return { ...row, data: Buffer.from(d.data) };
  if (typeof d === 'string' && d.startsWith('\\x')) return { ...row, data: Buffer.from(d.slice(2), 'hex') };
  return row;
}

module.exports = { KINDS, listFor, getMeta, getWithData, upsert, linksHtml, friendlyLabel, encodeRow, decodeRow };
