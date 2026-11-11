const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('age import fills an empty birth year and does not create or overwrite owners', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-ages-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const { migrate } = require('../src/db');
  const { importOwnerAges, ageLabel, parseAgeCsv } = require('../src/owner-ages');
  const db = await migrate();
  const [prop] = await db.query(`INSERT INTO properties (address, city, state) VALUES ('9 Synthetic Plaza', 'Sampleville', 'FL') RETURNING id`);
  const [ada] = await db.query(`INSERT INTO owners (name, entity) VALUES ('Ada Sample', 'Sample Holdings') RETURNING id`);
  const [bea] = await db.query(`INSERT INTO owners (name, entity, birth_year, age_source, age_confidence) VALUES ('Bea Sample', 'Bea LLC', 1960, 'manual', 'high') RETURNING id`);
  await db.query('INSERT INTO property_owners VALUES ($1,$2), ($1,$3)', [prop.id, ada.id, bea.id]);
  const csv = parseAgeCsv([
    'property_id,person_name,birth_year,age_as_of_today,source,match_confidence',
    `${prop.id},Ada Sample,1948,,Nexis,high`,
    `${prop.id},Bea Sample,1930,,Nexis,high`,
    `${prop.id},Nobody Sample,1940,,Nexis,medium`,
    `${prop.id},Ada Sample,,70,Nexis,low`,
  ].join('\n'));
  const stats = await importOwnerAges(db, csv, { today: '2026-11-10' });
  assert.equal(stats.updated, 1);
  assert.equal(stats.alreadySet, 2);
  assert.equal(stats.noMatch, 1);
  const owners = await db.query('SELECT id, name, birth_year, age_source, age_confidence FROM owners ORDER BY id');
  assert.equal(owners.length, 2);
  assert.equal(Number(owners[0].birth_year), 1948);
  assert.equal(owners[0].age_source, 'Nexis');
  assert.equal(owners[0].age_confidence, 'high');
  assert.equal(Number(owners[1].birth_year), 1960);
  assert.equal(owners[1].age_source, 'manual');
  assert.equal(ageLabel(owners[0], '2026-11-10'), 'Born 1948 · age 78 as of today · Nexis · high confidence');
  const { ageLabel: label, crmAgeNote } = require('../src/owner-ages');
  assert.equal(label({ birth_year: null }, '2026-11-10'), '');
  assert.equal(label({ birth_year: '' }, '2026-11-10'), '');
  assert.equal(crmAgeNote({ birth_year: null, age: '93' }), 'Age 93 · CRM age field · medium confidence');
  assert.equal(crmAgeNote({ birth_year: null, age: '68 (Deceased)' }), '68 (Deceased) · estate / heirs');
  assert.equal(crmAgeNote({ birth_year: 1948, age: '93' }), '');
  if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
});