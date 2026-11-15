"""Clinic booking API - Koya Cohort 4 assessment, Task 1 (FastAPI rewrite).

Levels covered:
  L1: POST /reset, GET /slots, POST /bookings, GET /bookings/{id}
  L2: X-API-Key auth + input validation (trim, lowercase email, started slots)
  L3: race-safe single booking per slot + cancellation
  L4: Idempotency-Key replays + cursor pagination
  L5: 5 attempts per email per rolling minute (429 + Retry-After)
"""

import base64
import hashlib
import hmac
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from db import close_pool, get_pool

API_KEY = os.environ.get("API_KEY", "clinic-dev-key")
EMAIL_RE_TMPL = r"^[^\s@]+@[^\s@]+\.[^\s@]+$"
import re

EMAIL_RE = re.compile(EMAIL_RE_TMPL)
API_PATHS = ("/reset", "/slots", "/bookings")


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def row_to_booking(r: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": r["id"],
        "slot_id": r["slot_id"],
        "name": r["name"],
        "email": r["email"],
        "status": r["status"],
        "created_at": iso(r["created_at"]),
    }


def row_to_slot(r: asyncpg.Record, with_available: bool = False) -> dict[str, Any]:
    out = {"id": r["id"], "provider": r["provider"], "start": iso(r["start"]), "end": iso(r["end"])}
    if with_available and "available" in r:
        out["available"] = r["available"]
    return out


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def constant_time_eq(a: str, b: str) -> bool:
    # Hash both sides to a fixed length so length differences don't leak timing.
    return hmac.compare_digest(sha256(a), sha256(b))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await get_pool()
    yield
    await close_pool()


app = FastAPI(title="Clinic booking API", version="2.0.0-python", lifespan=lifespan)

# ---- error shape: every error is {"error": "<message>"} ---------------------

class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse(status_code=exc.status, content={"error": exc.message})


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    # Covers 404 unknown paths, 405 method-not-allowed, etc., in the standard shape.
    if exc.status_code >= 400:
        msg = {404: "not found", 405: "method not allowed", 422: "invalid request"}.get(
            exc.status_code, exc.detail if isinstance(exc.detail, str) else "request failed"
        )
        return JSONResponse(status_code=exc.status_code, content={"error": msg})
    return PlainTextResponse("", status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=400, content={"error": "invalid request"})


@app.exception_handler(404)
async def not_found_handler(request: Request, exc: Any):
    return JSONResponse(status_code=404, content={"error": "not found"})


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": "internal server error"})


# ---- auth (level 2): every API request needs X-API-Key ----------------------

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # CORS preflight carries no credentials by design; let it through so the
    # CORSMiddleware (registered below, outermost) can answer it.
    if request.method == "OPTIONS":
        return await call_next(request)
    if any(request.url.path == p or request.url.path.startswith(p + "/") for p in API_PATHS):
        key = request.headers.get("X-API-Key", "")
        if not key or not constant_time_eq(key, API_KEY):
            return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return await call_next(request)


# The SPA and the docs site live on different origins, so CORS must allow them.
# Registered after the auth middleware above, which makes it the outermost
# middleware: preflight OPTIONS is answered here, before auth ever runs.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key", "Idempotency-Key"],
    expose_headers=["Retry-After"],
)


async def body_json(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        raise ApiError(400, "invalid JSON body")
    if not isinstance(data, dict):
        raise ApiError(400, "invalid JSON body")
    return data


def clean_str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else (str(v) if isinstance(v, (int, float)) else "")


# ---- level 1: reset ----------------------------------------------------------

@app.post("/reset")
async def reset(request: Request):
    body = await body_json(request)
    slots = body.get("slots")
    if not isinstance(slots, list):
        raise ApiError(400, "slots array is required")
    clean = []
    for s in slots:
        if not isinstance(s, dict):
            raise ApiError(400, "each slot must be an object")
        sid, provider, start, end = (clean_str(s.get("id")), clean_str(s.get("provider")),
                                     s.get("start"), s.get("end"))
        if not sid or not provider or not isinstance(start, str) or not isinstance(end, str):
            raise ApiError(400, "each slot needs id, provider, start and end")
        try:
            start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
        except ValueError:
            raise ApiError(400, "each slot needs id, provider, start and end")
        clean.append((sid, provider, start_dt, end_dt))
    if len({c[0] for c in clean}) != len(clean):
        raise ApiError(400, "duplicate slot ids")

    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute("DELETE FROM bookings")
            await con.execute("DELETE FROM idempotency_keys")
            await con.execute("DELETE FROM rate_limit_attempts")
            await con.execute("DELETE FROM slots")
            await con.executemany(
                'INSERT INTO slots (id, provider, start, "end") VALUES ($1,$2,$3,$4)', clean
            )
    return {"ok": True}


# ---- level 1: list slots -----------------------------------------------------

@app.get("/slots")
async def slots(provider: str | None = None):
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            """SELECT s.id, s.provider, s.start, s."end",
                      NOT EXISTS (SELECT 1 FROM bookings b
                                  WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
               FROM slots s
               WHERE ($1::text IS NULL OR s.provider = $1)
               ORDER BY s.start ASC, s.id ASC""",
            provider,
        )
    return {"slots": [row_to_slot(r, with_available=True) for r in rows]}


# ---- book a slot (levels 1-5) ------------------------------------------------

@app.post("/bookings")
async def create_booking(request: Request):
    body = await body_json(request)
    idem_key = (request.headers.get("Idempotency-Key") or "").strip()
    slot_id = clean_str(body.get("slot_id"))
    name = clean_str(body.get("name"))
    email = clean_str(body.get("email")).lower()
    body_hash = sha256(json.dumps({"slot_id": slot_id, "name": name, "email": email}))

    pool = await get_pool()

    # Level 4: same key + same body replays the original response; different body -> 422.
    if idem_key:
        async with pool.acquire() as con:
            hit = await con.fetchrow(
                "SELECT body_hash, status_code, response_body FROM idempotency_keys WHERE key = $1",
                idem_key,
            )
        if hit:
            if hit["body_hash"] != body_hash:
                raise ApiError(422, "Idempotency-Key was already used with a different body")
            return JSONResponse(status_code=hit["status_code"], content=hit["response_body"])

    # Level 5: at most 5 attempts per email per rolling 60s, failures included.
    # The 6th gets 429 + Retry-After and is not counted, so other emails are unaffected.
    if email:
        async with pool.acquire() as con:
            row = await con.fetchrow(
                """SELECT COUNT(*)::int AS n,
                          GREATEST(1, CEIL(EXTRACT(EPOCH FROM (MIN(attempted_at) + INTERVAL '60 seconds' - NOW())))::int) AS retry_after
                   FROM rate_limit_attempts
                   WHERE email = $1 AND attempted_at > NOW() - INTERVAL '60 seconds'""",
                email,
            )
            if row["n"] >= 5:
                return JSONResponse(
                    status_code=429,
                    content={"error": "too many attempts for this email, try again later"},
                    headers={"Retry-After": str(row["retry_after"])},
                )
            await con.execute("INSERT INTO rate_limit_attempts (email) VALUES ($1)", email)

    # Level 2 validation.
    if not slot_id or not name or not email:
        raise ApiError(400, "slot_id, name and email are required")
    if not EMAIL_RE.match(email):
        raise ApiError(400, "invalid email")

    # The booking itself. Slot lookup, started-check and insert run in one
    # transaction; the partial unique index turns any concurrent double-book
    # into a 23505, surfaced here as 409 (level 3).
    result: dict[str, Any]
    try:
        async with pool.acquire() as con:
            async with con.transaction():
                slot_row = await con.fetchrow(
                    'SELECT id, provider, start, "end" FROM slots WHERE id = $1', slot_id
                )
                if not slot_row:
                    return JSONResponse(status_code=404, content={"error": "slot not found"})
                if slot_row["start"] <= datetime.now(timezone.utc):
                    return JSONResponse(status_code=400, content={"error": "slot has already started"})
                booking_id = str(uuid.uuid4())
                ins = await con.fetchrow(
                    """INSERT INTO bookings (id, slot_id, name, email, status)
                       VALUES ($1,$2,$3,$4,'confirmed') RETURNING *""",
                    booking_id, slot_id, name, email,
                )
                result = row_to_booking(ins)
    except asyncpg.UniqueViolationError:
        result = {"error": "slot already booked"}
        status = 409
    else:
        status = 201

    # Level 4: remember the outcome so the same key+body replays it verbatim.
    if idem_key:
        async with pool.acquire() as con:
            stored = await con.fetchrow(
                """INSERT INTO idempotency_keys (key, body_hash, status_code, response_body)
                   VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING
                   RETURNING body_hash, status_code, response_body""",
                idem_key, body_hash, status,
                result,  # jsonb codec serialises the dict itself
            )
            if not stored:
                existing = await con.fetchrow(
                    "SELECT body_hash, status_code, response_body FROM idempotency_keys WHERE key = $1",
                    idem_key,
                )
                if existing["body_hash"] != body_hash:
                    result = {"error": "Idempotency-Key was already used with a different body"}
                    status = 422
                else:
                    result = existing["response_body"]
                    status = existing["status_code"]

    return JSONResponse(status_code=status, content=result)


# ---- level 4: list a person's bookings ---------------------------------------

def encode_cursor(created_at: datetime, booking_id: str) -> str:
    raw = json.dumps({"t": iso(created_at), "i": booking_id}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
        # asyncpg needs a real datetime for timestamptz params, not a string.
        dt = datetime.fromisoformat(data["t"].replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError("naive datetime")
        return dt, data["i"]
    except Exception:
        raise ApiError(400, "invalid cursor")


@app.get("/bookings")
async def list_bookings(request: Request):
    email = (request.query_params.get("email") or "").strip().lower()
    if not email:
        raise ApiError(400, "email is required")
    limit_raw = request.query_params.get("limit")
    limit = 10
    if limit_raw is not None:
        if not limit_raw.isdigit() or not (1 <= int(limit_raw) <= 50):
            raise ApiError(400, "limit must be an integer between 1 and 50")
        limit = int(limit_raw)

    cursor = request.query_params.get("cursor")
    where = "email = $1"
    args: list[Any] = [email]
    if cursor is not None:
        t, i = decode_cursor(cursor)
        args += [t, i]
        where += " AND (created_at, id) > ($2, $3)"

    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            f"SELECT * FROM bookings WHERE {where} ORDER BY created_at ASC, id ASC LIMIT ${len(args) + 1}",
            *args, limit + 1,
        )
    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = encode_cursor(page[-1]["created_at"], page[-1]["id"]) if has_more and page else None
    return {"bookings": [row_to_booking(r) for r in page], "next_cursor": next_cursor}


# ---- level 1: look up one booking --------------------------------------------

@app.get("/bookings/{booking_id}")
async def get_booking(booking_id: str):
    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow("SELECT * FROM bookings WHERE id = $1", booking_id)
    if not row:
        raise ApiError(404, "booking not found")
    return row_to_booking(row)


# ---- level 3: cancel ----------------------------------------------------------

@app.delete("/bookings/{booking_id}")
async def cancel_booking(booking_id: str):
    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow(
            "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
            booking_id,
        )
        if row:
            return row_to_booking(row)
        current = await con.fetchrow("SELECT status FROM bookings WHERE id = $1", booking_id)
    if not current:
        raise ApiError(404, "booking not found")
    raise ApiError(409, "booking already cancelled")


# ---- landing + SPA fallback ----------------------------------------------------

@app.get("/")
async def index():
    return {"ok": True, "service": "clinic-booking-api", "docs": "https://clinic-booking-docs.onrender.com"}
