// Clinic booking API - Koya Cohort 4 assessment, Task 1.
// Implements every level of the published OpenAPI contract:
//   L1: POST /reset, GET /slots, POST /bookings, GET /bookings/:id
//   L2: X-API-Key auth + input validation (trim, lowercase email, started slots)
//   L3: race-safe single booking per slot + cancellation
//   L4: Idempotency-Key replays + cursor pagination
//   L5: 5 attempts per email per rolling minute (429 + Retry-After)

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.API_KEY || 'clinic-dev-key';
const PORT = Number(process.env.PORT || 3000);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  return crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}
// Trim on the way in; store emails lowercased (level 2).
const raw = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

const toBooking = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: iso(r.created_at),
});
const toSlot = (r) => ({
  id: r.id,
  provider: r.provider,
  start: iso(r.start),
  end: iso(r.end),
  ...(Object.hasOwn(r, 'available') ? { available: r.available } : {}),
});

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Malformed JSON body -> 400 in the standard error shape.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  next(err);
});

// ---- API routes (all require X-API-Key) ------------------------------------

const api = express.Router();

// Level 2: every API request needs the key; missing or wrong -> 401.
// (Scoped to the API paths so the web page and its assets stay public.)
api.use((req, res, next) => {
  const isApiPath = ['/reset', '/slots', '/bookings'].some(
    (p) => req.path === p || req.path.startsWith(p + '/')
  );
  if (!isApiPath) return next();
  const key = req.get('X-API-Key');
  if (!key || !safeEqual(String(key), API_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Level 1: delete every booking and replace all slots with the ones sent
// (past slots included).
api.post('/reset', async (req, res, next) => {
  try {
    const db = await getDb();
    const slots = req.body?.slots;
    if (!Array.isArray(slots)) {
      return res.status(400).json({ error: 'slots array is required' });
    }
    const clean = [];
    for (const s of slots) {
      if (!s || typeof s !== 'object') {
        return res.status(400).json({ error: 'each slot must be an object' });
      }
      const { id, provider, start, end } = s;
      if (
        raw(id) === '' || raw(provider) === '' ||
        typeof start !== 'string' || typeof end !== 'string' ||
        Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))
      ) {
        return res.status(400).json({ error: 'each slot needs id, provider, start and end' });
      }
      clean.push({ id: raw(id), provider: raw(provider), start: new Date(start), end: new Date(end) });
    }
    if (new Set(clean.map((s) => s.id)).size !== clean.length) {
      return res.status(400).json({ error: 'duplicate slot ids' });
    }
    await db.tx(async (q) => {
      await q('DELETE FROM bookings');
      await q('DELETE FROM idempotency_keys');
      await q('DELETE FROM rate_limit_attempts');
      await q('DELETE FROM slots');
      for (const s of clean) {
        await q('INSERT INTO slots (id, provider, start, "end") VALUES ($1,$2,$3,$4)', [
          s.id, s.provider, s.start, s.end,
        ]);
      }
    });
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

// Level 1: every slot, earliest start first, with availability + optional
// exact-match provider filter.
api.get('/slots', async (req, res, next) => {
  try {
    const db = await getDb();
    const params = [];
    let where = '';
    if (req.query.provider !== undefined) {
      params.push(String(req.query.provider));
      where = `WHERE s.provider = $${params.length}`;
    }
    const rows = await db.query(
      `SELECT s.id, s.provider, s.start, s."end",
              NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
       FROM slots s ${where}
       ORDER BY s.start ASC, s.id ASC`,
      params
    );
    return res.json({ slots: rows.map(toSlot) });
  } catch (e) {
    return next(e);
  }
});

// Book a slot (levels 1-5).
api.post('/bookings', async (req, res, next) => {
  try {
    const db = await getDb();
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const idemHeader = req.get('Idempotency-Key');
    const idemKey = typeof idemHeader === 'string' ? idemHeader.trim() : '';
    const slotId = raw(body.slot_id);
    const name = raw(body.name);
    const email = raw(body.email).toLowerCase();
    const bodyHash = sha256(JSON.stringify({ slot_id: slotId, name, email }));

    // Level 4: same key + same body -> replay the original response;
    // same key + different body -> 422. Checked before anything else.
    if (idemKey) {
      const hit = await db.query(
        'SELECT body_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
        [idemKey]
      );
      if (hit.length) {
        if (hit[0].body_hash !== bodyHash) {
          return res.status(422).json({ error: 'Idempotency-Key was already used with a different body' });
        }
        return res.status(hit[0].status_code).json(hit[0].response_body);
      }
    }

    // Level 5: at most 5 attempts per email per rolling 60s, failures included.
    // The 6th attempt gets 429 + Retry-After (whole seconds) and is not counted,
    // so other emails are never affected.
    if (email !== '') {
      const rl = await db.query(
        `SELECT COUNT(*)::int AS n,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (MIN(attempted_at) + INTERVAL '60 seconds' - NOW())))::int) AS retry_after
         FROM rate_limit_attempts
         WHERE email = $1 AND attempted_at > NOW() - INTERVAL '60 seconds'`,
        [email]
      );
      if (rl[0].n >= 5) {
        res.set('Retry-After', String(rl[0].retry_after));
        return res.status(429).json({ error: 'too many attempts for this email, try again later' });
      }
      await db.query('INSERT INTO rate_limit_attempts (email) VALUES ($1)', [email]);
    }

    // Level 2 validation.
    if (!slotId || !name || !email) {
      return res.status(400).json({ error: 'slot_id, name and email are required' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'invalid email' });
    }

    // The actual booking. Slot lookup, started-check and insert run in one
    // transaction; the partial unique index turns any concurrent double-book
    // into a 23505, which we surface as 409 (level 3).
    let result;
    try {
      result = await db.tx(async (q) => {
        const slotRows = await q(
          'SELECT id, provider, start, "end" FROM slots WHERE id = $1',
          [slotId]
        );
        if (!slotRows.length) {
          return { code: 404, body: { error: 'slot not found' } };
        }
        const startAt = slotRows[0].start instanceof Date ? slotRows[0].start : new Date(slotRows[0].start);
        if (startAt.getTime() <= Date.now()) {
          return { code: 400, body: { error: 'slot has already started' } };
        }
        const ins = await q(
          `INSERT INTO bookings (id, slot_id, name, email, status)
           VALUES ($1,$2,$3,$4,'confirmed') RETURNING *`,
          [crypto.randomUUID(), slotId, name, email]
        );
        return { code: 201, body: toBooking(ins[0]) };
      });
    } catch (e) {
      if (e.code !== '23505') throw e;
      result = { code: 409, body: { error: 'slot already booked' } };
    }

    // Level 4: remember the outcome so the same key+body replays it verbatim.
    if (idemKey) {
      const stored = await db.query(
        `INSERT INTO idempotency_keys (key, body_hash, status_code, response_body)
         VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING
         RETURNING body_hash, status_code, response_body`,
        [idemKey, bodyHash, result.code, JSON.stringify(result.body)]
      );
      if (!stored.length) {
        // Lost a race against a concurrent request with the same key.
        const existing = await db.query(
          'SELECT body_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
          [idemKey]
        );
        if (existing[0].body_hash !== bodyHash) {
          result = { code: 422, body: { error: 'Idempotency-Key was already used with a different body' } };
        } else {
          result = { code: existing[0].status_code, body: existing[0].response_body };
        }
      }
    }

    return res.status(result.code).json(result.body);
  } catch (e) {
    return next(e);
  }
});

// Level 4: one person's bookings, oldest first, case-insensitive email,
// keyset cursor pagination (pass next_cursor back as cursor).
api.get('/bookings', async (req, res, next) => {
  try {
    const db = await getDb();
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    let limit = 10;
    if (req.query.limit !== undefined) {
      const s = String(req.query.limit);
      if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > 50) {
        return res.status(400).json({ error: 'limit must be an integer between 1 and 50' });
      }
      limit = Number(s);
    }
    const params = [email];
    let where = 'email = $1';
    if (req.query.cursor !== undefined) {
      let c;
      try {
        c = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'));
        if (typeof c?.t !== 'string' || typeof c?.i !== 'string' || Number.isNaN(Date.parse(c.t))) {
          throw new Error('bad cursor');
        }
      } catch {
        return res.status(400).json({ error: 'invalid cursor' });
      }
      params.push(c.t, c.i);
      where += ` AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length})`;
    }
    params.push(limit + 1); // fetch one extra to know whether more pages exist
    const rows = await db.query(
      `SELECT * FROM bookings WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
      params
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.length ? page[page.length - 1] : null;
    return res.json({
      bookings: page.map(toBooking),
      next_cursor: hasMore
        ? Buffer.from(JSON.stringify({ t: iso(last.created_at), i: last.id })).toString('base64url')
        : null,
    });
  } catch (e) {
    return next(e);
  }
});

// Level 1: look up one booking.
api.get('/bookings/:id', async (req, res, next) => {
  try {
    const db = await getDb();
    const rows = await db.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'booking not found' });
    }
    return res.json(toBooking(rows[0]));
  } catch (e) {
    return next(e);
  }
});

// Level 3: cancel a booking and free its slot. Cancelling twice -> 409.
api.delete('/bookings/:id', async (req, res, next) => {
  try {
    const db = await getDb();
    const upd = await db.query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [req.params.id]
    );
    if (upd.length) {
      return res.json(toBooking(upd[0]));
    }
    const rows = await db.query('SELECT status FROM bookings WHERE id = $1', [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'booking not found' });
    }
    return res.status(409).json({ error: 'booking already cancelled' });
  } catch (e) {
    return next(e);
  }
});

app.use(api);

// ---- web page ---------------------------------------------------------------

// Injects the API key so the page can call the API without hardcoding it.
app.get('/config.js', (req, res) => {
  res.type('text/javascript').send(`window.APP_CONFIG = ${JSON.stringify({ apiKey: API_KEY })};`);
});
app.use(express.static(path.join(__dirname, 'public')));

// Fallthroughs.
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

export function startServer(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(() => console.log(`clinic-booking-api listening on :${PORT}`));
}
