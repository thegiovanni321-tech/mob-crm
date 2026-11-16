// Same person: one owner record, or two owner records with the same normalized
// name and at least one shared phone. Name alone never matches. Phone alone never matches.
function normName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function phoneKeys(owner) {
  const out = new Set();
  if (!owner) return out;
  for (const key of ['phone1', 'phone2', 'phone3', 'phone4', 'phone5', 'phone']) {
    const digits = String(owner[key] || '').replace(/\D/g, '');
    if (digits.length >= 10) out.add(digits.slice(-10));
    else if (digits.length >= 7) out.add(digits);
  }
  return out;
}
function samePerson(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && Number(a.id) === Number(b.id)) return true;
  const left = normName(a.name);
  const right = normName(b.name);
  if (!left || left !== right) return false;
  const phones = phoneKeys(a);
  for (const phone of phoneKeys(b)) if (phones.has(phone)) return true;
  return false;
}
function personIndex(owners) {
  const list = [];
  const seen = new Set();
  for (const owner of owners || []) {
    const id = Number(owner.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(owner);
  }
  const parent = new Map(list.map((owner) => [Number(owner.id), Number(owner.id)]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = id;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    let pa = find(a);
    let pb = find(b);
    if (pa === pb) return;
    if (pa > pb) { const swap = pa; pa = pb; pb = swap; }
    parent.set(pb, pa);
  };
  // Same-person requires the same normalized name, so each name is its own bucket.
  // Inside a bucket, a shared phone (including a chain of shared phones) joins the records.
  const buckets = new Map();
  for (const owner of list) {
    const name = normName(owner.name);
    if (!name) continue;
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(owner);
  }
  for (const group of buckets.values()) {
    const byPhone = new Map();
    for (const owner of group) {
      const id = Number(owner.id);
      for (const phone of phoneKeys(owner)) {
        const prev = byPhone.get(phone);
        if (prev) union(prev, id);
        else byPhone.set(phone, id);
      }
    }
  }
  const keyOf = new Map();
  for (const owner of list) {
    const id = Number(owner.id);
    keyOf.set(id, 'p' + find(id));
  }
  return keyOf;
}
function collapseByOwner(rows, owners, keyOf) {
  const index = keyOf || personIndex(owners);
  const groups = new Map();
  const order = [];
  (rows || []).forEach((row, position) => {
    const propertyId = Number(row.propertyId || row.id);
    const ownerId = Number(row.ownerId || row.owner_id) || 0;
    const key = row.personKey || (ownerId && index.has(ownerId) ? index.get(ownerId) : 'solo:' + propertyId + ':' + position);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push({ ...row, propertyId, ownerId, _i: position });
  });
  return order.map((key) => {
    const seen = new Set();
    const items = [];
    for (const item of groups.get(key)) {
      if (!item.propertyId || seen.has(item.propertyId)) continue;
      seen.add(item.propertyId);
      items.push(item);
    }
    const primary = items[0] || {};
    const also = items.slice(1).map((item) => ({
      propertyId: item.propertyId,
      id: item.propertyId,
      address: item.address || '',
      city: item.city || '',
      state: item.state || '',
    }));
    return { ...primary, id: primary.propertyId || primary.id, also };
  });
}
function collapseProperties(rows, owners, links, keyOf) {
  const index = keyOf || personIndex(owners);
  const byProp = new Map();
  for (const link of links || []) {
    const pid = Number(link.property_id);
    if (!byProp.has(pid)) byProp.set(pid, []);
    byProp.get(pid).push(Number(link.owner_id));
  }
  const expanded = [];
  (rows || []).forEach((row, position) => {
    const pid = Number(row.id || row.propertyId);
    const keys = [];
    const seen = new Set();
    for (const oid of byProp.get(pid) || []) {
      const key = index.get(oid);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push({ key, oid });
    }
    if (!keys.length) expanded.push({ ...row, propertyId: pid, ownerId: 0, personKey: 'solo:' + pid, _i: position });
    else for (const item of keys) expanded.push({ ...row, propertyId: pid, ownerId: item.oid, personKey: item.key, _i: position });
  });
  return collapseByOwner(expanded, owners, index);
}
function alsoApplies(propertyId, ownersOnProperty, owners, links, keyOf) {
  const index = keyOf || personIndex(owners);
  const sameIds = (ownerId) => {
    const key = index.get(Number(ownerId));
    const ids = new Set();
    if (!key) return ids;
    for (const [id, person] of index) if (person === key) ids.add(id);
    return ids;
  };
  return (ownersOnProperty || []).map((owner) => {
    const ids = sameIds(owner.id);
    const seen = new Set();
    const properties = [];
    for (const link of links || []) {
      const pid = Number(link.property_id);
      if (pid === Number(propertyId) || seen.has(pid) || !ids.has(Number(link.owner_id))) continue;
      seen.add(pid);
      properties.push({ id: pid, address: link.address || '', city: link.city || '', state: link.state || '', ownerId: Number(link.owner_id) });
    }
    return { ownerId: Number(owner.id), name: owner.name || owner.entity || 'Owner', properties };
  }).filter((group) => group.properties.length);
}
function checkedAlso(body) {
  const ids = [];
  for (const [key, value] of Object.entries(body || {})) {
    const match = /^also_(\d+)$/.exec(key);
    if (match && String(value) === '1') ids.push(Number(match[1]));
  }
  return ids;
}
const CACHE_MS = 45000;
let cache = null;
function invalidate() { cache = null; }
async function loadPeople(db) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  const owners = await db.query('SELECT id, name, entity, phone1, phone2, phone3, phone4, phone5 FROM owners');
  const links = await db.query(`SELECT po.property_id, po.owner_id, p.address, p.city, p.state
    FROM property_owners po JOIN properties p ON p.id = po.property_id`);
  cache = { at: now, owners, links, keyOf: personIndex(owners) };
  return cache;
}
const NAME_SQL = `btrim(regexp_replace(regexp_replace(lower(coalesce(name,'')), '[^a-z0-9]+', ' ', 'g'), '\\s+', ' ', 'g'))`;
async function loadRelated(db, ownersOnProperty) {
  const names = [...new Set((ownersOnProperty || []).map((owner) => normName(owner.name)).filter(Boolean))];
  const owners = names.length
    ? await db.query(`SELECT id, name, entity, phone1, phone2, phone3, phone4, phone5 FROM owners WHERE ${NAME_SQL} = ANY($1::text[])`, [names])
    : (ownersOnProperty || []).map((owner) => ({ ...owner }));
  const ids = [...new Set(owners.map((owner) => Number(owner.id)).filter(Boolean))];
  const links = ids.length
    ? await db.query(`SELECT po.property_id, po.owner_id, p.address, p.city, p.state
      FROM property_owners po JOIN properties p ON p.id = po.property_id
      WHERE po.owner_id = ANY($1::int[])`, [ids])
    : [];
  return { owners, links, keyOf: personIndex(owners) };
}
module.exports = {
  normName, phoneKeys, samePerson, personIndex, collapseByOwner, collapseProperties, alsoApplies, checkedAlso, loadPeople, loadRelated, invalidate, CACHE_MS,
};
