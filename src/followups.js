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
  /\bnot interested\b/gi,
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
  const sells = kept.map((hit) => ({ phrase: sellLabel(hit.matched), snippet: snippet(text, hit.index, hit.length), matched: hit.matched }));
  const sell = sells[0] || null;
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
  return { sell, sells, later, excluded };
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

const { STATE_NAMES } = require('./views');
const SIGNALS = {
  sell: 100,
  valuation: 90,
  sellYearsPending: 75,
  callbackDue: 60,
  callbackUndated: 50,
  age75: 45,
  age75Step: 1,
  age75Cap: 10,
  age65: 30,
  age65Step: 1,
  age65Cap: 9,
  retirement: 35,
  longHold: 25,
  holdYears: 10,
  leaseSoon: 25,
  leaseMonths: 18,
  hospital: 25,
  vacancy: 20,
  relocation: 20,
  estate: 20,
  outOfState: 15,
  stale: 10,
  ageFloor: 65,
  ageHigh: 75,
};
const RETIRE = [
  { re: /\bretiring\b/i, label: 'Retiring' },
  { re: /\bretirement\b/i, label: 'Retirement' },
  { re: /\bretired\b/i, label: 'Retired' },
  { re: /\bolder doctor\b/i, label: 'Older doctor' },
  { re: /\bwinding down\b/i, label: 'Winding down' },
  { re: /\bsuccession\b/i, label: 'Succession' },
  { re: /\bhealth issues\b/i, label: 'Health' },
  { re: /\bhealth problems\b/i, label: 'Health' },
  { re: /\bin poor health\b/i, label: 'Health' },
  { re: /\b(?:his|her|their) health\b/i, label: 'Health' },
  { re: /\bhealth reasons\b/i, label: 'Health' },
  { re: /\billness(?:es)?\b/i, label: 'Health' },
  { re: /\bpassed away\b/i, label: 'Passed away' },
  { re: /\bheirs?\b/i, label: 'Heirs' },
  { re: /\b(?<!real\s)estate\b/i, label: 'Estate' },
];

function sellWeight(phrase, talkDate, today) {
  const years = String(phrase).match(/\bsell in (\d+) years?\b/i);
  if (years) {
    const due = addMonths(talkDate, Number(years[1]) * 12);
    if (due <= today) return { points: SIGNALS.sell, label: `${phrase} (timeframe reached)` };
    return { points: SIGNALS.sellYearsPending, label: `${phrase} (timeframe ${due})` };
  }
  if (/\b(bov|valuation)\b/i.test(phrase)) return { points: SIGNALS.valuation, label: phrase };
  return { points: SIGNALS.sell, label: phrase };
}
function noteStance(text, outcome) {
  const found = classifyText(text || '');
  const positive = found.sell || null;
  const negated = !positive && (found.excluded.length > 0 || outcome === 'Not interested');
  return { positive, sells: found.sells || (positive ? [positive] : []), later: found.later, negated, excluded: found.excluded };
}
function agePoints(age) {
  if (age < SIGNALS.ageFloor) return 0;
  return age >= SIGNALS.ageHigh
    ? SIGNALS.age75 + Math.min(age - SIGNALS.ageHigh, SIGNALS.age75Cap)
    : SIGNALS.age65 + Math.min(age - SIGNALS.ageFloor, SIGNALS.age65Cap);
}
function qualifyingAge(owner, today) {
  const rawYear = owner && owner.birth_year;
  const hasYear = rawYear != null && String(rawYear).trim() !== '';
  if (hasYear) {
    const year = Number(rawYear);
    const conf = String((owner && owner.age_confidence) || '').trim().toLowerCase();
    const now = Number(String(today).slice(0, 4));
    if (!Number.isInteger(year) || year < 1900 || year > now - 18) return null;
    if (conf !== 'high' && conf !== 'medium') return null;
    const age = now - year;
    const points = agePoints(age);
    if (!points) return null;
    const source = owner.age_source ? `, ${owner.age_source}` : '';
    return { points, label: `Age ${age} (born ${year}${source}, ${conf})`, age };
  }
  const text = String(owner && owner.age != null ? owner.age : '').trim();
  if (!/^\d+$/.test(text)) return null;
  const age = Number(text);
  if (age < 18 || age > 110) return null;
  const points = agePoints(age);
  if (!points) return null;
  return { points, label: `Age ${age} (CRM age field, medium)`, age };
}
function retirementHit(text) {
  const src = normalizeNote(text);
  for (const spec of RETIRE) {
    const m = new RegExp(spec.re.source, 'i').exec(src);
    if (!m) continue;
    if (negationBefore(src, m.index)) continue;
    return { label: spec.label, snippet: snippet(src, m.index, m[0].length) };
  }
  return null;
}
function mailingState(addr) {
  const up = String(addr || '').toUpperCase();
  const m = up.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/) || up.match(/,\s*([A-Z]{2})\s*$/);
  return m && STATE_NAMES[m[1]] ? m[1] : '';
}
function isEstateOwner(owner) {
  const raw = `${owner.name || ''} ${owner.entity || ''}`;
  const stripped = raw.replace(/\breal estate\b/ig, ' ');
  return /\b(trust|trustee|estate of|heirs?)\b/i.test(stripped) || /\bestate\b/i.test(stripped);
}
function leaseIsSoon(property, today) {
  const exp = iso(property.leaseExpiration || property.lease_expiration);
  if (exp) {
    const until = daysBetween(exp, today);
    if (until !== null && until <= SIGNALS.leaseMonths * 30 && until >= -90) return true;
  }
  const years = property.yearsRemaining;
  return years !== null && years !== undefined && years !== '' && Number(years) >= 0 && Number(years) <= SIGNALS.leaseMonths / 12;
}

function buildFollowUps({ today, properties, activities, state }) {
  const want = (state || '').trim().toUpperCase();
  const byId = new Map();
  for (const p of properties || []) byId.set(p.id, { ...p, activities: [] });
  for (const a of activities || []) {
    const p = byId.get(a.property_id);
    if (p) p.activities.push(a);
  }
  const ranked = [];
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
      talks.push({ date: iso(a.activity_date), owner_id: a.owner_id, notes: a.notes || '', outcome: a.outcome || '', id: a.id });
    }
    if (!talks.length && p.last_contacted && (p.status === 'Talked' || p.status === 'Interested')) {
      talks.push({ date: iso(p.last_contacted), owner_id: null, notes: '', outcome: '', id: 0, fromLastContacted: true });
    }
    if (!talks.length) continue;
    talks.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    const latest = talks[0];
    const futureCallback = iso(p.callback_date) && iso(p.callback_date) > today;
    const lastContact = calls[0] ? iso(calls[0].activity_date) : latest.date;
    const days = daysBetween(today, latest.date);
    const contactDays = daysBetween(today, lastContact);
    const owner = ownerOf(p, latest.owner_id);
    const chronological = [...talks].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    let positive = null;
    let laterHit = null;
    let negated = false;
    let whyList = [];
    for (const t of chronological) {
      const stance = noteStance(t.notes, t.outcome);
      if (stance.positive) {
        positive = { sells: stance.sells, date: t.date, snippet: stance.positive.snippet };
        laterHit = stance.later ? { ...stance.later, date: t.date } : laterHit;
        negated = false;
        whyList = [];
      } else if (stance.negated) {
        positive = null;
        laterHit = null;
        negated = true;
        whyList = stance.excluded.length ? stance.excluded : [{ phrase: t.outcome === 'Not interested' ? 'Not interested' : 'not selling', snippet: t.notes || t.outcome || '' }];
      } else if (stance.later) laterHit = { ...stance.later, date: t.date };
    }
    const fileNotes = [p.notes, ...(p.owners || []).map((o) => o.notes)].filter(Boolean).join('\n');
    const file = noteStance(fileNotes, '');
    const latestStance = noteStance(latest.notes, latest.outcome);
    if (file.negated && !latestStance.positive) {
      negated = true;
      positive = null;
      laterHit = null;
      if (file.excluded.length) whyList = file.excluded;
    } else if (file.positive && !latestStance.negated && !positive) {
      positive = { sells: file.sells, date: latest.date, snippet: file.positive.snippet };
      negated = false;
    }
    if (p.status === 'Not interested' && !latestStance.positive && !(file.positive && !latestStance.negated)) {
      negated = true;
      positive = null;
      laterHit = null;
      if (!whyList.length) whyList = [{ phrase: 'Not interested', snippet: fileNotes || latest.notes || '' }];
    }
    if (positive && calls.some((c) => iso(c.activity_date) > positive.date)) positive = null;
    if (laterHit && calls.some((c) => iso(c.activity_date) > laterHit.date)) laterHit = null;
    if (negated) {
      const reasons = whyList.length ? whyList : [{ phrase: 'not selling', snippet: '' }];
      for (const reason of reasons) {
        excluded.push({
          propertyId: p.id, address: p.address, city: p.city, state: p.state,
          ownerName: owner ? (owner.name || '') : '', ownerEntity: owner ? (owner.entity || '') : '',
          phrase: reason.phrase, snippet: reason.snippet || '', date: latest.date,
        });
      }
      continue;
    }
    if (futureCallback) continue;
    const tags = [];
    let snippetText = '';
    if (positive) {
      const weighted = positive.sells.map((s) => sellWeight(s.phrase, positive.date, today));
      const best = weighted.reduce((a, b) => (b.points > a.points ? b : a));
      tags.push({ label: weighted.map((w) => w.label).join('; '), points: best.points });
      snippetText = positive.snippet || '';
    }
    if (laterHit) {
      let due = '';
      let points = SIGNALS.callbackUndated;
      if (laterHit.unit) {
        due = impliedDate(laterHit.date, laterHit);
        if (due && due > today) points = 0;
        else points = SIGNALS.callbackDue;
      }
      if (points) {
        tags.push({ label: due ? `${laterHit.phrase} (due ${due})` : laterHit.phrase, points });
        if (!snippetText) snippetText = laterHit.snippet || '';
      }
    }
    const stale = contactDays !== null && contactDays > STALE_DAYS;
    const qualified = tags.some((t) => t.points > 0) || stale;
    if (!qualified) continue;
    if (stale) tags.push({ label: `Talked ${days} days ago`, points: SIGNALS.stale });
    const corpus = [latest.notes, p.notes, ...(p.owners || []).map((o) => o.notes)].filter(Boolean).join('\n');
    const retired = retirementHit(corpus);
    if (retired) {
      tags.push({ label: retired.label, points: SIGNALS.retirement });
      if (!snippetText) snippetText = retired.snippet;
    }
    const ages = (p.owners || []).map((o) => qualifyingAge(o, today)).filter(Boolean).sort((a, b) => b.age - a.age);
    if (ages[0]) tags.push({ label: ages[0].label, points: ages[0].points });
    const held = iso(p.sale_date || p.saleDate);
    if (held && daysBetween(today, held) >= SIGNALS.holdYears * 365) tags.push({ label: `Held since ${held.slice(0, 4)}`, points: SIGNALS.longHold });
    if (leaseIsSoon(p, today)) tags.push({ label: 'Lease expiring', points: SIGNALS.leaseSoon });
    if (/\b(?:acquired by|acquisition by|merging with|merged with|merger with)\s+(?:a\s+|the\s+)?(?:[\w-]+\s+){0,3}?(?:hospital|group|health system)\b/i.test(normalizeNote(corpus))
      || /\b(?:hospital|health system)\b.{0,40}\b(?:acquir|merg)/i.test(normalizeNote(corpus))) {
      tags.push({ label: 'Hospital or group', points: SIGNALS.hospital });
    }
    if (/\bvacant(?:cy)?\b/i.test(`${p.tenancy || ''} ${corpus}`)) tags.push({ label: 'Vacant', points: SIGNALS.vacancy });
    if (/\brelocat(?:e|es|ed|ing|ion)\b|\bmoving (?:the )?practice\b/i.test(normalizeNote(corpus))) tags.push({ label: 'Relocation', points: SIGNALS.relocation });
    const deceased = (p.owners || []).some((o) => /\bdeceased\b/i.test(String(o.age || '')));
    if (deceased) tags.push({ label: 'Deceased', points: SIGNALS.estate });
    else if ((p.owners || []).some(isEstateOwner)) tags.push({ label: 'Estate or trust', points: SIGNALS.estate });
    const mail = mailingState((owner && owner.mailing_address) || (p.owners || []).map((o) => o.mailing_address).find(Boolean) || '');
    if (mail && p.state && mail !== String(p.state).toUpperCase()) tags.push({ label: `Out of state (${mail})`, points: SIGNALS.outOfState });
    if (!snippetText) snippetText = clean(latest.notes || p.notes || '').slice(0, 140);
    let overdue = days || 0;
    const dueTag = tags.find((t) => /due \d{4}-\d{2}-\d{2}/.test(t.label));
    if (dueTag) {
      const dueDay = dueTag.label.match(/due (\d{4}-\d{2}-\d{2})/);
      if (dueDay) overdue = Math.max(overdue, daysBetween(today, dueDay[1]) || 0);
    }
    ranked.push({
      propertyId: p.id, address: p.address, city: p.city, state: p.state,
      ownerName: owner ? (owner.name || '') : '', ownerEntity: owner ? (owner.entity || '') : '',
      lastTalked: latest.date, daysSince: days, daysOverdue: overdue,
      score: tags.reduce((n, t) => n + t.points, 0), tags, snippet: snippetText,
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.daysOverdue - a.daysOverdue || b.daysSince - a.daysSince || a.propertyId - b.propertyId);
  return { ranked, excluded, staleDays: STALE_DAYS, signals: SIGNALS };
}

function followFilter(state, states, action) {
  const { esc } = require('./views');
  const opts = (states || []).map((s) => `<option value="${esc(s)}"${s === state ? ' selected' : ''}>${esc(s)}</option>`).join('');
  return `<form class="filters" method="get" action="${action}">
    <label class="fl">State <select name="fu_state"><option value="">All states</option>${opts}</select></label>
    <button>Filter</button> <a class="btn ghost" href="${action}">Reset</a></form>`;
}
function renderFollowUps(model, { state, states }) {
  const { esc, fmtDate } = require('./views');
  const hidden = model.excluded.length
    ? `<p class="muted small"><a href="/callbacks/not-selling${state ? `?fu_state=${encodeURIComponent(state)}` : ''}">${model.excluded.length} clearly not selling, hidden</a></p>`
    : '';
  const tags = (r) => r.tags.map((t) => `<span class="badge">${esc(t.label)}${t.points ? ` <em>${t.points}</em>` : ''}</span>`).join(' ');
  const row = (r, i) => `<tr id="p-${r.propertyId}">
    <td class="num"><b>${r.score}</b></td>
    <td>${esc(r.ownerName || 'No owner on file')}${r.ownerEntity ? `<div class="muted small">${esc(r.ownerEntity)}</div>` : ''}</td>
    <td><a href="/properties/${r.propertyId}?from=cb${state ? `&fu_state=${encodeURIComponent(state)}` : ''}&cb_at=${i}"><b>${esc(r.address || '')}</b></a><div class="muted small">${esc([r.city, r.state].filter(Boolean).join(', '))}</div></td>
    <td class="small">${tags(r)}</td>
    <td>${esc(fmtDate(r.lastTalked))}</td>
    <td class="num">${r.daysSince}</td>
    <td class="small">${esc(r.snippet || '')}</td></tr>`;
  return `${followFilter(state, states, '/callbacks')}
  <h2 id="likely">Most likely to sell <span class="muted">(${model.ranked.length})</span></h2>
  <p class="muted small">Ranked when the page is read. Explicit sell interest and a past-due callback come first, then age 75+ and 65+ from a birth year with high or medium confidence, then other signals already stored on the record, then a neutral talk older than ${model.staleDays} days. Clear “not selling” or “not interested” notes are left off this list. A future scheduled callback stays in the lists above. A new logged call drops the row until it qualifies again.</p>
  ${model.ranked.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th class="num">Score</th><th>Owner</th><th>Property</th><th>Why</th><th>Last talked</th><th class="num">Days</th><th>Note</th></tr></thead><tbody>${model.ranked.map(row).join('')}</tbody></table></div>` : '<p class="muted">No one in this set.</p>'}
  ${hidden}`;
}
function renderNotSelling(model, { state, states }) {
  const { esc, fmtDate } = require('./views');
  const row = (r, i) => `<tr id="p-${r.propertyId}">
    <td>${esc(r.ownerName || 'No owner on file')}</td>
    <td><a href="/properties/${r.propertyId}?from=cbhide${state ? `&fu_state=${encodeURIComponent(state)}` : ''}&cb_at=${i}"><b>${esc(r.address || '')}</b></a><div class="muted small">${esc([r.city, r.state].filter(Boolean).join(', '))}</div></td>
    <td class="small"><b>${esc(r.phrase || '')}</b><div>${esc(r.snippet || '')}</div></td>
    <td>${esc(fmtDate(r.date))}</td></tr>`;
  return `${followFilter(state, states, '/callbacks/not-selling')}
  <h2>Clearly not selling <span class="muted">(${model.excluded.length})</span></h2>
  <p class="muted small">Hidden from Callbacks. A later conversation with a real sell phrase puts the record back on Most likely to sell. Nothing here is written back to the notes.</p>
  ${model.excluded.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Owner</th><th>Property</th><th>Why it is hidden</th><th>Date</th></tr></thead><tbody>${model.excluded.map(row).join('')}</tbody></table></div>` : '<p class="muted">None in this set.</p>'}`;
}

module.exports = { STALE_DAYS, SIGNALS, classifyText, buildFollowUps, daysBetween, isTalk, renderFollowUps, renderNotSelling, qualifyingAge };
