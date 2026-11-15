"""Database layer: an asyncpg pool against Neon Postgres.

Same schema as before - the partial unique index is what makes a double
booking impossible even when two requests arrive at the same instant.
"""

import json
import os

import asyncpg

_pool: asyncpg.Pool | None = None


def _dsn() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required (set it even for local runs)")
    # asyncpg handles sslmode=require in the DSN itself on recent versions,
    # but be explicit for Neon hosts.
    if "sslmode=" not in url and ("neon.tech" in url or os.environ.get("PGSSL") == "require"):
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}sslmode=require"
    return url


async def _setup_conn(con: asyncpg.Connection) -> None:
    # asyncpg returns jsonb as a raw str by default; decode it to dicts so the
    # stored idempotency response replays as a real JSON object.
    await con.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(_dsn(), min_size=1, max_size=5, setup=_setup_conn)
        await ensure_schema(_pool)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS slots (
        id       TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        start    TIMESTAMPTZ NOT NULL,
        "end"    TIMESTAMPTZ NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS bookings (
        id         TEXT PRIMARY KEY,
        slot_id    TEXT NOT NULL REFERENCES slots(id),
        name       TEXT NOT NULL,
        email      TEXT NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('confirmed','cancelled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    # Level 3: at most one confirmed booking per slot, enforced by the database.
    """CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
       ON bookings (slot_id) WHERE status = 'confirmed'""",
    "CREATE INDEX IF NOT EXISTS bookings_email_created ON bookings (email, created_at)",
    # Level 4: Idempotency-Key -> stored response (replays return the original).
    """CREATE TABLE IF NOT EXISTS idempotency_keys (
        key           TEXT PRIMARY KEY,
        body_hash     TEXT NOT NULL,
        status_code   INT  NOT NULL,
        response_body JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    # Level 5: rolling 60s window of raw attempts per email (failures included).
    """CREATE TABLE IF NOT EXISTS rate_limit_attempts (
        email        TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    "CREATE INDEX IF NOT EXISTS rate_limit_email_time ON rate_limit_attempts (email, attempted_at)",
]


async def ensure_schema(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as con:
        for stmt in SCHEMA:
            await con.execute(stmt)
