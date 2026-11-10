const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFollowUps, classifyText, daysBetween, STALE_DAYS, SIGNALS } = require('../src/followups');

const TODAY = '2026-11-10';
function daysAgo(n) {
  const [y, m, d] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}
function prop(over) {
  return { id: 1, address: '1 Synthetic Plaza', city: 'Sampleville', state: 'FL', status: 'Talked', last_contacted: null, callback_date: null, notes: '', owners: [{ id: 9, name: 'Ada Sample', entity: 'Sample Holdings' }], ...over };
}
function talk(over) {
  return { id: 1, property_id: 1, owner_id: 9, kind: 'call', outcome: 'Talked', notes: 'Spoke briefly.', activity_date: daysAgo(200), ...over };
}

test('six-month boundary uses a strict 182 days and ignores attempts', () => {
  assert.equal(STALE_DAYS, 182);
  assert.equal(daysBetween(TODAY, daysAgo(182)), 182);
  const old = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(183) })] });
  assert.equal(old.ranked.length, 1);
  assert.equal(old.ranked[0].ownerName, 'Ada Sample');
  assert.equal(old.ranked[0].ownerEntity, 'Sample Holdings');
  assert.equal(old.ranked[0].daysSince, 183);
  assert.equal(old.ranked[0].score, SIGNALS.stale);
  const edge = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(182) })] });
  assert.equal(edge.ranked.length, 0);
  const recent = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(30) })] });
  assert.equal(recent.ranked.length, 0);
  const attempt = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Attempted' })], activities: [talk({ outcome: 'No answer', kind: 'call' }), talk({ id: 2, outcome: 'Left voicemail' })] });
  assert.equal(attempt.ranked.length, 0);
});

test('a later call, a future callback, do-not-call, and wrong number drop the stale row', () => {
  const later = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk(), talk({ id: 2, outcome: 'No answer', activity_date: daysAgo(2), notes: '' })] });
  assert.equal(later.ranked.length, 0);
  const scheduled = buildFollowUps({ today: TODAY, properties: [prop({ callback_date: '2026-12-01' })], activities: [talk()] });
  assert.equal(scheduled.ranked.length, 0);
  const dnc = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Do not call' })], activities: [talk()] });
  assert.equal(dnc.ranked.length, 0);
  const wrong = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk(), talk({ id: 3, outcome: 'Wrong number', activity_date: daysAgo(1) })] });
  assert.equal(wrong.ranked.length, 0);
});

test('imported Talked and imported last-contacted count, import Called does not', () => {
  const imported = buildFollowUps({ today: TODAY, properties: [prop({ last_contacted: daysAgo(200) })], activities: [talk({ kind: 'import', outcome: 'Talked', activity_date: daysAgo(200) })] });
  assert.equal(imported.ranked.length, 1);
  const onlyLast = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Talked', last_contacted: daysAgo(200) })], activities: [] });
  assert.equal(onlyLast.ranked.length, 1);
  const called = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Attempted', last_contacted: daysAgo(200) })], activities: [talk({ kind: 'import', outcome: 'Called', activity_date: daysAgo(200) })] });
  assert.equal(called.ranked.length, 0);
});

test('sell interest and later-call phrases are listed, negations are excluded', () => {
  const sell = buildFollowUps({ today: TODAY, properties: [prop({ notes: '' })], activities: [talk({ notes: 'She is interested in selling the building.' })] });
  assert.equal(sell.ranked.length, 1);
  assert.match(sell.ranked[0].tags.map((t) => t.label).join(' '), /^interested in selling/);
  assert.match(sell.ranked[0].snippet, /interested in selling/);
  const neg = classifyText('They are not selling and have no interest in selling.');
  assert.equal(neg.sell, null);
  assert.ok(neg.excluded.length >= 1);
  const negRow = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ notes: 'Owner is not selling. Never selling.' })] });
  assert.equal(negRow.ranked.length, 0);
  assert.ok(negRow.excluded.some((e) => /not selling/i.test(e.phrase)));
  assert.match(negRow.excluded.find((e) => /never selling/i.test(e.phrase)).snippet, /Never selling/);
  assert.doesNotMatch(negRow.excluded.map((e) => e.snippet).join(' '), /They are \./);
  const never = classifyText('He said never selling, do not call back.');
  assert.equal(never.sell, null);
  assert.equal(never.later, null);
  const due = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(200), notes: 'Please call back in 3 months.' })] });
  assert.equal(due.ranked.length, 1);
  assert.match(due.ranked[0].tags.map((t) => t.label).join(' '), /call back in X months/);
  assert.match(due.ranked[0].tags.map((t) => t.label).join(' '), /due /);
  const notYet = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(10), notes: 'Call back in 6 months.' })] });
  assert.equal(notYet.ranked.length, 0);
  const undated = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ notes: 'Try again later after the lease.' })] });
  assert.equal(undated.ranked.length, 1);
  assert.match(undated.ranked[0].tags.map((t) => t.label).join(' '), /try again later/);
  const after = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: '2024-01-10', notes: 'Call back after June 1, 2024.' })] });
  assert.equal(after.ranked.length, 1);
  assert.match(after.ranked[0].tags.map((t) => t.label).join(' '), /call back after date/);
  assert.match(after.ranked[0].tags.map((t) => t.label).join(' '), /2024-06-01/);
  const afterFuture = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(20), notes: 'Call back after 2027-01-15.' })] });
  assert.equal(afterFuture.ranked.length, 0);
});

test('curly apostrophes and want-to-sell negations stay off missed follow-ups', () => {
  const forms = [
    'Doesn\u2019t want to sell',
    'don\u2019t want to sell',
    'does not want to sell',
    'do not want to sell',
    'didn\u2019t want to sell',
    'did not want to sell',
    'isn\u2019t interested in selling',
    'is not interested in selling',
    'won\u2019t sell',
    'wouldn\u2019t want to sell',
    'not want to sell',
    'not looking to sell',
    'never wants to sell',
    'never looking to sell',
    'no interest in selling',
    'has no plans to sell',
    'no intention of selling',
    'not open to offers',
    'not thinking about selling',
    'not considering selling',
    'not yet looking to sell',
    'doesn\u2019t plan to sell',
    'does   not\twant to sell',
  ];
  for (const notes of forms) {
    const found = classifyText(notes);
    assert.equal(found.sell, null, notes);
    assert.ok(found.excluded.length >= 1, notes);
    assert.match(found.excluded.map((e) => e.snippet).join(' '), /sell|offers/i, notes);
    const row = buildFollowUps({
      today: TODAY,
      properties: [prop({ id: 440, notes })],
      activities: [talk({ property_id: 440, notes: 'Spoke briefly.' })],
    });
    assert.equal(row.ranked.length, 0, notes);
    assert.ok(row.excluded.some((e) => e.snippet && e.phrase), notes);
  }
  const straight = classifyText("Doesn't want to sell");
  assert.equal(straight.sell, null);
  assert.match(straight.excluded[0].phrase, /doesn't want to sell/i);
  const wants = classifyText('She wants to sell the building.');
  assert.equal(wants.sell.phrase, 'wants to sell');
  const looking = classifyText('They are looking to sell.');
  assert.equal(looking.sell.phrase, 'looking to sell');
  const contrast = classifyText('Doesn\u2019t want to sell the lot, but is looking to sell the building.');
  assert.equal(contrast.sell.phrase, 'looking to sell');
  assert.match(contrast.excluded.map((e) => e.phrase).join(' '), /want to sell/i);
  const onlyNeg = buildFollowUps({
    today: TODAY,
    properties: [prop({ notes: 'Doesn\u2019t want to sell' })],
    activities: [talk({ notes: 'Talked for a minute.' })],
  });
  assert.equal(onlyNeg.ranked.length, 0);
  assert.ok(onlyNeg.excluded.some((e) => /want to sell/i.test(e.phrase)));
  assert.ok(onlyNeg.excluded.some((e) => /want to sell/i.test(e.snippet)));
});

test('a newer call drops a missed follow-up', () => {
  const gone = buildFollowUps({
    today: TODAY, properties: [prop()],
    activities: [talk({ notes: 'Open to offers next spring.' }), talk({ id: 8, outcome: 'No answer', activity_date: daysAgo(1), notes: '' })],
  });
  assert.equal(gone.ranked.length, 0);
});

test('state filter limits both lists', () => {
  const fl = prop({ id: 1, state: 'FL' });
  const ga = prop({ id: 2, state: 'GA', address: '2 Synthetic', owners: [{ id: 4, name: 'Bea Sample', entity: 'Bea LLC' }] });
  const activities = [talk({ property_id: 1 }), talk({ id: 2, property_id: 2, owner_id: 4, notes: 'May sell this year.' })];
  const only = buildFollowUps({ today: TODAY, properties: [fl, ga], activities, state: 'GA' });
  assert.equal(only.ranked.length, 1);
  assert.equal(only.ranked[0].state, 'GA');
  assert.equal(only.ranked[0].address, '2 Synthetic');
  assert.match(only.ranked[0].tags.map((t) => t.label).join(' '), /may sell/);
});

test('a later positive conversation outranks an older not-selling note', () => {
  const renewed = buildFollowUps({
    today: TODAY,
    properties: [prop({ notes: 'Doesn\u2019t want to sell' })],
    activities: [
      talk({ id: 1, activity_date: '2020-01-15', notes: 'Doesn\u2019t want to sell' }),
      talk({ id: 2, activity_date: daysAgo(40), notes: 'She is now interested in selling.' }),
    ],
  });
  assert.equal(renewed.ranked.length, 1);
  assert.match(renewed.ranked[0].tags.map((t) => t.label).join(' '), /interested in selling/);
  assert.equal(renewed.excluded.length, 0);
  const stillNo = buildFollowUps({
    today: TODAY,
    properties: [prop({ notes: 'Doesn\u2019t want to sell' })],
    activities: [talk({ activity_date: daysAgo(40), notes: 'Spoke briefly.' })],
  });
  assert.equal(stillNo.ranked.length, 0);
  assert.equal(stillNo.excluded.length, 1);
});

test('scores put sell interest above a due callback, then 75+ above 65+, then a neutral talk', () => {
  function owned(id, birth, confidence) {
    return prop({
      id, address: `${id} Synthetic`,
      owners: [{ id, name: 'Owner ' + id, entity: 'Sample LLC', birth_year: birth, age_confidence: confidence, age_source: birth ? 'Nexis' : null }],
    });
  }
  const properties = [
    owned(1, null, null),
    owned(2, 1961, 'high'),
    owned(3, 1950, 'medium'),
    owned(4, null, null),
    owned(5, null, null),
    owned(6, 1940, 'low'),
    prop({ id: 7, address: '7 Synthetic', year_built: '1920', owners: [{ id: 7, name: 'Owner 7', entity: 'Sample LLC', age: '90' }] }),
  ];
  const activities = [
    talk({ id: 1, property_id: 1, owner_id: 1, notes: 'Spoke briefly.' }),
    talk({ id: 2, property_id: 2, owner_id: 2, notes: 'Spoke briefly.' }),
    talk({ id: 3, property_id: 3, owner_id: 3, notes: 'Spoke briefly.' }),
    talk({ id: 4, property_id: 4, notes: 'Please call back in 3 months.' }),
    talk({ id: 5, property_id: 5, notes: 'She is interested in selling.' }),
    talk({ id: 6, property_id: 6, owner_id: 6, notes: 'Spoke briefly.' }),
    talk({ id: 7, property_id: 7, owner_id: 7, notes: 'Spoke briefly.' }),
  ];
  const { ranked } = buildFollowUps({ today: TODAY, properties, activities });
  const ids = ranked.map((r) => r.propertyId);
  assert.deepEqual(ids.slice(0, 4), [5, 4, 7, 3]);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[1].score > ranked[2].score);
  assert.ok(ranked[2].score > ranked[3].score);
  assert.match(ranked.find((r) => r.propertyId === 3).tags.map((t) => t.label).join(' '), /Age 76 \(born 1950, Nexis, medium\)/);
  assert.match(ranked.find((r) => r.propertyId === 2).tags.map((t) => t.label).join(' '), /Age 65 \(born 1961, Nexis, high\)/);
  const low = ranked.find((r) => r.propertyId === 6);
  const plain = ranked.find((r) => r.propertyId === 1);
  const textAge = ranked.find((r) => r.propertyId === 7);
  assert.equal(low.score, plain.score);
  assert.equal(plain.score, SIGNALS.stale);
  assert.match(textAge.tags.map((t) => t.label).join(' '), /Age 90 \(CRM age field, medium\)/);
  assert.doesNotMatch(textAge.tags.map((t) => t.label).join(' '), /1920/);
  const notInterested = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ outcome: 'Not interested', notes: '' })] });
  assert.equal(notInterested.ranked.length, 0);
  assert.equal(notInterested.excluded.length, 1);
});

test('health matches owner illness, not a tenant or company name', () => {
  function row(notes, age) {
    return buildFollowUps({
      today: TODAY,
      properties: [prop({ notes, owners: [{ id: 9, name: 'Ada Sample', entity: 'Sample Holdings', age: age || null }] })],
      activities: [talk({ notes: 'Spoke briefly.' })],
    });
  }
  for (const brand of ["Tenant is Onsite Women's Health.", 'Building is Advent Health.', 'Reliant Health occupies the suite.']) {
    const branded = row(brand);
    assert.equal(branded.ranked[0].score, SIGNALS.stale, brand);
    assert.doesNotMatch(branded.ranked[0].tags.map((t) => t.label).join(' '), /Health/);
  }
  for (const real of ['Owner has health issues.', 'She is in poor health.', 'Call about her health.', 'Selling for health reasons.', 'A long illness.']) {
    const hit = row(real);
    assert.ok(hit.ranked[0].score >= SIGNALS.stale + SIGNALS.retirement, real);
    assert.match(hit.ranked[0].tags.map((t) => t.label).join(' '), /Health/);
  }
  const negated = row('He is not in poor health and is not retiring.');
  assert.equal(negated.ranked[0].score, SIGNALS.stale);
  const retiring = row('He is retiring next year.');
  assert.match(retiring.ranked[0].tags.map((t) => t.label).join(' '), /Retiring/);
});

test('a clean CRM age counts, a deceased age is an estate signal, and a birth year wins', () => {
  function aged(age, birth, confidence) {
    return buildFollowUps({
      today: TODAY,
      properties: [prop({ owners: [{ id: 9, name: 'Ada Sample', entity: 'Sample Holdings', age, birth_year: birth, age_confidence: confidence, age_source: birth ? 'Nexis' : null }] })],
      activities: [talk({ notes: 'Spoke briefly.' })],
    }).ranked[0];
  }
  const ninety = aged('93', null, null);
  assert.match(ninety.tags.map((t) => t.label).join(' '), /Age 93 \(CRM age field, medium\)/);
  assert.ok(ninety.score > aged('65', null, null).score);
  assert.equal(aged('40', null, null).score, SIGNALS.stale);
  const dead = aged('Deceased', null, null);
  assert.match(dead.tags.map((t) => t.label).join(' '), /Deceased/);
  assert.doesNotMatch(dead.tags.map((t) => t.label).join(' '), /CRM age field/);
  const deadAge = aged('68 (Deceased)', null, null);
  assert.match(deadAge.tags.map((t) => t.label).join(' '), /Deceased/);
  assert.doesNotMatch(deadAge.tags.map((t) => t.label).join(' '), /Age 68/);
  const nexis = aged('40', 1950, 'high');
  assert.match(nexis.tags.map((t) => t.label).join(' '), /born 1950, Nexis, high/);
  assert.doesNotMatch(nexis.tags.map((t) => t.label).join(' '), /CRM age field/);
  const low = aged('93', 1940, 'low');
  assert.equal(low.score, SIGNALS.stale);
});
