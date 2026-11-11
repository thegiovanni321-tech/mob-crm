// Nexis (or any later research file) owner ages. Birth year is stored; age is derived when read.
// Rows fill an existing owner only when birth_year is still empty. They never create an owner.
function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function sameName(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.split(' ').sort().join(' ') === nb.split(' ').sort().join(' ');
}
function normAddr(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function confidence(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'med') return 'medium';
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return s ? s.slice(0, 40) : null;
}
function birthYearFromRow(row, todayYear) {
  const raw = row.birth_year ?? row.birthYear;
  const year = Number(String(raw ?? '').trim());
  if (Number.isInteger(year) && year >= 1900 && year <= todayYear - 1) return year;
  const age = Number(String(row.age_as_of_today ?? row.ageAsOfToday ?? '').trim());
  if (Number.isInteger(age) && age >= 18 && age <= 110) return todayYear - age;
  return null;
}
function pick(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return '';
}
function matchOwner(row, properties, owners, links) {
  const byOwner = new Map(owners.map((o) => [Number(o.id), o]));
  const byProp = new Map(properties.map((p) => [Number(p.id), p]));
  const ownersOf = new Map();
  for (const link of links) {
    if (!ownersOf.has(link.property_id)) ownersOf.set(link.property_id, []);
    const owner = byOwner.get(link.owner_id);
    if (owner) ownersOf.get(link.property_id).push(owner);
  }
  const person = pick(row, ['person_name', 'personName', 'owner_name', 'ownerName', 'name']);
  const ownerId = Number(pick(row, ['owner_id', 'ownerId']));
  const propertyId = Number(pick(row, ['property_id', 'propertyId']));
  if (ownerId) {
    const owner = byOwner.get(ownerId);
    if (!owner) return { error: 'noMatch' };
    if (propertyId && !(ownersOf.get(propertyId) || []).some((o) => o.id === owner.id)) return { error: 'noMatch' };
    if (person && !sameName(person, owner.name) && !sameName(person, owner.entity)) return { error: 'noMatch' };
    return { owner };
  }
  let props = [];
  if (propertyId) {
    const prop = byProp.get(propertyId);
    if (!prop) return { error: 'noMatch' };
    props = [prop];
  } else {
    const address = normAddr(pick(row, ['address', 'property_address', 'propertyAddress']));
    if (!address) return { error: 'noMatch' };
    const state = String(pick(row, ['state']) || '').trim().toUpperCase();
    const city = normAddr(pick(row, ['city']));
    props = properties.filter((p) => normAddr(p.address) === address && (!state || String(p.state || '').toUpperCase() === state) && (!city || normAddr(p.city) === city));
  }
  if (props.length !== 1) return { error: props.length ? 'ambiguous' : 'noMatch' };
  const candidates = (ownersOf.get(props[0].id) || []).filter((o) => !person || sameName(person, o.name) || sameName(person, o.entity));
  if (candidates.length !== 1) return { error: candidates.length ? 'ambiguous' : 'noMatch' };
  return { owner: candidates[0] };
}

function explicitBirthYear(row) {
  const raw = pick(row, ['birth_year']);
  if (String(raw).trim() === '') return null;
  const year = Number(String(raw).trim());
  if (Number.isInteger(year) && year >= 1900 && year <= 2100) return year;
  return { invalid: true };
}
function researchConfidence(row) {
  const conf = confidence(pick(row, ['match_confidence', 'confidence', 'age_confidence']));
  return conf === 'high' || conf === 'medium' ? conf : null;
}
function classifyResearchRows(rows, { owners, links }) {
  const byOwner = new Map((owners || []).map((o) => [Number(o.id), { ...o }]));
  const updates = [];
  const skipped = [];
  (rows || []).forEach((row, index) => {
    const line = index + 2;
    const conf = researchConfidence(row);
    if (!conf) { skipped.push({ line, reason: 'match confidence is not high or medium' }); return; }
    const year = explicitBirthYear(row);
    if (!year) { skipped.push({ line, reason: 'birth year is blank' }); return; }
    if (year.invalid) { skipped.push({ line, reason: 'birth year is not a four-digit year' }); return; }
    const ownerId = Number(pick(row, ['crm_owner_id', 'owner_id']));
    const propertyId = Number(pick(row, ['crm_property_id', 'property_id']));
    if (!ownerId || !propertyId) { skipped.push({ line, reason: 'crm_owner_id and crm_property_id are required' }); return; }
    const owner = byOwner.get(ownerId);
    if (!owner) { skipped.push({ line, reason: 'owner id is not in the CRM' }); return; }
    const linked = (links || []).some((l) => Number(l.property_id) === propertyId && Number(l.owner_id) === ownerId);
    if (!linked) { skipped.push({ line, reason: 'owner is not linked to that property' }); return; }
    const person = pick(row, ['person_name', 'name']);
    const warning = person && !sameName(person, owner.name) && !sameName(person, owner.entity)
      ? `Name “${person}” does not match ${owner.name || owner.entity || 'the owner on file'}`
      : '';
    if (owner.birth_year) { skipped.push({ line, reason: 'birth year already set', warning }); return; }
    const source = String(pick(row, ['source', 'age_source']) || '').trim().slice(0, 200) || 'Nexis';
    owner.birth_year = year;
    updates.push({ line, ownerId, propertyId, name: owner.name || '', birthYear: year, source, confidence: conf, warning });
  });
  return { updates, skipped };
}
async function applyResearchAges(db, rows, opts = {}) {
  const owners = await db.query('SELECT id, name, entity, age, birth_year FROM owners');
  const links = await db.query('SELECT property_id, owner_id FROM property_owners');
  const plan = classifyResearchRows(rows, { owners, links });
  if (!opts.dryRun) {
    await db.tx(async (t) => {
      for (const u of plan.updates) {
        await t.query('UPDATE owners SET birth_year=$1, age_source=$2, age_confidence=$3, updated_at=now() WHERE id=$4 AND birth_year IS NULL', [u.birthYear, u.source, u.confidence, u.ownerId]);
      }
    });
    require('./same-person').invalidate();
  }
  return { dryRun: !!opts.dryRun, updates: plan.updates, skipped: plan.skipped, updated: plan.updates.length };
}
async function importOwnerAges(db, rows, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const todayYear = Number(String(today).slice(0, 4));
  const stats = { updated: 0, alreadySet: 0, noMatch: 0, ambiguous: 0, noBirthYear: 0 };
  const properties = await db.query('SELECT id, address, city, state FROM properties');
  const owners = await db.query('SELECT id, name, entity, birth_year FROM owners');
  const links = await db.query('SELECT property_id, owner_id FROM property_owners');
  for (const row of rows || []) {
    const found = matchOwner(row, properties, owners, links);
    if (found.error) { stats[found.error] += 1; continue; }
    if (found.owner.birth_year) { stats.alreadySet += 1; continue; }
    const year = birthYearFromRow(row, todayYear);
    if (!year) { stats.noBirthYear += 1; continue; }
    const source = String(pick(row, ['source', 'age_source', 'ageSource']) || '').trim().slice(0, 200) || null;
    const conf = confidence(pick(row, ['match_confidence', 'confidence', 'age_confidence', 'ageConfidence']));
    if (!opts.dryRun) {
      await db.query('UPDATE owners SET birth_year=$1, age_source=$2, age_confidence=$3, updated_at=now() WHERE id=$4 AND birth_year IS NULL', [year, source, conf, found.owner.id]);
    }
    found.owner.birth_year = year;
    stats.updated += 1;
  }
  if (!opts.dryRun && stats.updated) require('./same-person').invalidate();
  return stats;
}

function hasBirthYear(owner) {
  return !!(owner && owner.birth_year != null && String(owner.birth_year).trim() !== '');
}
function ageLabel(owner, today) {
  if (!hasBirthYear(owner)) return '';
  const year = Number(owner.birth_year);
  const now = Number(String(today || '').slice(0, 4));
  if (!Number.isInteger(year) || year < 1900 || !Number.isInteger(now) || year > now) return '';
  const age = now - year;
  const parts = [`Born ${year}`, `age ${age} as of today`];
  if (owner.age_source) parts.push(String(owner.age_source));
  if (owner.age_confidence) parts.push(`${owner.age_confidence} confidence`);
  return parts.join(' · ');
}
function crmAgeNote(owner) {
  if (!owner || hasBirthYear(owner)) return '';
  const s = String(owner.age == null ? '' : owner.age).trim();
  if (!s) return '';
  if (/\bdeceased\b/i.test(s)) return `${s} · estate / heirs`;
  if (/^\d+$/.test(s)) {
    const age = Number(s);
    if (age >= 18 && age <= 110) return `Age ${age} · CRM age field · medium confidence`;
  }
  return '';
}

function parseAgeCsv(text) {
  const { parse } = require('csv-parse/sync');
  const rows = parse(String(text || ''), { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) out[String(key).trim().toLowerCase().replace(/\s+/g, '_')] = value;
    return out;
  });
}

module.exports = { importOwnerAges, applyResearchAges, classifyResearchRows, ageLabel, crmAgeNote, parseAgeCsv, birthYearFromRow, hasBirthYear };
