"""End-to-end suite (stdlib HTTP client, so no client-library version churn).
Usage:
  BASE=http://127.0.0.1:8765 API_KEY=... DATABASE_URL=... python test/e2e.py
"""

import http.client
import json
import os
import ssl
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

passed, failed = 0, 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {extra}")


BASE = os.environ["BASE"]
KEY = os.environ["API_KEY"]
_u = urlparse(BASE)
IS_HTTPS = _u.scheme == "https"


def req(method, path, key=KEY, body=None, headers=None, timeout=60):
    if IS_HTTPS:
        conn = http.client.HTTPSConnection(_u.netloc, timeout=timeout, context=ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(_u.netloc, timeout=timeout)
    h = {"Content-Type": "application/json"}
    if key is not None:
        h["X-API-Key"] = key
    h.update(headers or {})
    payload = json.dumps(body) if body is not None else None
    try:
        conn.request(method, path, body=payload, headers=h)
        r = conn.getresponse()
        raw = r.read().decode()
        status, hdrs = r.status, {k.lower(): v for k, v in r.getheaders()}
    finally:
        conn.close()
    try:
        data = json.loads(raw)
    except Exception:
        data = None
    return status, data, hdrs


def future(hours):
    d = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=hours)
    return d.isoformat().replace("+00:00", "Z")


def slot(id, start, provider="Dr Ade"):
    end = (datetime.fromisoformat(start.replace("Z", "+00:00")) + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    return {"id": id, "provider": provider, "start": start, "end": end}


def main():
    # ---- L2 auth ----
    for m, p in [("GET", "/slots"), ("POST", "/reset"), ("POST", "/bookings"),
                 ("GET", "/bookings?email=a@b.co"), ("GET", "/bookings/x"), ("DELETE", "/bookings/x")]:
        anybody = {"slots": []} if p == "/reset" else {"slot_id": "s", "name": "n", "email": "a@b.co"}
        s, d, _ = req(m, p, key=None, body=anybody)
        check(f"L2 401 no key {m} {p.split('?')[0]}", s == 401 and d == {"error": "unauthorized"}, f"{s} {d}")
        s, d, _ = req(m, p, key="wrong-key", body=anybody)
        check(f"L2 401 wrong key {m} {p.split('?')[0]}", s == 401, f"{s} {d}")

    # ---- L1 reset + slots ----
    s, d, _ = req("POST", "/reset", body={"slots": [slot("s2", future(30), "Dr Bello"), slot("s1", future(10)), slot("s3", future(20))]})
    check("L1 reset", s == 200 and d == {"ok": True}, f"{s} {d}")
    s, d, _ = req("GET", "/slots")
    ids = [x["id"] for x in d["slots"]]
    check("L1 slots earliest-first + available", s == 200 and ids == ["s1", "s3", "s2"] and all(x["available"] for x in d["slots"]), f"{ids}")
    check("L1 slot shape", sorted(d["slots"][0].keys()) == ["available", "end", "id", "provider", "start"])
    s, d, _ = req("GET", "/slots?provider=Dr%20Bello")
    check("L1 provider filter", s == 200 and len(d["slots"]) == 1 and d["slots"][0]["id"] == "s2")
    s, d, _ = req("GET", "/slots?provider=Dr%20Nobody")
    check("L1 provider filter no match", s == 200 and d["slots"] == [])

    # ---- L1 book + get ----
    req("POST", "/reset", body={"slots": [slot("b1", future(10))]})
    s, d, _ = req("POST", "/bookings", body={"slot_id": "b1", "name": "Ada Obi", "email": "ada@example.com"})
    check("L1 book 201", s == 201 and d["status"] == "confirmed" and d["name"] == "Ada Obi" and d["created_at"].endswith("Z"), f"{s} {d}")
    bid = d["id"]
    s, d, _ = req("GET", f"/bookings/{bid}")
    check("L1 get booking", s == 200 and d["id"] == bid and d["email"] == "ada@example.com")
    s, d, _ = req("GET", "/bookings/nope")
    check("L1 get missing 404", s == 404 and d == {"error": "booking not found"}, f"{s} {d}")

    # ---- L1 reset wipes (past slot included) ----
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat().replace("+00:00", "Z")
    req("POST", "/reset", body={"slots": [slot("old", past)]})
    s, d, _ = req("GET", "/slots")
    check("L1 reset replaces slots, past kept", s == 200 and [x["id"] for x in d["slots"]] == ["old"] and d["slots"][0]["available"] is True)
    s, d, _ = req("GET", "/bookings?email=ada@example.com")
    check("L1 reset wiped bookings", s == 200 and d["bookings"] == [])

    # ---- L2 validation ----
    req("POST", "/reset", body={"slots": [slot("v1", future(10)), slot("past", past)]})
    for body in [{}, {"slot_id": "v1", "name": "A"}, {"slot_id": "v1", "name": "", "email": "a@b.co"},
                 {"slot_id": "", "name": "A", "email": "a@b.co"}, {"slot_id": "v1", "name": "A", "email": ""}]:
        s, d, _ = req("POST", "/bookings", body=body)
        check(f"L2 400 missing fields {json.dumps(body)[:40]}", s == 400 and "error" in d, f"{s} {d}")
    s, d, _ = req("POST", "/bookings", body={"slot_id": "v1", "name": "A", "email": "not-an-email"})
    check("L2 400 invalid email", s == 400, f"{s} {d}")
    s, d, _ = req("POST", "/bookings", body={"slot_id": "ghost", "name": "A", "email": "a@b.co"})
    check("L2 404 unknown slot", s == 404 and d == {"error": "slot not found"}, f"{s} {d}")
    s, d, _ = req("POST", "/bookings", body={"slot_id": "past", "name": "A", "email": "a@b.co"})
    check("L2 400 slot already started", s == 400 and d == {"error": "slot has already started"}, f"{s} {d}")
    # malformed JSON body
    conn = http.client.HTTPConnection(_u.netloc, timeout=30) if not IS_HTTPS else http.client.HTTPSConnection(_u.netloc, timeout=30)
    conn.request("POST", "/bookings", body="{oops", headers={"Content-Type": "application/json", "X-API-Key": KEY})
    r = conn.getresponse(); r.read(); conn.close()
    check("L2 400 malformed JSON", r.status == 400, str(r.status))

    # ---- L2 trim + lowercase ----
    req("POST", "/reset", body={"slots": [slot("t1", future(10)), slot("t2", future(12))]})
    s, d, _ = req("POST", "/bookings", body={"slot_id": "t1", "name": "  Ada Obi  ", "email": "  AdA@Example.COM "})
    check("L2 trim + lowercase", s == 201 and d["name"] == "Ada Obi" and d["email"] == "ada@example.com", f"{d}")
    s, d, _ = req("GET", "/bookings?email=ADA@EXAMPLE.com")
    check("L2 lookup case-insensitive", s == 200 and len(d["bookings"]) == 1)

    # ---- L3 race: 12 parallel bookings of one slot ----
    req("POST", "/reset", body={"slots": [slot("race", future(10))]})
    with ThreadPoolExecutor(max_workers=12) as pool:
        rs = list(pool.map(lambda i: req("POST", "/bookings", body={"slot_id": "race", "name": f"R{i}", "email": f"r{i}@example.com"})[0], range(12)))
    check("L3 concurrent race one winner", rs.count(201) == 1 and rs.count(409) == 11, f"{sorted(rs)}")
    s, d, _ = req("GET", "/slots")
    check("L3 slot now unavailable", d["slots"][0]["available"] is False)

    # ---- L3 cancel ----
    req("POST", "/reset", body={"slots": [slot("c1", future(10)), slot("c2", future(12))]})
    s, d, _ = req("POST", "/bookings", body={"slot_id": "c1", "name": "Ada", "email": "ada@example.com"})
    cid = d["id"]
    s, d, _ = req("POST", "/bookings", body={"slot_id": "c1", "name": "Bode", "email": "bode@example.com"})
    check("L3 409 while confirmed", s == 409 and d == {"error": "slot already booked"}, f"{s} {d}")
    s, d, _ = req("DELETE", f"/bookings/{cid}")
    check("L3 cancel 200", s == 200 and d["status"] == "cancelled")
    s, d, _ = req("DELETE", f"/bookings/{cid}")
    check("L3 recancel 409", s == 409 and d == {"error": "booking already cancelled"}, f"{s} {d}")
    s, d, _ = req("DELETE", "/bookings/ghost-id")
    check("L3 cancel unknown 404", s == 404)
    s, d, _ = req("GET", "/slots")
    check("L3 slot freed", d["slots"][0]["available"] is True)
    s, d, _ = req("POST", "/bookings", body={"slot_id": "c1", "name": "Bode", "email": "bode@example.com"})
    check("L3 rebook freed slot", s == 201)

    # ---- L4 idempotency ----
    req("POST", "/reset", body={"slots": [slot("i1", future(10))]})
    s1, d1, _ = req("POST", "/bookings", body={"slot_id": "i1", "name": "Ada", "email": "ada@example.com"}, headers={"Idempotency-Key": "idem-1"})
    s2, d2, _ = req("POST", "/bookings", body={"slot_id": "i1", "name": "Ada", "email": "ada@example.com"}, headers={"Idempotency-Key": "idem-1"})
    s3, d3, _ = req("POST", "/bookings", body={"slot_id": "i1", "name": "Other", "email": "other@example.com"}, headers={"Idempotency-Key": "idem-1"})
    check("L4 replay same booking", s1 == 201 and s2 == 201 and d2["id"] == d1["id"], f"{s1}/{s2}")
    s, d, _ = req("GET", "/bookings?email=ada@example.com")
    check("L4 no duplicate booking", len(d["bookings"]) == 1)
    check("L4 422 key reuse", s3 == 422 and "error" in d3, f"{s3} {d3}")

    # ---- L4 pagination (seeded straight into the DB; the API rate limit would
    # correctly block 12 rapid bookings for one email) ----
    req("POST", "/reset", body={"slots": [slot(f"p{i}", future(i + 1)) for i in range(12)]})

    import asyncio
    import asyncpg

    async def seed():
        con = await asyncpg.connect(os.environ["DATABASE_URL"])
        for i in range(12):
            await con.execute(
                "INSERT INTO bookings (id, slot_id, name, email, status, created_at) VALUES ($1,$2,$3,$4,'confirmed',$5)",
                f"00000000-0000-4000-8000-{i:012d}", f"p{i}", f"P{i}", "pager@example.com",
                datetime.now(timezone.utc) - timedelta(minutes=(20 - i)))
        await con.close()

    asyncio.run(seed())

    s, d, _ = req("GET", "/bookings?email=pager@example.com&limit=5")
    check("L4 page 1", s == 200 and len(d["bookings"]) == 5 and d["next_cursor"], f"{s}")
    cur = d["next_cursor"]
    s, d, _ = req("GET", f"/bookings?email=pager@example.com&limit=5&cursor={cur}")
    check("L4 page 2", s == 200 and len(d["bookings"]) == 5 and d["next_cursor"])
    cur2 = d["next_cursor"]
    s, d, _ = req("GET", f"/bookings?email=pager@example.com&limit=5&cursor={cur2}")
    check("L4 page 3 ends null", s == 200 and len(d["bookings"]) == 2 and d["next_cursor"] is None, f"{s}")
    s, d, _ = req("GET", "/bookings?email=PAGER@Example.COM&limit=50")
    check("L4 case-insensitive + oldest first", len(d["bookings"]) == 12 and
          all(d["bookings"][i]["created_at"] <= d["bookings"][i + 1]["created_at"] for i in range(11)))
    for bad in ["0", "51", "-1", "abc", "2.5", ""]:
        s, d, _ = req("GET", f"/bookings?email=pager@example.com&limit={bad}")
        check(f"L4 400 limit={bad!r}", s == 400, f"{s}")
    s, d, _ = req("GET", "/bookings?email=pager@example.com")
    check("L4 default limit 10", len(d["bookings"]) == 10)
    s, d, _ = req("GET", "/bookings")
    check("L4 400 no email", s == 400, f"{s}")
    s, d, _ = req("GET", "/bookings?email=pager@example.com&cursor=%25%25%25garbage")
    check("L4 400 bad cursor", s == 400, f"{s}")

    # ---- L5 rate limit ----
    req("POST", "/reset", body={"slots": [slot("r1", future(1)), slot("r2", future(2))]})
    s, _, _ = req("POST", "/bookings", body={"slot_id": "r1", "name": "S", "email": "spam@example.com"})
    check("L5 first attempt ok", s == 201)
    for i in range(4):
        s, _, _ = req("POST", "/bookings", body={"slot_id": "r1", "name": "S", "email": "spam@example.com"})
        check(f"L5 failed attempt {i + 2} counts (409)", s == 409)
    s, d, h = req("POST", "/bookings", body={"slot_id": "r2", "name": "S", "email": "spam@example.com"})
    ra = h.get("retry-after")
    check("L5 6th attempt 429 + Retry-After", s == 429 and ra and ra.isdigit() and 1 <= int(ra) <= 60, f"{s} ra={ra}")
    s, d, _ = req("POST", "/bookings", body={"slot_id": "r2", "name": "F", "email": "fine@example.com"})
    check("L5 other email unaffected", s == 201)

    # ---- CORS preflights (what a browser sends before any cross-origin call) ----
    for m, path in [("GET", "/slots"), ("POST", "/bookings"), ("DELETE", "/bookings/x"), ("POST", "/reset")]:
        u = urlparse(BASE)
        conn = (http.client.HTTPSConnection if IS_HTTPS else http.client.HTTPConnection)(_u.netloc, timeout=30)
        conn.request("OPTIONS", path, headers={
            "Origin": "https://clinic-booking-web-uxgm.onrender.com",
            "Access-Control-Request-Method": m,
            "Access-Control-Request-Headers": "content-type, x-api-key, idempotency-key",
        })
        r = conn.getresponse(); body = r.read(); conn.close()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        check(f"CORS preflight {m} {path}", r.status in (200, 204) and
              hdrs.get("access-control-allow-origin") == "*" and
              "x-api-key" in hdrs.get("access-control-allow-headers", ""),
              f"{r.status} {hdrs.get('access-control-allow-headers')}")

    # ---- misc ----
    s, d, _ = req("GET", "/definitely-not-a-thing")
    check("404 unknown route", s == 404 and d == {"error": "not found"}, f"{s} {d}")
    s, d, _ = req("GET", "/")
    check("landing json", s == 200 and d.get("ok") is True)

    # leave the demo data clean
    demo = datetime.now(timezone.utc) + timedelta(days=14)
    demo_slots = [{"id": f"s{i}", "provider": p, "start": (demo + timedelta(days=i - 1)).replace(hour=9 + (i % 5), minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z"),
                   "end": (demo + timedelta(days=i - 1)).replace(hour=9 + (i % 5), minute=30, second=0, microsecond=0).isoformat().replace("+00:00", "Z")}
                  for i, p in enumerate(["Dr Ade", "Dr Ade", "Dr Bello", "Dr Bello", "Dr Chandra", "Dr Chandra"], start=1)]
    req("POST", "/reset", body={"slots": demo_slots})

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


main()
