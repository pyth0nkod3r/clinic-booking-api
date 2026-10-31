// Database layer.
//
// Production: real Postgres (Neon) through the `pg` pool, driven by DATABASE_URL.
// Local dev / tests: PGlite (actual Postgres compiled to WASM, in-process), so the
// exact same SQL - including the partial unique index that makes double-booking
// impossible - runs everywhere without a local Postgres install.

let impl = null;

async function makePg(url) {
  const { Pool } = await import('pg');
  const needsSsl = /neon\.tech|sslmode=require|render\.com/.test(url) || process.env.PGSSL === 'require';
  const pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 5),
  });
  return {
    async query(sql, params) {
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn((sql, params) => client.query(sql, params).then((r) => r.rows));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

async function makePglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const fs = await import('node:fs');
  const dir = process.env.PGLITE_DATA_DIR || '.data/pg';
  fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  return {
    async query(sql, params) {
      return (await db.query(sql, params)).rows;
    },
    async tx(fn) {
      return db.transaction(async (tx) =>
        fn((sql, params) => tx.query(sql, params).then((r) => r.rows))
      );
    },
  };
}

async function ensureSchema(db) {
  // One statement at a time: PGlite (like server-side prepared statements)
  // rejects multi-command strings.
  const statements = [
    `CREATE TABLE IF NOT EXISTS slots (
      id       TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      start    TIMESTAMPTZ NOT NULL,
      "end"    TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS bookings (
      id         TEXT PRIMARY KEY,
      slot_id    TEXT NOT NULL REFERENCES slots(id),
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('confirmed','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Level 3: at most one confirmed booking per slot, enforced by the database
    // itself, so two requests arriving at the same instant cannot both win.
    `CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed'`,
    `CREATE INDEX IF NOT EXISTS bookings_email_created ON bookings (email, created_at)`,
    // Level 4: Idempotency-Key -> stored response (replays return the original).
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      key          TEXT PRIMARY KEY,
      body_hash    TEXT NOT NULL,
      status_code  INT  NOT NULL,
      response_body JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Level 5: sliding 60s window of raw attempts per email (failures included).
    `CREATE TABLE IF NOT EXISTS rate_limit_attempts (
      email        TEXT NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS rate_limit_email_time ON rate_limit_attempts (email, attempted_at)`,
  ];
  for (const sql of statements) {
    await db.query(sql);
  }
}

export async function getDb() {
  if (impl) return impl;
  const url = process.env.DATABASE_URL;
  impl = url ? await makePg(url) : await makePglite();
  await ensureSchema(impl);
  return impl;
}
