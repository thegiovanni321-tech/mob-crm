// Database adapter: real Postgres when DATABASE_URL is set (production),
// otherwise an embedded Postgres (PGlite) stored in DATA_DIR (local dev / single-box use).
const path = require('path');
let impl;
async function init() {
  if (impl) return impl;
  if (process.env.DATABASE_URL) {
    const { Pool, types } = require('pg');
    types.setTypeParser(1082, (v) => v); // DATE as 'YYYY-MM-DD'
    const url = process.env.DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
    impl = {
      kind: 'postgres',
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      tx: async (fn) => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn({ query: async (s, p = []) => (await c.query(s, p)).rows }); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      },
      exec: async (sql) => { await pool.query(sql); },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pgdata');
    const db = await PGlite.create(dir, { parsers: { 1082: (v) => v } });
    impl = {
      kind: 'pglite:' + dir,
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      tx: async (fn) => db.transaction(async (t) => fn({ query: async (s, p = []) => (await t.query(s, p)).rows })),
      exec: async (sql) => { await db.exec(sql); },
    };
  }
  return impl;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, notes TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS owners (
  id SERIAL PRIMARY KEY, name TEXT, entity TEXT, age TEXT,
  phone1 TEXT, phone2 TEXT, phone3 TEXT, phone4 TEXT, phone5 TEXT,
  email TEXT, website TEXT, mailing_address TEXT, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY, address TEXT NOT NULL, city TEXT, state TEXT, state_raw TEXT, zip TEXT,
  tenancy TEXT, rba NUMERIC, acres NUMERIC, year_built TEXT, sale_date DATE, price NUMERIC, cap_rate NUMERIC,
  notes TEXT, status TEXT NOT NULL DEFAULT 'New', last_contacted DATE, callback_date DATE, source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS property_tenants (
  property_id INT REFERENCES properties(id) ON DELETE CASCADE, tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, tenant_id));
CREATE TABLE IF NOT EXISTS property_owners (
  property_id INT REFERENCES properties(id) ON DELETE CASCADE, owner_id INT REFERENCES owners(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, owner_id));
CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY, property_id INT REFERENCES properties(id) ON DELETE CASCADE, owner_id INT REFERENCES owners(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, outcome TEXT, notes TEXT, activity_date DATE, callback_date DATE, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_prop_state ON properties(state);
CREATE INDEX IF NOT EXISTS idx_prop_cb ON properties(callback_date);
CREATE INDEX IF NOT EXISTS idx_act_prop ON activities(property_id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS parent_activity_id INT REFERENCES activities(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_po_owner ON property_owners(owner_id);
CREATE INDEX IF NOT EXISTS idx_pt_tenant ON property_tenants(tenant_id);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lat NUMERIC;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lng NUMERIC;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS birth_year INT;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS age_source TEXT;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS age_confidence TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lead_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lead_note TEXT;
CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  record_id INT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_kind_record_file ON attachments(kind, record_id, filename);
CREATE INDEX IF NOT EXISTS idx_attachments_kind_record ON attachments(kind, record_id);
`;
async function migrate() { const db = await init(); await db.exec(SCHEMA); await db.exec(require('./comps-core').SCHEMA); await db.exec(require('./buyer-needs').SCHEMA); await db.exec(require('./general-sync').SCHEMA); return db; }
module.exports = { init, migrate };
