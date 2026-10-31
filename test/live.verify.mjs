// Live verification against the deployed HTTPS URL.
// Usage: BASE=https://... API_KEY=... node test/live.verify.mjs
const base = process.env.BASE || 'https://clinic-booking-api-lwo2.onrender.com';
const KEY = process.env.API_KEY;
if (!KEY) throw new Error('API_KEY env required');
import('node:assert').then(async ({ strict: assert }) => {
  const H = { 'Content-Type': 'application/json', 'X-API-Key': KEY };
  const req = async (m, p, { key = KEY, body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { 'X-API-Key': key }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data, headers: res.headers };
  };
  const future = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const slot = (id, start, provider = 'Dr Ade') => ({ id, provider, start, end: new Date(Date.parse(start) + 30 * 60000).toISOString() });
  const log = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

  // cold start tolerance
  let r;
  for (let i = 0; i < 5; i++) {
    try { r = await req('GET', '/slots'); break; } catch (e) { console.log('waiting for cold start…'); await new Promise(r => setTimeout(r, 8000)); }
  }

  // L2 auth
  const noKey = await req('GET', '/slots', { key: null });
  const badKey = await req('GET', '/slots', { key: 'wrong' });
  log('L2 401s', noKey.status === 401 && badKey.status === 401, `${noKey.status}/${badKey.status}`);

  // L1 reset + slots
  r = await req('POST', '/reset', { body: { slots: [slot('s1', future(10)), slot('s2', future(12), 'Dr Bello'), slot('s3', future(14))] } });
  log('L1 reset', r.status === 200, String(r.status));
  r = await req('GET', '/slots');
  log('L1 slots ordered+available', r.status === 200 && r.data.slots.map(s => s.id).join() === 's1,s2,s3' && r.data.slots.every(s => s.available === true));
  r = await req('GET', '/slots?provider=' + encodeURIComponent('Dr Bello'));
  log('L1 provider filter', r.data.slots.length === 1 && r.data.slots[0].id === 's2');

  // L2 validation
  const bad = await req('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email: 'nope' } });
  const missing = await req('POST', '/bookings', { body: { slot_id: '', name: '', email: '' } });
  const ghost = await req('POST', '/bookings', { body: { slot_id: 'ghost', name: 'A', email: 'a@b.co' } });
  log('L2 validation', bad.status === 400 && missing.status === 400 && ghost.status === 404, `${bad.status}/${missing.status}/${ghost.status}`);
  const booked = await req('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi ', email: ' ADA@Example.COM ' } });
  log('L1 book + L2 trim/lower', booked.status === 201 && booked.data.email === 'ada@example.com' && booked.data.name === 'Ada Obi');
  const got = await req('GET', '/bookings/' + booked.data.id);
  log('L1 get booking', got.status === 200 && got.data.id === booked.data.id);

  // L3 double-book + cancel
  const dup = await req('POST', '/bookings', { body: { slot_id: 's1', name: 'B', email: 'b@b.co' } });
  log('L3 409 on taken slot', dup.status === 409, String(dup.status));
  const cancel = await req('DELETE', '/bookings/' + booked.data.id);
  const recancel = await req('DELETE', '/bookings/' + booked.data.id);
  log('L3 cancel + 409 recancel', cancel.status === 200 && cancel.data.status === 'cancelled' && recancel.status === 409);
  const rebook = await req('POST', '/bookings', { body: { slot_id: 's1', name: 'B', email: 'b@b.co' } });
  log('L3 slot freed after cancel', rebook.status === 201);

  // L3 concurrency
  await req('POST', '/reset', { body: { slots: [slot('race', future(10))] } });
  const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) => req('POST', '/bookings', { body: { slot_id: 'race', name: `R${i}`, email: `r${i}@x.co` } })));
  const codes = attempts.map(a => a.status);
  log('L3 concurrent race', codes.filter(c => c === 201).length === 1 && codes.filter(c => c === 409).length === 9, codes.join(','));

  // L4 idempotency (re-seed slots — the race test reset the DB)
  await req('POST', '/reset', { body: { slots: [slot('s2', future(10)), slot('s3', future(12))] } });
  const i1 = await req('POST', '/bookings', { body: { slot_id: 's2', name: 'Ada', email: 'ada@example.com' }, headers: { 'Idempotency-Key': 'live-1' } });
  const i2 = await req('POST', '/bookings', { body: { slot_id: 's2', name: 'Ada', email: 'ada@example.com' }, headers: { 'Idempotency-Key': 'live-1' } });
  const i3 = await req('POST', '/bookings', { body: { slot_id: 's3', name: 'Ada', email: 'ada@example.com' }, headers: { 'Idempotency-Key': 'live-1' } });
  log('L4 idempotency', i1.status === 201 && i2.status === 201 && i2.data.id === i1.data.id && i3.status === 422, `${i1.status}/${i2.status}/${i3.status}`);

  // L4 pagination — a second booking for ada so there are 2 pages of 1
  await req('POST', '/bookings', { body: { slot_id: 's3', name: 'Ada', email: 'ADA@Example.com' } });
  const p1 = await req('GET', '/bookings?email=ada@example.com&limit=1');
  log('L4 list+case-insensitive email', p1.status === 200 && p1.data.bookings.length === 1 && p1.data.next_cursor !== null);
  const p2 = await req('GET', `/bookings?email=ADA@EXAMPLE.COM&limit=1&cursor=${encodeURIComponent(p1.data.next_cursor)}`);
  log('L4 cursor page 2', p2.status === 200 && p2.data.bookings.length === 1);
  const badLim = await req('GET', '/bookings?email=ada@example.com&limit=51');
  log('L4 limit validation', badLim.status === 400);

  // L5 rate limit
  await req('POST', '/reset', { body: { slots: [slot('r1', future(10)), slot('r2', future(12))] } });
  const first = await req('POST', '/bookings', { body: { slot_id: 'r1', name: 'S', email: 'spam@x.co' } });
  for (let i = 0; i < 4; i++) await req('POST', '/bookings', { body: { slot_id: 'r1', name: 'S', email: 'spam@x.co' } });
  const sixth = await req('POST', '/bookings', { body: { slot_id: 'r2', name: 'S', email: 'spam@x.co' } });
  const other = await req('POST', '/bookings', { body: { slot_id: 'r2', name: 'F', email: 'fine@x.co' } });
  log('L5 rate limit', first.status === 201 && sixth.status === 429 && /^\d+$/.test(sixth.headers.get('retry-after') || '') && other.status === 201, `6th=${sixth.status} retry-after=${sixth.headers.get('retry-after')} other=${other.status}`);

  // web page
  const page = await fetch(base + '/');
  const cfg = await fetch(base + '/config.js');
  log('web page + config', page.status === 200 && (await page.text()).includes('Brightcare') && cfg.status === 200);

  console.log('\nBase URL:', base);
  process.exit(0);
});
