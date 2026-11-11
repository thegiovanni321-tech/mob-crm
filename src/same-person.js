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
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (samePerson(list[i], list[j])) union(Number(list[i].id), Number(list[j].id));
    }
  }
  const keyOf = new Map();
  for (const owner of list) {
    const id = Number(owner.id);
    keyOf.set(id, 'p' + find(id));
  }
  return keyOf;
}
function collapseByOwner(rows, owners) {
  const keyOf = personIndex(owners);
  const groups = new Map();
  const order = [];
  (rows || []).forEach((row, index) => {
    const propertyId = Number(row.propertyId || row.id);
    const ownerId = Number(row.ownerId || row.owner_id) || 0;
    const key = row.personKey || (ownerId && keyOf.has(ownerId) ? keyOf.get(ownerId) : 'solo:' + propertyId + ':' + index);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push({ ...row, propertyId, ownerId, _i: index });
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
function collapseProperties(rows, owners, links) {
  const keyOf = personIndex(owners);
  const byProp = new Map();
  for (const link of links || []) {
    const pid = Number(link.property_id);
    if (!byProp.has(pid)) byProp.set(pid, []);
    byProp.get(pid).push(Number(link.owner_id));
  }
  const expanded = [];
  (rows || []).forEach((row, index) => {
    const pid = Number(row.id || row.propertyId);
    const keys = [];
    const seen = new Set();
    for (const oid of byProp.get(pid) || []) {
      const key = keyOf.get(oid);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push({ key, oid });
    }
    if (!keys.length) expanded.push({ ...row, propertyId: pid, ownerId: 0, personKey: 'solo:' + pid, _i: index });
    else for (const item of keys) expanded.push({ ...row, propertyId: pid, ownerId: item.oid, personKey: item.key, _i: index });
  });
  return collapseByOwner(expanded, owners);
}
function alsoApplies(propertyId, ownersOnProperty, owners, links) {
  const keyOf = personIndex(owners);
  const sameIds = (ownerId) => {
    const key = keyOf.get(Number(ownerId));
    const ids = new Set();
    if (!key) return ids;
    for (const [id, person] of keyOf) if (person === key) ids.add(id);
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
async function loadPeople(db) {
  const owners = await db.query('SELECT id, name, entity, phone1, phone2, phone3, phone4, phone5 FROM owners');
  const links = await db.query(`SELECT po.property_id, po.owner_id, p.address, p.city, p.state
    FROM property_owners po JOIN properties p ON p.id = po.property_id`);
  return { owners, links };
}
module.exports = {
  normName, phoneKeys, samePerson, personIndex, collapseByOwner, collapseProperties, alsoApplies, checkedAlso, loadPeople,
};
