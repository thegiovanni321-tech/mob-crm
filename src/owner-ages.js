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

module.exports = { importOwnerAges, ageLabel, crmAgeNote, parseAgeCsv, birthYearFromRow, hasBirthYear };
