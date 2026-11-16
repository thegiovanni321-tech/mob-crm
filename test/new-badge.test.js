const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-new-'));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;
const { migrate } = require('../src/db');
const { IS_NEW_SQL } = require('../src/property-flags');

async function flag(db, id) {
  const [row] = await db.query(`SELECT ${IS_NEW_SQL} AS is_new, status, last_contacted, notes, callback_date FROM properties p WHERE p.id=$1`, [id]);
  return row;
}

test('the green New flag clears after any logged call and is not restored by import rows', async () => {
  const db = await migrate();
  await db.query(`INSERT INTO properties (address, city, state, status, source, created_at) VALUES ('Old Anchor', 'Sampleville', 'FL', 'New', 'synthetic', now() - interval '40 days')`);
  const [fresh] = await db.query(`INSERT INTO properties (address, city, state, status, source) VALUES ('Fresh Medical', 'Sampleville', 'FL', 'New', 'synthetic') RETURNING id`);
  const [noted] = await db.query(`INSERT INTO properties (address, city, state, status, source) VALUES ('Noted Medical', 'Sampleville', 'FL', 'New', 'synthetic') RETURNING id`);
  const [imported] = await db.query(`INSERT INTO properties (address, city, state, status, last_contacted, source) VALUES ('Imported Called', 'Sampleville', 'FL', 'Attempted', '2024-01-02', 'synthetic') RETURNING id, status, notes, callback_date`);
  assert.equal((await flag(db, fresh.id)).is_new, true);
  await db.query(`INSERT INTO activities (property_id, kind, outcome, notes, activity_date) VALUES ($1, 'note', 'Note', 'left a sticky note', CURRENT_DATE)`, [noted.id]);
  assert.equal((await flag(db, noted.id)).is_new, true);
  const before = await flag(db, fresh.id);
  await db.query(`INSERT INTO activities (property_id, kind, outcome, notes, activity_date, callback_date) VALUES ($1, 'call', 'No answer', 'rang once', '2024-05-01', NULL)`, [fresh.id]);
  const after = await flag(db, fresh.id);
  assert.equal(after.is_new, false);
  assert.equal(after.status, 'New');
  assert.equal(after.notes, before.notes);
  assert.equal(after.callback_date, before.callback_date);
  for (const outcome of ['Left voicemail', 'Wrong number', 'Texted', 'Talked']) {
    const [p] = await db.query(`INSERT INTO properties (address, city, state, status, source) VALUES ($1, 'Sampleville', 'FL', 'New', 'synthetic') RETURNING id`, [outcome + ' Medical']);
    assert.equal((await flag(db, p.id)).is_new, true);
    await db.query(`INSERT INTO activities (property_id, kind, outcome, activity_date) VALUES ($1, 'call', $2, CURRENT_DATE)`, [p.id, outcome]);
    assert.equal((await flag(db, p.id)).is_new, false);
  }
  await db.query(`INSERT INTO activities (property_id, kind, outcome, activity_date, callback_date) VALUES ($1, 'import', 'Called', '2024-01-02', NULL)`, [fresh.id]);
  const still = await flag(db, fresh.id);
  assert.equal(still.is_new, false);
  assert.equal(still.status, 'New');
  assert.equal((await flag(db, imported.id)).is_new, false);
  assert.equal(imported.status, 'Attempted');
  assert.equal(imported.callback_date, null);
});
