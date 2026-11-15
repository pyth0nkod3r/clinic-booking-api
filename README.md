# Clinic Booking API + Web

A clinic appointment-booking API and its web client, built for Task 1 of the
Koya Cohort 4 assessment. This repo replaces the earlier Node.js/Express
version with the same contract, same database, and the same URLs.

- **API** — Python 3 + FastAPI + asyncpg on Neon Postgres → https://clinic-booking-api-lwo2.onrender.com
- **Web** — React 19 + React Router v8 (framework mode, SPA) on Render static → https://clinic-booking-web-uxgm.onrender.com
- **Docs** — Swagger UI over the published OpenAPI contract → https://clinic-booking-docs.onrender.com
- **Repo** — https://github.com/pyth0nkod3r/clinic-booking-api (public)

| Level | What it adds |
|---|---|
| 1 | `POST /reset`, `GET /slots`, `POST /bookings` (201 + confirmation), `GET /bookings/:id` |
| 2 | `X-API-Key` auth on every endpoint (401), input validation (400/404), trim + lowercase email, reject started slots |
| 3 | Two people can never take the same slot — even in the same instant; cancellation frees the slot (409 on double-cancel) |
| 4 | `Idempotency-Key` replays never duplicate (422 on key reuse with a different body); cursor pagination for a person's bookings |
| 5 | At most 5 attempts per email per rolling minute, failures included; the 6th gets 429 + `Retry-After` |

## Layout

```
api/      FastAPI app (server.py, db.py) + requirements.txt
web/      React Router v8 SPA (framework mode, Tailwind v4, SPA build)
docs/     Static Swagger UI over the OpenAPI contract
test/     e2e suite (stdlib HTTP client, no test-framework deps)
```

## Key design decisions

1. **The database enforces "one confirmed booking per slot".** A partial unique
   index — `CREATE UNIQUE INDEX ... ON bookings (slot_id) WHERE status = 'confirmed'` —
   makes a double booking impossible at the storage layer. Two concurrent
   requests can both read the slot as free, but only one `INSERT` commits; the
   loser gets asyncpg's `UniqueViolationError`, surfaced as `409`. No
   check-then-insert race window exists in application code.
2. **Idempotency and rate limiting live in Postgres, not memory.**
   `idempotency_keys` stores the request-body hash plus the full first response,
   so replays return the exact original booking id — and survive restarts.
   `rate_limit_attempts` is a raw log of attempts per email over a rolling
   60-second window, which keeps the "5 attempts, failures included" rule exact
   and per-email isolated.

## Run locally (one command)

Everything is wired through `concurrently`: one command starts the FastAPI
server (uvicorn, port 8765) and the React Router dev server (vite, port 5173)
together, both reading a single root `.env`.

```bash
# 1. one-time setup: installs npm deps (root + web) and the python venv
cp .env.example .env        # then fill in DATABASE_URL and the API key
npm run setup

# 2. start API + web together
npm run dev
#    [api] Uvicorn running on http://127.0.0.1:8765
#    [web] Local: http://localhost:5173/

# 3. run the 66-check e2e suite against the local stack
npm run test:local
```

`.env` drives both processes: `DATABASE_URL` + `API_KEY` for uvicorn (loaded via
`--env-file`), `VITE_API_BASE` + `VITE_API_KEY` for vite (`envDir` points at the
repo root). In local dev the web app talks to `http://127.0.0.1:8765`; in
production those values come from the Render service env vars instead, so no
code changes are needed between environments.

Individual processes, if you prefer separate terminals:

```bash
npm run dev:api     # FastAPI on :8765
npm run dev:web     # vite on :5173
```

No uv installed? `python3 -m venv .venv && .venv/bin/pip install -r
api/requirements.txt` and run `.venv/bin/uvicorn server:app --app-dir api
--port 8765` instead of the `dev:api` script.

## Web app notes

- Bootstrapped with `create-react-router` (React Router v8, framework mode),
  built in **SPA mode** (`ssr: false`) and deployed as a static bundle.
- Two routes: `/` (browse slots → book → confirmation) and `/my-bookings`
  (email lookup → cancel → cursor "Load more"). Data flows through
  `clientLoader`/`clientAction`; the API key and base URL arrive at build time
  via `VITE_API_BASE` / `VITE_API_KEY` (Render env vars).
- The React Router agent skill (`.agents/skills/react-router`) documents the
  framework conventions used here.

## Environment variables (API)

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (Render sets this automatically) |
| `API_KEY` | The `X-API-Key` value required on every API request |
| `DATABASE_URL` | Neon Postgres connection string |
