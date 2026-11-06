const test = require('node:test');
const assert = require('node:assert/strict');
const Area = require('../src/area-comps');

const CREXI = Area.CREXI_NOI_SF_SOURCE;
const subject = { id: 1, address: '100 Synthetic Medical Plaza', city: 'Sampleville', state: 'FL', lat: 28, lng: -82 };

function sale(over) {
  return { id: 10, address: '210 Peer Medical', city: 'Sampleville', state: 'FL', sale_date: '2024-06-01', price: 2100000, rba: 10000, cap_rate: 0.07, land_use: 'Medical Office', source: 'Synthetic county', verified: false, ...over };
}
function lease(over) {
  return { id: 30, address: '240 Peer Medical', city: 'Sampleville', state: 'FL', tenant: 'Sample Clinic', start_date: '2023-01-01', sf_leased: 4000, rent_psf: 32.5, lease_type: 'NNN', term_months: 84, land_use: 'Professional Office', source: 'Broker rent schedule 2026-12-01', verified: true, ...over };
}

test('distance is used only when both sides have coordinates', () => {
  const both = Area.proximity(subject, { lat: 28.0145, lng: -82, city: 'Sampleville', state: 'FL' });
  assert.equal(both.kind, 'distance');
  assert.match(both.label, /^\d+\.\d mi$/);
  const oneSided = Area.proximity(subject, { city: 'Sampleville', state: 'FL' });
  assert.equal(oneSided.kind, 'city');
  assert.equal(oneSided.label, 'Same city');
  assert.equal(oneSided.miles, null);
  const noSubject = Area.proximity({ city: 'Sampleville', state: 'FL' }, { lat: 28.01, lng: -82, city: 'Sampleville', state: 'FL' });
  assert.equal(noSubject.label, 'Same city');
  const stateOnly = Area.proximity({ state: 'FL' }, { state: 'FL', city: 'Otherplace' });
  assert.equal(stateOnly.label, 'Same state');
});

test('does not invent a market when city, state, and coordinates are missing', () => {
  const model = Area.buildAreaComps({ id: 1, address: 'Nowhere' }, [sale({})], [lease({})], []);
  assert.equal(model.shown, false);
  const html = Area.renderAreaComps(model);
  assert.match(html, /coordinates are unknown/);
  assert.doesNotMatch(html, /Same city|mi/);
});

test('area set excludes the subject, other property types, far comps, and duplicates', () => {
  const rows = [
    sale({ id: 1, address: '100 Synthetic Medical Plaza', property_id: 1, price: 900000 }),
    sale({ id: 2, address: '210 Peer Medical', verified: false, source: 'Synthetic county' }),
    sale({ id: 3, address: '210 Peer Medical', verified: true, source: 'Synthetic broker', cap_rate: 0.065, price: 2100000 }),
    sale({ id: 4, address: '400 Retail Strip', land_use: 'Retail', price: 5000000 }),
    sale({ id: 5, address: '500 Distant Office', city: 'Otherplace', lat: 40, lng: -82, price: 3000000 }),
    sale({ id: 6, address: '230 Near Medical', city: 'Northplace', state: 'FL', lat: 28.02, lng: -82, price: 1800000, rba: 9000, cap_rate: null }),
    sale({ id: 7, address: '220 Plain Medical', cap_rate: null, price: null, rba: null, sale_date: null, verified: false }),
  ];
  const model = Area.buildAreaComps(subject, rows, [], []);
  const addrs = model.closed.map((c) => c.address);
  assert.ok(!addrs.includes('100 Synthetic Medical Plaza'));
  assert.ok(!addrs.includes('400 Retail Strip'));
  assert.ok(!addrs.includes('500 Distant Office'));
  assert.equal(addrs.filter((a) => a === '210 Peer Medical').length, 1);
  assert.equal(model.closed.find((c) => c.address === '210 Peer Medical').verified, true);
  assert.equal(model.hiddenSaleDupes, 1);
  assert.ok(addrs.includes('230 Near Medical'));
  assert.equal(model.closed.find((c) => c.address === '230 Near Medical')._prox.kind, 'distance');
  assert.ok(addrs.includes('220 Plain Medical'));
  assert.equal(model.closed.find((c) => c.address === '220 Plain Medical')._prox.label, 'Same city');
  const html = Area.renderAreaComps(model);
  assert.match(html, /Same city/);
  assert.match(html, /mi/);
  assert.match(html, />Unknown</);
  assert.match(html, /Full sale comps list/);
  assert.match(html, /\/comps\/sales\?city=Sampleville&amp;state=FL/);
  assert.doesNotMatch(html, /400 Retail Strip|500 Distant Office|100 Synthetic Medical Plaza/);
});

test('asking records are not treated as closed sales', () => {
  const askingSale = sale({ id: 8, address: '310 Asking Sale', sale_date: null, price: 2500000, notes: 'For sale at an asking price', cap_rate: 0.08 });
  const listing = { id: 9, _kind: 'listing', record_kind: 'listing', address: '300 Asking Lane', city: 'Sampleville', state: 'FL', asking_price: 2400000, status: 'Active', sf: 8000 };
  const closed = sale({ id: 11, address: '210 Peer Medical' });
  const model = Area.buildAreaComps(subject, [askingSale, closed], [], [listing]);
  assert.equal(model.closed.length, 1);
  assert.equal(model.asking.length, 2);
  assert.equal(model.medianPpsf, 210);
  const html = Area.renderAreaComps(model);
  assert.match(html, /Asking, not closed/);
  assert.match(html, /not closed/);
  const closedTable = html.split('<h3>Leases')[0];
  assert.doesNotMatch(closedTable, /310 Asking Sale|300 Asking Lane/);
});

test('Crexi NOI/SF is not shown as actual rent; a later rent source is', () => {
  const crexi = lease({ id: 1, address: '240 Peer Medical', rent_psf: 41.25, source: CREXI, verified: false, lease_type: null, term_months: null, tenant: null });
  const later = lease({ id: 2, address: '250 Other Medical', rent_psf: 28.5, source: 'Broker rent schedule 2026-12-01' });
  const sameDealLater = lease({ id: 3, address: '240 Peer Medical', rent_psf: 33, source: 'Explicit rent roll 2026-12-15', tenant: null, lease_type: 'NNN', term_months: 60 });
  const model = Area.buildAreaComps(subject, [], [crexi, later, sameDealLater], []);
  const shown = model.shownLeases.map((c) => c.source);
  assert.ok(shown.includes('Broker rent schedule 2026-12-01'));
  assert.ok(shown.includes('Explicit rent roll 2026-12-15'));
  assert.ok(!shown.includes(CREXI));
  assert.equal(model.medianActualRent, 30.75);
  const html = Area.renderAreaComps(model);
  assert.match(html, /Actual \$28\.50\/SF/);
  assert.match(html, /Actual \$33\.00\/SF/);
  assert.doesNotMatch(html, /Actual \$41\.25/);
  assert.match(html, /excluded from actual rent/);
  const onlyCrexi = Area.buildAreaComps(subject, [], [crexi], []);
  const onlyHtml = Area.renderAreaComps(onlyCrexi);
  assert.match(onlyHtml, /NOI\/SF \$41\.25/);
  assert.match(onlyHtml, /Median actual rent unknown/);
  assert.doesNotMatch(onlyHtml, /Actual \$/);
  const blank = lease({ id: 4, address: '260 Bare Medical', rent_psf: null, tenant: '', lease_type: '', term_months: null, source: '' });
  const blankHtml = Area.renderAreaComps(Area.buildAreaComps(subject, [], [blank], []));
  assert.match(blankHtml, /Unknown/);
});

test('rent basis helper does not rewrite the stored number', () => {
  const row = { source: CREXI, rent_psf: 41.25 };
  const basis = Area.leaseRentBasis(row);
  assert.equal(basis.basis, 'noi_psf');
  assert.equal(basis.value, 41.25);
  assert.equal(row.rent_psf, 41.25);
  assert.equal(Area.leaseRentBasis({ source: 'Broker rent schedule 2026-12-01', rent_psf: 41.25 }).basis, 'actual');
});

test('rendered comps escape HTML in addresses', () => {
  const html = Area.renderAreaComps(Area.buildAreaComps(subject, [sale({ address: '210 <script> Peer' })], [], []));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
