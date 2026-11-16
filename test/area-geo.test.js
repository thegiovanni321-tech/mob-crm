const test = require('node:test');
const assert = require('node:assert/strict');
const Area = require('../src/area-comps');
const geo = require('../src/geo/reference');

function sale(over) {
  return { id: 10, address: '1 Synthetic Medical', sale_date: '2024-06-01', price: 2000000, rba: 10000, cap_rate: 0.07, land_use: 'Medical Office', source: 'Synthetic', verified: false, ...over };
}

test('census reference has public-domain provenance and a known place center', () => {
  assert.match(geo.PROVENANCE.publisher, /Census Bureau/);
  assert.match(geo.PROVENANCE.license, /public domain/);
  assert.match(geo.PROVENANCE.url, /census\.gov/);
  const miami = geo.placePoint('Miami', 'FL');
  assert.ok(miami);
  assert.equal(miami.basis, 'city');
  assert.ok(Math.abs(miami.lat - 25.775) < 0.02);
  assert.ok(Math.abs(miami.lng + 80.209) < 0.02);
  const zip = geo.zipPoint('10001');
  assert.ok(zip && zip.basis === 'zip');
});

test('missing coordinates use census city centers for nearby cities, including across a state line', () => {
  const subject = { id: 1, address: '10 Synthetic Plaza', city: 'Miami', state: 'FL' };
  const beach = sale({ id: 2, address: '20 Synthetic Ave', city: 'Miami Beach', state: 'FL' });
  const far = sale({ id: 3, address: '30 Synthetic Rd', city: 'Tallahassee', state: 'FL' });
  const cross = sale({ id: 4, address: '40 Synthetic St', city: 'Kansas City', state: 'KS' });
  const kc = { id: 5, address: '50 Synthetic Blvd', city: 'Kansas City', state: 'MO' };
  const nearMiami = Area.buildAreaComps(subject, [beach, far], [], []);
  const addrs = nearMiami.closed.map((c) => c.address);
  assert.ok(addrs.includes('20 Synthetic Ave'));
  assert.ok(!addrs.includes('30 Synthetic Rd'));
  const beachRow = nearMiami.closed.find((c) => c.address === '20 Synthetic Ave');
  assert.equal(beachRow._prox.kind, 'approx');
  assert.match(beachRow._prox.label, /approx \d+\.\d mi \(city centers\)/);
  const html = Area.renderAreaComps(nearMiami);
  assert.match(html, /U\.S\. Census/);
  assert.match(html, /approx /);
  const crossState = Area.buildAreaComps(kc, [cross], [], []);
  assert.equal(crossState.closed.length, 1);
  assert.match(crossState.closed[0]._prox.label, /approx/);
  assert.ok(crossState.closed[0]._prox.miles < 25);
});

test('an unknown city without coordinates stays on same-city wording and does not borrow other cities', () => {
  const subject = { id: 1, address: '1 Synthetic Plaza', city: 'Sampleville', state: 'FL' };
  const same = sale({ id: 2, address: '2 Synthetic Ave', city: 'Sampleville', state: 'FL' });
  const other = sale({ id: 3, address: '3 Synthetic Rd', city: 'Otherplace', state: 'FL' });
  const model = Area.buildAreaComps(subject, [same, other], [], []);
  assert.deepEqual(model.closed.map((c) => c.address), ['2 Synthetic Ave']);
  assert.equal(model.closed[0]._prox.label, 'Same city');
  assert.equal(model.closed[0]._prox.miles, null);
});
