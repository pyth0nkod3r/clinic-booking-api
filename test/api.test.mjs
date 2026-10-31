// End-to-end test suite. Runs the real app in-process against PGlite
// (real Postgres semantics, including the partial unique index).
// Usage: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'test-key-123';
const H = { 'Content-Type': 'application/json', 'X-API-Key': KEY };

// Must be set before server.js is imported (ESM imports are hoisted, so we
// import dynamically after configuring the environment).
process.env.API_KEY = KEY;
process.env.PGLITE_DATA_DIR = '.data/test-pg';
const { app } = await import('../server.js');

const server = app.listen(0);
await new Promise((r) => server.on('listening', r));
test.after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

async function req(method, path, { key = KEY, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { 'X-API-Key': key }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data, headers: res.headers };
}

const future = (h) => {
  const d = new Date(Date.now() + h * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
};
const slot = (id, start, provider = 'Dr Ade') => ({ id, provider, start, end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString() });

async function reset(slots) {
  const r = await req('POST', '/reset', { body: { slots } });
  assert.equal(r.status, 200);
}

// ---------------------------------------------------------------- Level 1
test('L1: reset + list slots ordered by start with availability', async () => {
  await reset([
    slot('s2', future(30), 'Dr Bello'),
    slot('s1', future(10)),
    slot('s3', future(20)),
  ]);
  const r = await req('GET', '/slots');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.slots.map((s) => s.id), ['s1', 's3', 's2']);
  assert.ok(r.data.slots.every((s) => s.available === true));
  assert.deepEqual(Object.keys(r.data.slots[0]).sort(), ['available', 'end', 'id', 'provider', 'start']);
});

test('L1: provider filter is an exact match', async () => {
  const r = await req('GET', '/slots?provider=' + encodeURIComponent('Dr Bello'));
  assert.equal(r.status, 200);
  assert.ok(r.data.slots.length > 0);
  assert.ok(r.data.slots.every((s) => s.provider === 'Dr Bello'));
  const none = await req('GET', '/slots?provider=Dr%20Nobody');
  assert.deepEqual(none.data.slots, []);
});

test('L1: book, get by id, 404 for unknown id', async () => {
  await reset([slot('b1', future(10))]);
  const book = await req('POST', '/bookings', { body: { slot_id: 'b1', name: 'Ada Obi', email: 'ada@example.com' } });
  assert.equal(book.status, 201);
  assert.equal(book.data.status, 'confirmed');
  assert.ok(book.data.id && book.data.created_at);

  const got = await req('GET', `/bookings/${book.data.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.email, 'ada@example.com');

  const missing = await req('GET', '/bookings/nope');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.data, { error: 'booking not found' });
});

test('L1: reset wipes bookings and replaces all slots (past included)', async () => {
  await reset([slot('w1', future(5))]);
  await req('POST', '/bookings', { body: { slot_id: 'w1', name: 'X', email: 'x@example.com' } });
  const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await reset([slot('old', past)]);
  const list = await req('GET', '/slots');
  assert.deepEqual(list.data.slots.map((s) => s.id), ['old']);
  assert.equal(list.data.slots[0].available, true);
  const my = await req('GET', '/bookings?email=x@example.com');
  assert.deepEqual(my.data.bookings, []);
});

// ---------------------------------------------------------------- Level 2
test('L2: 401 without or with a wrong key, on every endpoint', async () => {
  for (const [m, p] of [['GET', '/slots'], ['POST', '/reset'], ['POST', '/bookings'], ['GET', '/bookings?email=a@b.co'], ['GET', '/bookings/x'], ['DELETE', '/bookings/x']]) {
    const noKey = await req(m, p, { key: null, body: m === 'POST' || m === 'DELETE' ? (m === 'POST' && p === '/reset' ? { slots: [] } : { slot_id: 's', name: 'n', email: 'a@b.co' }) : undefined });
    assert.equal(noKey.status, 401, `${m} ${p} without key`);
    assert.deepEqual(noKey.data, { error: 'unauthorized' });
    const badKey = await req(m, p, { key: 'wrong-key' });
    assert.equal(badKey.status, 401, `${m} ${p} wrong key`);
  }
});

test('L2: validation — missing/empty fields, bad email, unknown slot, started slot', async () => {
  await reset([slot('v1', future(10)), slot('past', new Date(Date.now() - 3600e3).toISOString())]);
  for (const body of [{}, { slot_id: 'v1', name: 'A' }, { slot_id: 'v1', name: '', email: 'a@b.co' }, { slot_id: '', name: 'A', email: 'a@b.co' }, { slot_id: 'v1', name: 'A', email: '' }]) {
    const r = await req('POST', '/bookings', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.data.error);
  }
  const badEmail = await req('POST', '/bookings', { body: { slot_id: 'v1', name: 'A', email: 'not-an-email' } });
  assert.equal(badEmail.status, 400);

  const noSlot = await req('POST', '/bookings', { body: { slot_id: 'ghost', name: 'A', email: 'a@b.co' } });
  assert.equal(noSlot.status, 404);
  assert.deepEqual(noSlot.data, { error: 'slot not found' });

  const started = await req('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: 'a@b.co' } });
  assert.equal(started.status, 400);
  assert.equal(started.data.error, 'slot has already started');

  const malformed = await fetch(base + '/bookings', { method: 'POST', headers: H, body: '{oops' });
  assert.equal(malformed.status, 400);
});

test('L2: trims name/email and stores email lowercase', async () => {
  await reset([slot('t1', future(10)), slot('t2', future(12))]);
  const r = await req('POST', '/bookings', { body: { slot_id: 't1', name: '  Ada Obi  ', email: '  AdA@Example.COM ' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.name, 'Ada Obi');
  assert.equal(r.data.email, 'ada@example.com');
  // lookup ignores case
  const found = await req('GET', '/bookings?email=ADA@EXAMPLE.com');
  assert.equal(found.data.bookings.length, 1);
});

// ---------------------------------------------------------------- Level 3
test('L3: concurrent bookings of one slot — exactly one 201, rest 409', async () => {
  await reset([slot('race', future(10))]);
  const attempts = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      req('POST', '/bookings', { body: { slot_id: 'race', name: `Racer ${i}`, email: `racer${i}@example.com` } })
    )
  );
  const ok = attempts.filter((a) => a.status === 201);
  const conflict = attempts.filter((a) => a.status === 409);
  assert.equal(ok.length, 1, `expected exactly one 201, got ${attempts.map((a) => a.status).join(',')}`);
  assert.equal(conflict.length, 11);
  assert.equal(conflict[0].data.error, 'slot already booked');

  const slots = await req('GET', '/slots');
  assert.equal(slots.data.slots[0].available, false);
});

test('L3: cancel frees the slot; second cancel is 409; freed slot can be rebooked', async () => {
  await reset([slot('c1', future(10)), slot('c2', future(12))]);
  const b = await req('POST', '/bookings', { body: { slot_id: 'c1', name: 'Ada', email: 'ada@example.com' } });

  const again = await req('POST', '/bookings', { body: { slot_id: 'c1', name: 'Bode', email: 'bode@example.com' } });
  assert.equal(again.status, 409);

  const del = await req('DELETE', `/bookings/${b.data.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.status, 'cancelled');

  const del2 = await req('DELETE', `/bookings/${b.data.id}`);
  assert.equal(del2.status, 409);
  assert.deepEqual(del2.data, { error: 'booking already cancelled' });

  const delUnknown = await req('DELETE', '/bookings/ghost-id');
  assert.equal(delUnknown.status, 404);

  const slots = await req('GET', '/slots');
  assert.equal(slots.data.slots.find((s) => s.id === 'c1').available, true);

  const rebook = await req('POST', '/bookings', { body: { slot_id: 'c1', name: 'Bode', email: 'bode@example.com' } });
  assert.equal(rebook.status, 201);
});

// ---------------------------------------------------------------- Level 4
test('L4: idempotent retry returns the same booking; different body -> 422', async () => {
  await reset([slot('i1', future(10))]);
  const first = await req('POST', '/bookings', {
    body: { slot_id: 'i1', name: 'Ada', email: 'ada@example.com' },
    headers: { 'Idempotency-Key': 'idem-1' },
  });
  assert.equal(first.status, 201);

  const retry = await req('POST', '/bookings', {
    body: { slot_id: 'i1', name: 'Ada', email: 'ada@example.com' },
    headers: { 'Idempotency-Key': 'idem-1' },
  });
  assert.equal(retry.status, 201);
  assert.equal(retry.data.id, first.data.id);

  const all = await req('GET', '/bookings?email=ada@example.com');
  assert.equal(all.data.bookings.length, 1, 'retry must not create a second booking');

  const clash = await req('POST', '/bookings', {
    body: { slot_id: 'i1', name: 'Someone Else', email: 'other@example.com' },
    headers: { 'Idempotency-Key': 'idem-1' },
  });
  assert.equal(clash.status, 422);
  assert.ok(clash.data.error);
});

test('L4: cursor pagination, oldest first, limit validation', async () => {
  await reset(Array.from({ length: 12 }, (_, i) => slot(`p${i}`, future(i + 1))));
  // Seed via the DB: booking 12 times through the API in under a minute is
  // correctly rejected by the level-5 rate limiter, which would pollute a
  // pagination test. created_at is spaced out so "oldest first" is exact.
  const { getDb } = await import('../db.js');
  const db = await getDb();
  for (let i = 0; i < 12; i++) {
    await db.query(
      `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
       VALUES ($1,$2,$3,$4,'confirmed',$5)`,
      [`00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, `p${i}`, `P${i}`, 'pager@example.com', new Date(Date.now() - (20 - i) * 60 * 1000)]
    );
  }

  const page1 = await req('GET', '/bookings?email=pager@example.com&limit=5');
  assert.equal(page1.status, 200);
  assert.equal(page1.data.bookings.length, 5);
  assert.ok(page1.data.next_cursor);

  const page2 = await req('GET', `/bookings?email=pager@example.com&limit=5&cursor=${encodeURIComponent(page1.data.next_cursor)}`);
  assert.equal(page2.data.bookings.length, 5);
  assert.ok(page2.data.next_cursor);

  const page3 = await req('GET', `/bookings?email=pager@example.com&limit=5&cursor=${encodeURIComponent(page2.data.next_cursor)}`);
  assert.equal(page3.data.bookings.length, 2);
  assert.equal(page3.data.next_cursor, null, 'last page has next_cursor null');

  const all = [...page1.data.bookings, ...page2.data.bookings, ...page3.data.bookings];
  assert.equal(new Set(all.map((b) => b.id)).size, 12, 'no duplicates across pages');
  const times = all.map((b) => new Date(b.created_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'oldest first');

  const caseInsensitive = await req('GET', '/bookings?email=PAGER@Example.COM&limit=50');
  assert.equal(caseInsensitive.data.bookings.length, 12);

  for (const bad of ['0', '51', '-1', 'abc', '2.5', '']) {
    const r = await req('GET', `/bookings?email=pager@example.com&limit=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `limit=${bad}`);
  }
  const defaultLimit = await req('GET', '/bookings?email=pager@example.com');
  assert.equal(defaultLimit.data.bookings.length, 10);
  const noEmail = await req('GET', '/bookings');
  assert.equal(noEmail.status, 400);
  const badCursor = await req('GET', '/bookings?email=pager@example.com&cursor=%%%garbage');
  assert.equal(badCursor.status, 400);
});

// ---------------------------------------------------------------- Level 5
test('L5: 6th attempt per email per minute -> 429 with Retry-After; other emails fine', async () => {
  await reset([slot('r1', future(1)), slot('r2', future(2))]);
  // 5 attempts for spam@example.com: 1 success + 4 failed (double-book) — all count
  const first = await req('POST', '/bookings', { body: { slot_id: 'r1', name: 'S', email: 'spam@example.com' } });
  assert.equal(first.status, 201);
  for (let i = 0; i < 4; i++) {
    const r = await req('POST', '/bookings', { body: { slot_id: 'r1', name: 'S', email: 'spam@example.com' } });
    assert.equal(r.status, 409);
  }
  const sixth = await req('POST', '/bookings', { body: { slot_id: 'r2', name: 'S', email: 'spam@example.com' } });
  assert.equal(sixth.status, 429);
  assert.ok(sixth.data.error);
  const ra = Number(sixth.headers.get('retry-after'));
  assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, `Retry-After should be whole seconds, got ${sixth.headers.get('retry-after')}`);

  // other emails are unaffected
  const other = await req('POST', '/bookings', { body: { slot_id: 'r2', name: 'Fine', email: 'fine@example.com' } });
  assert.equal(other.status, 201);
});

// ---------------------------------------------------------------- misc
test('unknown routes are 404 JSON; static page and config are public', async () => {
  const nf = await req('GET', '/definitely-not-a-thing');
  assert.equal(nf.status, 404);
  assert.deepEqual(nf.data, { error: 'not found' });

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Brightcare Clinic/);

  const cfg = await fetch(base + '/config.js');
  assert.equal(cfg.status, 200);
  assert.match(await cfg.text(), /APP_CONFIG/);
});
