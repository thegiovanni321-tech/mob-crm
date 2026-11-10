// Read-time follow-up lists for the Callbacks tab. Nothing here writes notes, statuses, or dates.
// A "talk" is a logged call with a conversation outcome (Talked, Interested, Not interested),
// an imported Talked row, or a property whose status is Talked/Interested with last_contacted
// and no conversation activity yet (imported last-contacted). Attempts do not count as talks:
// No answer, Left voicemail, Texted, Wrong number.
// Six months is 182 days. A talk is stale only when it is strictly older than that.
// Any later logged call (any outcome) is a newer contact and drops the row.
const STALE_DAYS = 182;
const TALK_CALL = new Set(['Talked', 'Interested', 'Not interested']);
const DEAD_STATUS = new Set(['Do not call']);
const DEAD_OUTCOME = new Set(['Wrong number', 'Do not call']);

// Apostrophes are normalized to ' before these run, so only the ASCII form is required.
// A sell phrase is negated when one of these sits in the short clause window before it.
const NEG_WORD_SRC = String.raw`\b(?:doesn['’]t|don['’]t|didn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|won['’]t|wouldn['’]t|shouldn['’]t|can['’]t|couldn['’]t|doesnt|dont|didnt|isnt|arent|wont|wouldnt|cant|couldnt|does not|do not|did not|is not|are not|was not|were not|will not|would not|should not|cannot|can not|could not|has no|have no|had no|not|no|never)\b`;
const CONTRAST_SRC = String.raw`\b(?:but|however|although|though|except)\b`;
// Phrases that are negations even when they do not contain a positive sell phrase.
const EXPLICIT_NEG = [
  /\bnot selling\b/gi,
  /\bnever selling\b/gi,
  /\bno interest in selling\b/gi,
  /\bnot for sale\b/gi,
  /\bno intention of selling\b/gi,
  /\b(?:won['’]t|wont|will not|wouldn['’]t|wouldnt|would not)\s+sell\b/gi,
  /\b(?:do not|don['’]t|dont|does not|doesn['’]t|doesnt|never)\s+call\s*back\b/gi,
  /\bno need to call\s*back\b/gi,
];
const SELL = [
  { re: /\binterested in selling\b/gi },
  { re: /\bthinking about selling\b/gi },
  { re: /\bconsider(?:ing)? selling\b/gi },
  { re: /\b(?:want|wants|looking) to sell\b/gi },
  { re: /\bplans? to sell\b/gi },
  { re: /\bopen to offers\b/gi },
  { re: /\bmay sell\b/gi },
  { re: /\bsell in \d+ years?\b/gi },
  { re: /\bwants?(?:\s+a)? valuation\b/gi },
  { re: /\bBOV\b/gi },
];
const LATER = [
  { re: /\bcall\s*back in (\d+) months?\b/i, phrase: 'call back in X months', unit: 'months' },
  { re: /\bcall\s*back in (\d+) years?\b/i, phrase: 'call back in X years', unit: 'years' },
  { re: /\bcall\s*back next year\b/i, phrase: 'call back next year', unit: 'nextYear' },
  { re: /\bcall\s*back after ([A-Za-z]+ \d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]+ \d{4})\b/i, phrase: 'call back after date', unit: 'afterDate' },
  { re: /\btry again later\b/i, phrase: 'try again later' },
  { re: /\bfollow[- ]?up later\b/i, phrase: 'follow up later' },
  { re: /\bcall\s*back later\b/i, phrase: 'call back later' },
  { re: /\breach out later\b/i, phrase: 'reach out later' },
];

function iso(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const m = String(d).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function daysBetween(later, earlier) {
  const a = Date.parse(later + 'T00:00:00Z');
  const b = Date.parse(earlier + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, d));
  return dt.toISOString().slice(0, 10);
}
function snippet(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + raw + (end < text.length ? '…' : '');
}
function normalizeNote(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function sellLabel(matched) {
  const cleanMatch = clean(matched);
  return /^bov$/i.test(cleanMatch) ? 'BOV' : cleanMatch.toLowerCase();
}
function findAll(text, specs) {
  const hits = [];
  for (const spec of specs) {
    const re = spec.re ? new RegExp(spec.re.source, 'gi') : new RegExp(spec.source, 'gi');
    let m;
    while ((m = re.exec(text))) {
      hits.push({ index: m.index, length: m[0].length, matched: m[0], spec });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  return hits;
}
function overlaps(aStart, aLen, bStart, bLen) {
  return aStart < bStart + bLen && aStart + aLen > bStart;
}
function windowBefore(text, index) {
  const from = Math.max(0, index - 40);
  let slice = text.slice(from, index);
  let cut = -1;
  for (const ch of '.!?;:,') cut = Math.max(cut, slice.lastIndexOf(ch));
  if (cut >= 0) slice = slice.slice(cut + 1);
  return { slice, start: index - slice.length };
}
function negationBefore(text, index) {
  const { slice, start } = windowBefore(text, index);
  const re = new RegExp(NEG_WORD_SRC, 'gi');
  let last = null;
  let m;
  while ((m = re.exec(slice))) last = m;
  if (!last) return null;
  const after = slice.slice(last.index + last[0].length);
  if (new RegExp(CONTRAST_SRC, 'i').test(after)) return null;
  return { start: start + last.index };
}
function blankRanges(text, ranges) {
  const chars = text.split('');
  for (const [s, e] of ranges) {
    for (let i = Math.max(0, s); i < e && i < chars.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}
function parseLooseDate(raw) {
  const s = String(raw || '').trim();
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return `${String(y).padStart(4, '0')}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && months[m[1].toLowerCase()]) {
    return `${m[3]}-${String(months[m[1].toLowerCase()]).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m && months[m[1].toLowerCase()]) return `${m[2]}-${String(months[m[1].toLowerCase()]).padStart(2, '0')}-01`;
  return '';
}
function impliedDate(day, later) {
  if (later.unit === 'months') return addMonths(day, later.amount || 1);
  if (later.unit === 'years') return addMonths(day, (later.amount || 1) * 12);
  if (later.unit === 'nextYear') return `${Number(day.slice(0, 4)) + 1}-01-01`;
  if (later.unit === 'afterDate') return parseLooseDate(later.rawDate);
  return '';
}
function classifyText(raw) {
  const text = normalizeNote(raw);
  const excluded = [];
  const covered = [];
  const covers = (index, length) => covered.some(([s, e]) => overlaps(index, length, s, e - s));
  const sellHits = findAll(text, SELL);
  const genuine = [];
  for (const hit of sellHits) {
    if (covers(hit.index, hit.length)) continue;
    const neg = negationBefore(text, hit.index);
    if (neg) {
      const end = hit.index + hit.length;
      excluded.push({ phrase: clean(text.slice(neg.start, end)), snippet: snippet(text, neg.start, end - neg.start) });
      covered.push([neg.start, end]);
    } else genuine.push(hit);
  }
  const kept = [];
  for (const hit of genuine) {
    if (covers(hit.index, hit.length)) continue;
    if (kept.some((k) => overlaps(hit.index, hit.length, k.index, k.length))) continue;
    kept.push(hit);
  }
  for (const hit of findAll(text, EXPLICIT_NEG.map((re) => ({ re })))) {
    if (covers(hit.index, hit.length)) continue;
    if (kept.some((k) => overlaps(hit.index, hit.length, k.index, k.length))) continue;
    excluded.push({ phrase: clean(hit.matched), snippet: snippet(text, hit.index, hit.length) });
    covered.push([hit.index, hit.index + hit.length]);
  }
  const blank = blankRanges(text, covered);
  const sell = kept[0]
    ? { phrase: sellLabel(kept[0].matched), snippet: snippet(text, kept[0].index, kept[0].length), matched: kept[0].matched }
    : null;
  let later = null;
  for (const spec of LATER) {
    const m = new RegExp(spec.re.source, spec.re.ignoreCase ? 'i' : '').exec(blank);
    if (!m) continue;
    const amount = spec.unit && spec.unit !== 'afterDate' && m[1] ? Number(m[1]) : null;
    later = {
      phrase: spec.phrase,
      snippet: snippet(text, m.index, m[0].length),
      matched: m[0],
      amount,
      unit: spec.unit || '',
      rawDate: spec.unit === 'afterDate' ? m[1] : '',
    };
    break;
  }
  return { sell, later, excluded };
}
function isTalk(a) {
  if (a.kind === 'call' && TALK_CALL.has(a.outcome)) return true;
  if (a.kind === 'import' && a.outcome === 'Talked') return true;
  return false;
}
function ownerOf(property, ownerId) {
  const owners = property.owners || [];
  return owners.find((o) => Number(o.id) === Number(ownerId)) || owners[0] || null;
}

function buildFollowUps({ today, properties, activities, state }) {
  const want = (state || '').trim().toUpperCase();
  const byId = new Map();
  for (const p of properties || []) byId.set(p.id, { ...p, activities: [] });
  for (const a of activities || []) {
    const p = byId.get(a.property_id);
    if (p) p.activities.push(a);
  }
  const stale = [];
  const missed = [];
  const excluded = [];
  for (const p of byId.values()) {
    if (want && String(p.state || '').toUpperCase() !== want) continue;
    if (DEAD_STATUS.has(p.status)) continue;
    const calls = p.activities.filter((a) => a.kind === 'call' && iso(a.activity_date));
    calls.sort((a, b) => (iso(a.activity_date) < iso(b.activity_date) ? 1 : iso(a.activity_date) > iso(b.activity_date) ? -1 : b.id - a.id));
    if (calls[0] && DEAD_OUTCOME.has(calls[0].outcome)) continue;
    const talks = [];
    for (const a of p.activities) {
      if (!isTalk(a) || !iso(a.activity_date)) continue;
      talks.push({ date: iso(a.activity_date), owner_id: a.owner_id, notes: a.notes || '', id: a.id });
    }
    if (!talks.length && p.last_contacted && (p.status === 'Talked' || p.status === 'Interested')) {
      talks.push({ date: iso(p.last_contacted), owner_id: null, notes: '', id: 0, fromLastContacted: true });
    }
    if (!talks.length) continue;
    talks.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    const latest = talks[0];
    const laterCall = calls.some((a) => iso(a.activity_date) > latest.date);
    const futureCallback = iso(p.callback_date) && iso(p.callback_date) > today;
    const days = daysBetween(today, latest.date);
    const owner = ownerOf(p, latest.owner_id);
    if (!laterCall && !futureCallback && days !== null && days > STALE_DAYS) {
      const note = latest.notes || p.notes || '';
      stale.push({
        propertyId: p.id, address: p.address, city: p.city, state: p.state,
        ownerName: owner ? (owner.name || '') : '', ownerEntity: owner ? (owner.entity || '') : '',
        lastTalked: latest.date, daysSince: days,
        snippet: String(note).replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }
    const texts = talks.map((t) => ({ date: t.date, notes: t.notes, owner_id: t.owner_id }));
    if (p.notes) texts.push({ date: latest.date, notes: p.notes, owner_id: latest.owner_id, propertyNotes: true });
    let best = null;
    for (const t of texts) {
      const found = classifyText(t.notes);
      for (const ex of found.excluded) {
        excluded.push({ propertyId: p.id, address: p.address, state: p.state, phrase: ex.phrase, snippet: ex.snippet, date: t.date });
      }
      const hit = found.sell || found.later;
      if (!hit) continue;
      if (calls.some((a) => iso(a.activity_date) > t.date)) continue;
      let due = '';
      if (found.later && found.later.unit) {
        due = impliedDate(t.date, found.later);
        if (due && due > today) continue;
      }
      const row = {
        propertyId: p.id, address: p.address, city: p.city, state: p.state,
        ownerName: (ownerOf(p, t.owner_id) || {}).name || '',
        ownerEntity: (ownerOf(p, t.owner_id) || {}).entity || '',
        date: t.date, phrase: hit.phrase, snippet: hit.snippet, due: due || '',
        kind: found.sell ? 'sell' : 'callback',
      };
      if (!best || row.date > best.date) best = row;
    }
    if (best && !(iso(p.callback_date) && iso(p.callback_date) > today)) missed.push(best);
  }
  stale.sort((a, b) => (a.lastTalked < b.lastTalked ? -1 : a.lastTalked > b.lastTalked ? 1 : a.propertyId - b.propertyId));
  missed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.propertyId - b.propertyId));
  return { stale, missed, excluded, staleDays: STALE_DAYS };
}

function renderFollowUps(model, { state, states }) {
  const { esc, fmtDate } = require('./views');
  const opts = (states || []).map((s) => `<option value="${esc(s)}"${s === state ? ' selected' : ''}>${esc(s)}</option>`).join('');
  const rowStale = (r) => `<tr>
    <td>${esc(r.ownerName || 'No owner on file')}${r.ownerEntity ? `<div class="muted small">${esc(r.ownerEntity)}</div>` : ''}</td>
    <td><a href="/properties/${r.propertyId}"><b>${esc(r.address || '')}</b></a><div class="muted small">${esc([r.city, r.state].filter(Boolean).join(', '))}</div></td>
    <td>${esc(fmtDate(r.lastTalked))}</td>
    <td class="num">${r.daysSince}</td>
    <td class="small">${esc(r.snippet || '')}</td></tr>`;
  const rowMiss = (r) => `<tr>
    <td>${esc(r.ownerName || 'No owner on file')}${r.ownerEntity ? `<div class="muted small">${esc(r.ownerEntity)}</div>` : ''}</td>
    <td><a href="/properties/${r.propertyId}"><b>${esc(r.address || '')}</b></a><div class="muted small">${esc([r.city, r.state].filter(Boolean).join(', '))}</div></td>
    <td class="small"><b>${esc(r.phrase)}</b>${r.due ? `<div class="muted">Implied ${esc(fmtDate(r.due))}</div>` : ''}<div>${esc(r.snippet || '')}</div></td>
    <td>${esc(fmtDate(r.date))}</td></tr>`;
  return `<form class="filters" method="get" action="/callbacks">
    <label class="fl">Follow-up state <select name="fu_state"><option value="">All states</option>${opts}</select></label>
    <button>Filter</button> <a class="btn ghost" href="/callbacks">Reset</a></form>
  <h2 id="stale">Haven't talked in 6 months <span class="muted">(${model.stale.length})</span></h2>
  <p class="muted small">Owners with a real conversation (Talked, Interested, Not interested, or an imported Talked / last-contacted Talked record) more than ${model.staleDays} days ago. No answer, voicemail, text, and wrong number do not count as a talk. A later logged call, a future callback, or Do not call / wrong number removes the row. Oldest talk first.</p>
  ${model.stale.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Owner</th><th>Property</th><th>Last talked</th><th class="num">Days</th><th>Last note</th></tr></thead><tbody>${model.stale.map(rowStale).join('')}</tbody></table></div>` : '<p class="muted">No one in this set.</p>'}
  <h2 id="missed">Missed follow-ups <span class="muted">(${model.missed.length})</span></h2>
  <p class="muted small">A past conversation mentioned selling or asked for a later call, and no call was logged after it. “Call back in X months/years” or “next year” appears only after that implied date. A phrase is not sell interest when a negator such as “not”, “doesn't”, “does not”, or “never” sits just before it (“doesn't want to sell”, “not open to offers”). Only an unnegated phrase is listed.</p>
  ${model.missed.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Owner</th><th>Property</th><th>Why it is listed</th><th>Conversation</th></tr></thead><tbody>${model.missed.map(rowMiss).join('')}</tbody></table></div>` : '<p class="muted">No missed follow-ups in this set.</p>'}
  ${model.excluded.length ? `<details class="box"><summary>Excluded by negation (${model.excluded.length})</summary><ul class="acts plain">${model.excluded.slice(0, 30).map((e) => `<li class="small">${esc(e.address || '')} · <b>${esc(e.phrase)}</b> · ${esc(e.snippet)}</li>`).join('')}</ul></details>` : ''}`;
}

module.exports = { STALE_DAYS, classifyText, buildFollowUps, daysBetween, isTalk, renderFollowUps };
