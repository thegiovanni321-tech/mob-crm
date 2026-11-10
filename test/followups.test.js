const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFollowUps, classifyText, daysBetween, STALE_DAYS } = require('../src/followups');

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
  assert.equal(old.stale.length, 1);
  assert.equal(old.stale[0].ownerName, 'Ada Sample');
  assert.equal(old.stale[0].ownerEntity, 'Sample Holdings');
  assert.equal(old.stale[0].daysSince, 183);
  const edge = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(182) })] });
  assert.equal(edge.stale.length, 0);
  const recent = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(30) })] });
  assert.equal(recent.stale.length, 0);
  const attempt = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Attempted' })], activities: [talk({ outcome: 'No answer', kind: 'call' }), talk({ id: 2, outcome: 'Left voicemail' })] });
  assert.equal(attempt.stale.length, 0);
});

test('a later call, a future callback, do-not-call, and wrong number drop the stale row', () => {
  const later = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk(), talk({ id: 2, outcome: 'No answer', activity_date: daysAgo(2), notes: '' })] });
  assert.equal(later.stale.length, 0);
  const scheduled = buildFollowUps({ today: TODAY, properties: [prop({ callback_date: '2026-12-01' })], activities: [talk()] });
  assert.equal(scheduled.stale.length, 0);
  const dnc = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Do not call' })], activities: [talk()] });
  assert.equal(dnc.stale.length, 0);
  const wrong = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk(), talk({ id: 3, outcome: 'Wrong number', activity_date: daysAgo(1) })] });
  assert.equal(wrong.stale.length, 0);
});

test('imported Talked and imported last-contacted count, import Called does not', () => {
  const imported = buildFollowUps({ today: TODAY, properties: [prop({ last_contacted: daysAgo(200) })], activities: [talk({ kind: 'import', outcome: 'Talked', activity_date: daysAgo(200) })] });
  assert.equal(imported.stale.length, 1);
  const onlyLast = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Talked', last_contacted: daysAgo(200) })], activities: [] });
  assert.equal(onlyLast.stale.length, 1);
  const called = buildFollowUps({ today: TODAY, properties: [prop({ status: 'Attempted', last_contacted: daysAgo(200) })], activities: [talk({ kind: 'import', outcome: 'Called', activity_date: daysAgo(200) })] });
  assert.equal(called.stale.length, 0);
});

test('sell interest and later-call phrases are listed, negations are excluded', () => {
  const sell = buildFollowUps({ today: TODAY, properties: [prop({ notes: '' })], activities: [talk({ notes: 'She is interested in selling the building.' })] });
  assert.equal(sell.missed.length, 1);
  assert.equal(sell.missed[0].phrase, 'interested in selling');
  assert.match(sell.missed[0].snippet, /interested in selling/);
  const neg = classifyText('They are not selling and have no interest in selling.');
  assert.equal(neg.sell, null);
  assert.ok(neg.excluded.length >= 1);
  const negRow = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ notes: 'Owner is not selling. Never selling.' })] });
  assert.equal(negRow.missed.length, 0);
  assert.ok(negRow.excluded.some((e) => /not selling/i.test(e.phrase)));
  assert.match(negRow.excluded.find((e) => /never selling/i.test(e.phrase)).snippet, /Never selling/);
  assert.doesNotMatch(negRow.excluded.map((e) => e.snippet).join(' '), /They are \./);
  const never = classifyText('He said never selling, do not call back.');
  assert.equal(never.sell, null);
  assert.equal(never.later, null);
  const due = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(200), notes: 'Please call back in 3 months.' })] });
  assert.equal(due.missed.length, 1);
  assert.equal(due.missed[0].phrase, 'call back in X months');
  assert.ok(due.missed[0].due <= TODAY);
  const notYet = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(10), notes: 'Call back in 6 months.' })] });
  assert.equal(notYet.missed.length, 0);
  const undated = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ notes: 'Try again later after the lease.' })] });
  assert.equal(undated.missed.length, 1);
  assert.equal(undated.missed[0].phrase, 'try again later');
  const after = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: '2024-01-10', notes: 'Call back after June 1, 2024.' })] });
  assert.equal(after.missed.length, 1);
  assert.equal(after.missed[0].phrase, 'call back after date');
  assert.equal(after.missed[0].due, '2024-06-01');
  const afterFuture = buildFollowUps({ today: TODAY, properties: [prop()], activities: [talk({ activity_date: daysAgo(20), notes: 'Call back after 2027-01-15.' })] });
  assert.equal(afterFuture.missed.length, 0);
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
    assert.equal(row.missed.length, 0, notes);
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
  assert.equal(onlyNeg.missed.length, 0);
  assert.ok(onlyNeg.excluded.some((e) => /want to sell/i.test(e.phrase)));
  assert.ok(onlyNeg.excluded.some((e) => /want to sell/i.test(e.snippet)));
});

test('a newer call drops a missed follow-up', () => {
  const gone = buildFollowUps({
    today: TODAY, properties: [prop()],
    activities: [talk({ notes: 'Open to offers next spring.' }), talk({ id: 8, outcome: 'No answer', activity_date: daysAgo(1), notes: '' })],
  });
  assert.equal(gone.missed.length, 0);
  assert.equal(gone.stale.length, 0);
});

test('state filter limits both lists', () => {
  const fl = prop({ id: 1, state: 'FL' });
  const ga = prop({ id: 2, state: 'GA', address: '2 Synthetic', owners: [{ id: 4, name: 'Bea Sample', entity: 'Bea LLC' }] });
  const activities = [talk({ property_id: 1 }), talk({ id: 2, property_id: 2, owner_id: 4, notes: 'May sell this year.' })];
  const only = buildFollowUps({ today: TODAY, properties: [fl, ga], activities, state: 'GA' });
  assert.equal(only.stale.length, 1);
  assert.equal(only.stale[0].state, 'GA');
  assert.equal(only.missed.length, 1);
  assert.equal(only.missed[0].address, '2 Synthetic');
});
