# Clinic Booking API

A clinic appointment-booking API plus a small web page, built for Task 1 of the
Koya Cohort 4 assessment. It implements every published level of the spec at
[koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api):

| Level | What it adds |
|---|---|
| 1 | `POST /reset`, `GET /slots`, `POST /bookings` (201 + confirmation), `GET /bookings/:id` |
| 2 | `X-API-Key` auth on every endpoint (401), input validation (400/404), trim + lowercase email, reject started slots |
| 3 | Two people can never take the same slot — even in the same instant; cancellation frees the slot (409 on double-cancel) |
| 4 | `Idempotency-Key` replays never duplicate (422 on key reuse with a different body); cursor pagination for a person's bookings |
| 5 | At most 5 attempts per email per rolling minute, failures included; the 6th gets 429 + `Retry-After` |

## Stack

- **Node.js + Express** — small, portable runtime.
- **Postgres (Neon, free tier) in production** via `pg`; **PGlite locally** (real
  Postgres compiled to WASM) so development and tests need no database install.
  The same SQL runs in both.
- **Web page** — dependency-free HTML/CSS/JS served by the same app at `/`.

## Key design decisions

1. **The database enforces "one confirmed booking per slot".** A partial unique
   index — `CREATE UNIQUE INDEX ... ON bookings (slot_id) WHERE status = 'confirmed'` —
   makes a double booking impossible at the storage layer. Two concurrent
   requests can both read the slot as free, but only one `INSERT` can commit;
   the loser gets a unique-violation which the API surfaces as `409`. No
   check-then-insert race window exists in application code.
2. **Idempotency and rate limiting live in Postgres, not memory.**
   `idempotency_keys` stores the request-body hash plus the full first response,
   so replays return the exact original booking id — and survive restarts.
   `rate_limit_attempts` is a raw log of attempts per email over a rolling
   60-second window, which keeps the "5 attempts, failures included" rule exact
   and per-email isolated.

## Run locally

```bash
npm install
npm start          # http://localhost:3000  (API key: clinic-dev-key)
npm test           # end-to-end suite against in-process PGlite
```

Environment variables:

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (Render sets this automatically) |
| `API_KEY` | The `X-API-Key` value required on every API request |
| `DATABASE_URL` | Postgres connection string (Neon). Omit to use local PGlite |

## Endpoints (all require `X-API-Key`)

- `POST /reset` — `{ "slots": [ { "id", "provider", "start", "end" }, ... ] }`
- `GET /slots[?provider=...]` — earliest first, each with `available`
- `POST /bookings` — `{ "slot_id", "name", "email" }`, optional `Idempotency-Key` header
- `GET /bookings?email=&limit=&cursor=` — oldest first, cursor pagination
- `GET /bookings/:id` / `DELETE /bookings/:id` — look up / cancel

## Web page

Served at `/`: browse available slots, book one with name + email, see the
confirmation code, then look up and cancel bookings by email. It talks to the
API with the server-provided key (`/config.js`) — no hardcoded secrets.

## Deployed

- API: https://clinic-booking-api-lwo2.onrender.com
- Web page: same origin, `/`
- Database: Neon Postgres (Frankfurt, autoscaling 0.25–2 CU, free plan)
- Host: Render web service (free plan)

## Verification

`npm test` runs 13 end-to-end tests in-process; `test/live.verify.mjs` re-runs
the critical paths against the deployed URL (`BASE=... API_KEY=... node test/live.verify.mjs`).
