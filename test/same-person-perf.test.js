const test = require('node:test');
const assert = require('node:assert/strict');
const People = require('../src/same-person');

function phoneKeys(owner) {
  const out = new Set();
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
  const left = People.normName(a.name);
  const right = People.normName(b.name);
  if (!left || left !== right) return false;
  const phones = phoneKeys(a);
  for (const phone of phoneKeys(b)) if (phones.has(phone)) return true;
  return false;
}
function personIndexSlow(owners) {
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
    return root;
  };
  const union = (a, b) => {
    const pa = find(a);
    const pb = find(b);
    if (pa === pb) return;
    if (pa < pb) parent.set(pb, pa);
    else parent.set(pa, pb);
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (samePerson(list[i], list[j])) union(Number(list[i].id), Number(list[j].id));
    }
  }
  const keyOf = new Map();
  for (const owner of list) keyOf.set(Number(owner.id), find(Number(owner.id)));
  return keyOf;
}
function components(keyOf) {
  const groups = new Map();
  for (const [id, key] of keyOf) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  return [...groups.values()].map((ids) => ids.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}
function signature(rows) {
  return rows.map((row) => ({
    id: row.propertyId || row.id,
    also: (row.also || []).map((item) => item.propertyId),
  }));
}

test('the name-bucket index matches the pairwise same-person grouping', () => {
  const owners = [];
  const names = ['Ada Sample', 'Bea Sample', 'Cara Sample', 'No Phone', ''];
  for (let i = 1; i <= 240; i++) {
    const name = names[i % names.length];
    const shared = i % 2 === 0 ? '5550101000' : '5550102000';
    owners.push({
      id: i,
      name: i % 17 === 0 ? 'Ada Sample' : name,
      phone1: i % 17 === 0 ? '555-010-1000' : `(${shared.slice(0, 3)}) ${shared.slice(3, 6)}-${shared.slice(6)}`,
      phone2: i % 29 === 0 ? '5550101000' : '',
    });
  }
  assert.deepEqual(components(People.personIndex(owners)), components(personIndexSlow(owners)));
  const ranked = owners.slice(0, 180).map((owner, n) => ({
    propertyId: 1000 + n,
    ownerId: owner.id,
    address: 'Property ' + n,
    city: 'Sampleville',
    state: n % 2 ? 'FL' : 'GA',
  }));
  const excluded = owners.slice(40, 140).map((owner, n) => ({
    propertyId: 2000 + n,
    ownerId: owner.id,
    address: 'Hidden ' + n,
    phrase: 'not selling',
  }));
  const links = ranked.map((row) => ({ property_id: row.propertyId, owner_id: row.ownerId, address: row.address, city: row.city, state: row.state }));
  const fastRanked = People.collapseByOwner(ranked, owners, People.personIndex(owners));
  const slowRanked = People.collapseByOwner(ranked, owners, personIndexSlow(owners));
  assert.deepEqual(signature(fastRanked), signature(slowRanked));
  const fastHidden = People.collapseByOwner(excluded, owners, People.personIndex(owners));
  const slowHidden = People.collapseByOwner(excluded, owners, personIndexSlow(owners));
  assert.deepEqual(signature(fastHidden), signature(slowHidden));
  const fastDue = People.collapseProperties(ranked.map((row) => ({ id: row.propertyId, address: row.address, city: row.city, state: row.state })), owners, links, People.personIndex(owners));
  const slowDue = People.collapseProperties(ranked.map((row) => ({ id: row.propertyId, address: row.address, city: row.city, state: row.state })), owners, links, personIndexSlow(owners));
  assert.deepEqual(signature(fastDue), signature(slowDue));
  const targets = People.alsoApplies(ranked[0].propertyId, [owners[0]], owners, links, People.personIndex(owners));
  const slowTargets = People.alsoApplies(ranked[0].propertyId, [owners[0]], owners, links, personIndexSlow(owners));
  assert.deepEqual(targets, slowTargets);
});

test('three thousand owners are indexed in well under 200ms', () => {
  const owners = [];
  for (let i = 1; i <= 3000; i++) {
    owners.push({
      id: i,
      name: 'Owner ' + (i % 400),
      phone1: '555' + String(1000000 + (i % 80)),
      phone2: i % 25 === 0 ? '5550101999' : '',
    });
  }
  const started = performance.now();
  const index = People.personIndex(owners);
  const elapsed = performance.now() - started;
  assert.equal(index.size, 3000);
  assert.ok(elapsed < 200, 'personIndex took ' + elapsed.toFixed(1) + 'ms');
});

test('the people cache is reused until an owner or activity write clears it', async () => {
  People.invalidate();
  let queries = 0;
  const db = {
    query: async (sql) => {
      queries += 1;
      if (String(sql).includes('property_owners')) return [{ property_id: 1, owner_id: 1, address: '1 Main', city: 'Tampa', state: 'FL' }];
      return [{ id: 1, name: 'Ada Sample', phone1: '5550101000' }];
    },
  };
  await People.loadPeople(db);
  await People.loadPeople(db);
  assert.equal(queries, 2);
  People.invalidate();
  await People.loadPeople(db);
  assert.equal(queries, 4);
});
