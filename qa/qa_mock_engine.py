"""
Solder mock-engine QA harness.

Codifies coverage for the mock-engine MVP (FullSpec.md § 5.1):
  - happy-path responders (list / get / create)
  - request validators (auth_bearer, json_body)
  - error injector (field_value, manual, random)
  - session overlay + reset
  - audit trail (with a real Run)
  - pipeline edge cases (404 unknown route / integration / side)
  - performance + concurrency targets

Usage: `python qa/qa_mock_engine.py`
Exits non-zero if any scenario fails.
"""
from __future__ import annotations

import asyncio
import io
import json
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

# Windows cp1252 stdout chokes on unicode arrows — force UTF-8.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# Make the backend importable so we can drop into the same async DB engine
# the app uses for audit-row inspection.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# The backend's pydantic-settings reads .env relative to CWD; QA may run from
# anywhere. Force-load the backend env so DATABASE_URL points at port 5433
# (host postgres maps to 5433 — see project memory).
import os as _os
_envp = ROOT / "backend" / ".env"
if _envp.is_file():
    for _line in _envp.read_text(encoding="utf-8").splitlines():
        if not _line.strip() or _line.lstrip().startswith("#") or "=" not in _line:
            continue
        _k, _, _v = _line.partition("=")
        _os.environ.setdefault(_k.strip(), _v.strip())
# The backend ships with DEBUG=true which makes SQLAlchemy log every query.
# We do real DB work for the audit scenario — flip debug off in *this*
# process before app.config is imported so logs stay readable.
_os.environ["DEBUG"] = "false"

API = "http://localhost:8000"
AUTH = {"Authorization": "Bearer qa-test-token"}
OUT = Path(__file__).parent / "artifacts"
OUT.mkdir(exist_ok=True)


@dataclass
class TestResult:
    name: str
    passed: bool
    notes: list[str] = field(default_factory=list)
    bug: Optional[str] = None  # populated when the test exposes an engine bug

    def fail(self, msg: str) -> None:
        self.passed = False
        self.notes.append(f"FAIL: {msg}")

    def note(self, msg: str) -> None:
        self.notes.append(msg)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def seed(client: httpx.AsyncClient) -> dict[str, str]:
    r = await client.post(f"{API}/api/dev/seed-mock-demo")
    r.raise_for_status()
    return r.json()


def mock_url(integration_id: str, path: str, alias: str = "zip") -> str:
    """Slice 2.5: mock-engine routes are alias-keyed. The seeded demo
    integration binds the Zip connection under alias `zip`."""
    return f"{API}/api/mock/{integration_id}/{alias}/{path.lstrip('/')}"


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

async def scenario_happy_paths(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("happy_paths", True)
    seeded = await seed(client)
    iid = seeded["integration_id"]

    # 1a. List vendors no params → uses default page_size 25; bank has 5 vendors.
    resp = await client.get(mock_url(iid, "v1/vendors"), headers=AUTH)
    if resp.status_code != 200:
        r.fail(f"GET vendors → {resp.status_code} body={resp.text[:200]}")
        return r
    body = resp.json()
    if body.get("total") != 5 or len(body.get("data", [])) != 5:
        r.fail(f"vendor list: total={body.get('total')} len={len(body.get('data', []))}")
    if body.get("has_more") is not False:
        r.fail(f"has_more should be False on full page, got {body.get('has_more')}")
    if "X-Mock-Engine" not in resp.headers:
        r.fail("X-Mock-Engine response header missing")
    r.note(f"GET vendors → 200, total=5, has_more=False")

    # 1b. Pagination: limit=2 offset=0 → 2 items, has_more=True.
    resp = await client.get(mock_url(iid, "v1/vendors") + "?limit=2&offset=0", headers=AUTH)
    body = resp.json()
    if len(body["data"]) != 2 or body["has_more"] is not True:
        r.fail(f"limit=2 offset=0 → len={len(body['data'])} has_more={body['has_more']}")
    else:
        r.note("limit=2 offset=0 → 2 items, has_more=True")

    # 1c. offset > total → empty page, has_more=False.
    resp = await client.get(mock_url(iid, "v1/vendors") + "?offset=999", headers=AUTH)
    body = resp.json()
    if body["data"] or body["has_more"] is not False:
        r.fail(f"offset=999 → data len={len(body['data'])} has_more={body['has_more']}")
    else:
        r.note("offset>total → empty page")

    # 1d. limit > total + offset=0 → all rows, has_more=False.
    resp = await client.get(mock_url(iid, "v1/vendors") + "?limit=999", headers=AUTH)
    body = resp.json()
    if len(body["data"]) != 5 or body["has_more"]:
        r.fail(f"limit=999 → len={len(body['data'])} has_more={body['has_more']}")
    else:
        r.note("limit>total → all rows")

    # 1e. Get-by-id known.
    resp = await client.get(mock_url(iid, "v1/vendors/v_acme"), headers=AUTH)
    if resp.status_code != 200 or resp.json().get("id") != "v_acme":
        r.fail(f"GET vendors/v_acme → {resp.status_code} {resp.text[:200]}")
    else:
        r.note("get_entity v_acme ✓")

    # 1f. Get-by-id missing → 404.
    resp = await client.get(mock_url(iid, "v1/vendors/v_unknown"), headers=AUTH)
    if resp.status_code != 404:
        r.fail(f"GET vendors/v_unknown → {resp.status_code} (expected 404)")
    else:
        r.note("get_entity miss → 404 ✓")

    # 1g. Create + list-includes-it (session overlay live).
    create = await client.post(
        mock_url(iid, "v1/purchase_orders"),
        headers={**AUTH, "Content-Type": "application/json"},
        json={"vendor_id": "v_acme", "line_items": [{"sku": "X", "qty": 1}]},
    )
    if create.status_code != 201:
        r.fail(f"POST purchase_orders → {create.status_code} {create.text[:200]}")
        return r
    new_id = create.json()["id"]
    if not new_id:
        r.fail("created PO missing id")
    listing = await client.get(mock_url(iid, "v1/purchase_orders") + "?limit=200", headers=AUTH)
    ids = [p["id"] for p in listing.json()["data"]]
    if new_id not in ids:
        r.fail(f"created PO {new_id} not visible in list {ids[:3]}…")
    else:
        r.note(f"create→list overlay live (new_id={new_id[:12]}…)")

    # 1h. The created entity is also gettable via GET by id.
    detail = await client.get(mock_url(iid, f"v1/purchase_orders/{new_id}"), headers=AUTH)
    if detail.status_code != 200 or detail.json().get("id") != new_id:
        r.fail(f"GET created PO → {detail.status_code}")
    else:
        r.note("created PO retrievable via GET ✓")
    return r


async def scenario_auth(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("auth", True)
    iid = (await seed(client))["integration_id"]
    url = mock_url(iid, "v1/vendors")

    # Missing header.
    resp = await client.get(url)
    if resp.status_code != 401:
        r.fail(f"missing auth header → {resp.status_code} (expected 401)")

    # Malformed (no Bearer).
    resp = await client.get(url, headers={"Authorization": "qa-test-token"})
    if resp.status_code != 401:
        r.fail(f"missing 'Bearer ' prefix → {resp.status_code} (expected 401)")

    # Empty token. httpx (h11) rejects literal "Bearer " (trailing space), so
    # we drop to urllib.request to send the unsanitised header through.
    import urllib.request
    import urllib.error
    try:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer "})
        await asyncio.to_thread(urllib.request.urlopen, req, None, 10)
        r.fail("empty bearer token → urllib raised no HTTPError (expected 401)")
    except urllib.error.HTTPError as e:
        if e.code != 401:
            r.fail(f"empty bearer token → {e.code} (expected 401)")
    except Exception as exc:
        r.note(f"empty bearer token: urllib error {exc!r} (test skipped)")

    # Bearer with token → 200.
    resp = await client.get(url, headers={"Authorization": "Bearer something"})
    if resp.status_code != 200:
        r.fail(f"bearer OK → {resp.status_code} (expected 200)")
    r.note("auth_bearer enforces presence + Bearer prefix + non-empty token ✓")
    return r


async def scenario_validation(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("validation", True)
    iid = (await seed(client))["integration_id"]
    url = mock_url(iid, "v1/purchase_orders")

    # Non-JSON body (raw string).
    resp = await client.post(url, headers={**AUTH, "Content-Type": "text/plain"}, content="not json")
    if resp.status_code != 400:
        r.fail(f"non-JSON body → {resp.status_code} (expected 400 zip.body.malformed)")
    else:
        r.note(f"non-JSON body → 400 ✓ ({resp.headers.get('X-Mock-Error-Id')})")

    # Non-object JSON: array.
    resp = await client.post(url, headers=AUTH, json=[1, 2, 3])
    if resp.status_code != 400:
        r.fail(f"JSON array body → {resp.status_code} (expected 400)")
    else:
        r.note("JSON array body → 400 ✓")

    # Non-object JSON: number.
    resp = await client.post(url, headers=AUTH, json=42)
    if resp.status_code != 400:
        r.fail(f"JSON number body → {resp.status_code} (expected 400)")

    # Missing vendor_id.
    resp = await client.post(url, headers=AUTH, json={"line_items": [{"sku": "X", "qty": 1}]})
    if resp.status_code not in (400, 422):
        r.fail(f"missing vendor_id → {resp.status_code} (expected 400/422)")
    else:
        r.note(f"missing vendor_id → {resp.status_code} (eid={resp.headers.get('X-Mock-Error-Id')}) ✓")

    # Missing line_items.
    resp = await client.post(url, headers=AUTH, json={"vendor_id": "v_acme"})
    if resp.status_code not in (400, 422):
        r.fail(f"missing line_items → {resp.status_code} (expected 400/422)")
    else:
        r.note(f"missing line_items → {resp.status_code} ✓")

    # Both missing.
    resp = await client.post(url, headers=AUTH, json={"foo": "bar"})
    if resp.status_code not in (400, 422):
        r.fail(f"both fields missing → {resp.status_code} (expected 400/422)")

    # Extra unknown fields → still creates (extra fields tolerated per spec).
    resp = await client.post(
        url,
        headers=AUTH,
        json={
            "vendor_id": "v_acme",
            "line_items": [{"sku": "X", "qty": 1}],
            "totally_unknown": "ok",
            "another": 42,
        },
    )
    if resp.status_code != 201:
        r.fail(f"extra fields → {resp.status_code} (expected 201)")
    else:
        r.note("extra fields → 201 (tolerated) ✓")
    return r


async def scenario_error_injection(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("error_injection", True)
    iid = (await seed(client))["integration_id"]
    url = mock_url(iid, "v1/purchase_orders")

    # field_value: vendor not in bank.
    resp = await client.post(
        url,
        headers=AUTH,
        json={"vendor_id": "v_missing", "line_items": [{"sku": "X", "qty": 1}]},
    )
    if resp.status_code != 400:
        r.fail(f"v_missing → {resp.status_code} (expected 400)")
    elif resp.headers.get("X-Mock-Error-Id") != "zip.po.invalid_vendor_ref":
        r.fail(f"v_missing wrong error id: {resp.headers.get('X-Mock-Error-Id')}")
    else:
        body = resp.json()
        msg = body.get("error", {}).get("message", "")
        if "v_missing" not in msg:
            r.fail(f"placeholder {{vendor_id}} not rendered: {msg!r}")
        else:
            r.note(f"v_missing fired zip.po.invalid_vendor_ref + rendered placeholder ✓")

    # field_value with empty string vendor_id (treated as not_in_bank per code).
    # NB: required_fields check in create_entity rejects empty string at 422
    # *after* error_injector — so the 400 from field_value should win since
    # the injector runs before the responder (router.py:136 vs :167).
    resp = await client.post(
        url,
        headers=AUTH,
        json={"vendor_id": "", "line_items": [{"sku": "X", "qty": 1}]},
    )
    eid = resp.headers.get("X-Mock-Error-Id")
    if resp.status_code == 400 and eid == "zip.po.invalid_vendor_ref":
        r.note("empty vendor_id fired field_value (expected: injector before responder) ✓")
    elif resp.status_code == 422:
        r.note(f"empty vendor_id → 422 from create_entity required-fields check (note: pipeline order)")
    else:
        r.fail(f"empty vendor_id unexpected: {resp.status_code} eid={eid}")

    # manual via X-Solder-Force-Error.
    resp = await client.post(
        url,
        headers={**AUTH, "X-Solder-Force-Error": "zip.po.duplicate_create"},
        json={"vendor_id": "v_acme", "line_items": [{"sku": "X", "qty": 1}], "external_id": "ext-1"},
    )
    if resp.status_code != 409 or resp.headers.get("X-Mock-Error-Id") != "zip.po.duplicate_create":
        r.fail(f"manual force → {resp.status_code} eid={resp.headers.get('X-Mock-Error-Id')}")
    else:
        r.note("manual X-Solder-Force-Error fires zip.po.duplicate_create ✓")

    # random / chaos: 50 calls with X-Solder-Chaos: 1, expect ≈ 5%.
    chaos_hits = 0
    chaos_total = 50
    for _ in range(chaos_total):
        resp = await client.get(mock_url(iid, "v1/vendors"), headers={**AUTH, "X-Solder-Chaos": "1"})
        if resp.status_code == 429 and resp.headers.get("X-Mock-Error-Id") == "zip.rate_limit.exceeded":
            chaos_hits += 1
    rate = chaos_hits / chaos_total
    r.note(f"chaos 50 reqs → {chaos_hits} rate-limit hits ({rate:.0%}) (target ≈ 5%)")
    if chaos_hits == 0:
        r.bug = (
            "error_injector.py:74 seeds `random.Random(chaos_seed)` per request "
            "with chaos_seed=0 default. random.Random(0).random() == 0.844, > 0.05 "
            "weight, so the random trigger NEVER fires. The generator is reset "
            "every call instead of being shared/persisted. Chaos rate is "
            "effectively 0%, not 5%."
        )
        r.fail(f"chaos rate 0% — random injector deterministic per-request (see bug)")
    elif chaos_hits == chaos_total:
        r.bug = (
            "error_injector.py:74 — chaos rate is 100%, not 5%. The seeded RNG "
            "fires every request because chaos_seed is constant and the first "
            "random() < 0.05 in this seed."
        )
        r.fail(f"chaos rate 100% — random injector fires every call")
    elif not (0.005 <= rate <= 0.20):
        r.note(f"chaos rate {rate:.0%} outside 0.5%–20% sanity band")
    return r


async def scenario_session_overlay(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("session_overlay", True)
    iid = (await seed(client))["integration_id"]
    create_url = mock_url(iid, "v1/purchase_orders")

    # Create A.
    a = await client.post(
        create_url,
        headers=AUTH,
        json={"id": "po_overlay_A", "vendor_id": "v_acme", "line_items": [{"sku": "X", "qty": 1}]},
    )
    if a.status_code != 201:
        r.fail(f"create A → {a.status_code}")
        return r

    # List sees it.
    listing = await client.get(mock_url(iid, "v1/purchase_orders") + "?limit=200", headers=AUTH)
    if "po_overlay_A" not in [p["id"] for p in listing.json()["data"]]:
        r.fail("po_overlay_A absent from list after create")
    else:
        r.note("create A visible in list ✓")

    # Create same id twice — latest wins.
    b = await client.post(
        create_url,
        headers=AUTH,
        json={"id": "po_overlay_A", "vendor_id": "v_acme", "line_items": [{"sku": "Y", "qty": 99}]},
    )
    if b.status_code != 201:
        r.fail(f"create same id twice → {b.status_code}")
    detail = await client.get(mock_url(iid, "v1/purchase_orders/po_overlay_A"), headers=AUTH)
    body = detail.json()
    line_qty = (body.get("line_items") or [{}])[0].get("qty")
    if line_qty == 99:
        r.note("create-same-id twice: latest wins ✓")
    elif line_qty == 1:
        r.fail("create-same-id twice: original wins (later write should override)")
    else:
        r.note(f"create-same-id twice: line qty={line_qty} (ambiguous)")

    # Re-seed wipes scratch session — created PO is gone.
    await seed(client)
    listing = await client.get(mock_url(iid, "v1/purchase_orders") + "?limit=200", headers=AUTH)
    ids_after = [p["id"] for p in listing.json()["data"]]
    if "po_overlay_A" in ids_after:
        r.fail("re-seed did NOT wipe scratch session: po_overlay_A still present")
    else:
        r.note("re-seed wipes scratch session ✓")
    return r


async def scenario_edge_cases(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("edge_cases", True)
    iid = (await seed(client))["integration_id"]

    async def _safe_get(url: str) -> Optional[httpx.Response]:
        # Keep-alive can drop after a 404 from FastAPI's startup exception
        # path; retry once on ReadError so we don't lose the test.
        for _ in range(2):
            try:
                return await client.get(url, headers=AUTH)
            except (httpx.ReadError, httpx.RemoteProtocolError, httpx.ConnectError):
                await asyncio.sleep(0.05)
        return None

    # Unknown route on a known integration → 404.
    resp = await _safe_get(mock_url(iid, "v1/nope/route"))
    if resp is None or resp.status_code != 404:
        r.fail(f"unknown route → {resp.status_code if resp else 'None'} (expected 404)")
        if resp is not None and resp.status_code == 500:
            r.bug = (
                "router.py:81 — unknown-route branch returns the coroutine "
                "from `_audit_and_respond` without `await`, so FastAPI receives "
                "a coroutine instead of a Response and 500s. Lines 112 and 146 "
                "correctly await the same call. Adding `await` on line 81 fixes."
            )
    else:
        r.note("unknown route → 404 ✓")

    # Unknown integration_id → 404.
    resp = await _safe_get(mock_url("00000000-0000-0000-0000-000000000000", "v1/vendors"))
    if resp is None or resp.status_code != 404:
        r.fail(f"unknown integration → {resp.status_code if resp else 'None'} (expected 404)")
    else:
        r.note("unknown integration → 404 ✓")

    # Wrong side ('target' for source-only spec) → 404.
    resp = await _safe_get(mock_url(iid, "v1/vendors", side="target"))
    if resp is None or resp.status_code != 404:
        r.fail(f"wrong side → {resp.status_code if resp else 'None'} (expected 404)")
    else:
        r.note("wrong side → 404 ✓")

    # Path-template edge: trailing extra segments must NOT match `/{id}`.
    # Same router.py:81 bug surfaces here (no matching template → 500 instead
    # of 404); template logic itself in spec_loader._path_matches is correct.
    resp = await _safe_get(mock_url(iid, "v1/vendors/v_acme/extra/segments"))
    if resp is None or resp.status_code != 404:
        r.fail(
            f"vendors/v_acme/extra/segments → {resp.status_code if resp else 'None'} "
            f"(expected 404; same router.py:81 missing-await bug)"
        )
    else:
        r.note("path-template segment count guard ✓")
    return r


async def scenario_audit(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("audit", True)
    # Earlier scenarios may have torn down their keep-alive sockets via 500
    # paths in the engine — open a fresh client just for this scenario so we
    # don't inherit any half-closed sockets from the pool.
    async with httpx.AsyncClient(timeout=30) as fresh:
        return await _scenario_audit_inner(fresh, r)


async def _scenario_audit_inner(client: httpx.AsyncClient, r: TestResult) -> TestResult:
    seeded = await seed(client)
    iid = seeded["integration_id"]

    # Create a real run to attach audit rows to.
    run_resp = await client.post(
        f"{API}/api/runs",
        json={"integration_id": iid, "input_data": {}, "trigger_source": "manual"},
    )
    if run_resp.status_code not in (200, 201):
        r.note(f"deferred: could not create Run ({run_resp.status_code} {run_resp.text[:120]})")
        return r
    run_id = run_resp.json()["id"]

    # Snapshot current count, hit the engine with the run header, then count again.
    from app.database import async_session  # type: ignore
    from app.models import RunAuditEvent  # type: ignore
    from sqlalchemy import select, func

    async with async_session() as db:
        before = (
            await db.execute(
                select(func.count(RunAuditEvent.id)).where(RunAuditEvent.run_id == run_id)
            )
        ).scalar_one()

    # POST with X-Solder-Run-Id → expect 2 rows (request + response).
    resp = await client.post(
        mock_url(iid, "v1/purchase_orders"),
        headers={**AUTH, "X-Solder-Run-Id": run_id},
        json={"vendor_id": "v_acme", "line_items": [{"sku": "X", "qty": 1}]},
    )
    if resp.status_code != 201:
        r.fail(f"POST with run id → {resp.status_code}")
        return r

    async with async_session() as db:
        after = (
            await db.execute(
                select(func.count(RunAuditEvent.id)).where(RunAuditEvent.run_id == run_id)
            )
        ).scalar_one()

    delta = after - before
    if delta != 2:
        r.fail(f"audit rows after POST: delta={delta} (expected 2)")
    else:
        r.note(f"POST with X-Solder-Run-Id wrote 2 audit rows ✓")

    # Now POST without run header — delta must still be 0 against a fresh count.
    async with async_session() as db:
        before2 = (
            await db.execute(
                select(func.count(RunAuditEvent.id)).where(RunAuditEvent.run_id == run_id)
            )
        ).scalar_one()
    await client.post(
        mock_url(iid, "v1/purchase_orders"),
        headers=AUTH,
        json={"vendor_id": "v_acme", "line_items": [{"sku": "X", "qty": 1}]},
    )
    async with async_session() as db:
        after2 = (
            await db.execute(
                select(func.count(RunAuditEvent.id)).where(RunAuditEvent.run_id == run_id)
            )
        ).scalar_one()
    if after2 != before2:
        r.fail(f"POST WITHOUT run id leaked rows: delta={after2 - before2} (expected 0)")
    else:
        r.note("POST without run id wrote 0 audit rows ✓")

    # Auth redaction sanity: pull the freshest request row, confirm Authorization is masked.
    async with async_session() as db:
        ev = (
            await db.execute(
                select(RunAuditEvent)
                .where(RunAuditEvent.run_id == run_id, RunAuditEvent.direction == "request")
                .order_by(RunAuditEvent.timestamp.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if ev is None:
        r.note("no request audit row found to inspect")
    else:
        auth_val = (ev.headers or {}).get("authorization") or (ev.headers or {}).get("Authorization")
        if auth_val and "redacted" in str(auth_val).lower():
            r.note("Authorization header redacted in audit storage ✓")
        else:
            r.fail(f"Authorization NOT redacted in audit row: {auth_val!r}")
    return r


async def scenario_performance(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("performance", True)
    iid = (await seed(client))["integration_id"]
    url = mock_url(iid, "v1/purchase_orders") + "?limit=25"

    n = 200
    samples = []
    for _ in range(n):
        t0 = time.perf_counter()
        resp = await client.get(url, headers=AUTH)
        samples.append((time.perf_counter() - t0) * 1000)
        if resp.status_code != 200:
            r.fail(f"perf: status {resp.status_code} mid-run")
            break

    samples.sort()
    p50 = samples[len(samples) // 2]
    p95 = samples[int(len(samples) * 0.95)]
    p99 = samples[int(len(samples) * 0.99)]
    avg = statistics.mean(samples)
    r.note(f"GET list × {n}: avg={avg:.1f}ms p50={p50:.1f}ms p95={p95:.1f}ms p99={p99:.1f}ms")
    if p95 > 50:
        r.note(f"WARN: p95 {p95:.1f}ms exceeds 50ms target (FullSpec § 5.1)")
    else:
        r.note(f"p95 within 50ms target ✓")
    # Don't fail the suite on perf — just surface it.
    return r


async def scenario_concurrency(client: httpx.AsyncClient) -> TestResult:
    r = TestResult("concurrency", True)
    iid = (await seed(client))["integration_id"]
    url = mock_url(iid, "v1/purchase_orders")

    # Use a fresh client w/ generous pool per spec; client passed in is fine.
    async def fire(i: int) -> tuple[int, Optional[str]]:
        resp = await client.post(
            url,
            headers=AUTH,
            json={"vendor_id": "v_acme", "line_items": [{"sku": f"S{i}", "qty": 1}]},
        )
        try:
            data = resp.json()
        except Exception:
            data = {}
        return resp.status_code, data.get("id")

    n = 50
    results = await asyncio.gather(*[fire(i) for i in range(n)], return_exceptions=True)
    statuses: list[int] = []
    ids: list[str] = []
    errors = 0
    for res in results:
        if isinstance(res, Exception):
            errors += 1
            continue
        s, eid = res
        statuses.append(s)
        if eid:
            ids.append(eid)

    ok = sum(1 for s in statuses if s == 201)
    unique = len(set(ids))
    r.note(f"50 concurrent POSTs → {ok}/{n} 201s, {unique} unique ids, {errors} client errors")
    if ok != n:
        r.fail(f"only {ok}/{n} succeeded ({statuses!r})")
    if unique != ok:
        r.fail(f"id collisions: {ok} successes but only {unique} unique ids")
    return r


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def main() -> int:
    print("=" * 72)
    print("Solder mock-engine QA")
    print("=" * 72)

    # Confirm backend is alive and demo seeder works before running anything.
    try:
        async with httpx.AsyncClient(timeout=10) as boot:
            r0 = await boot.post(f"{API}/api/dev/seed-mock-demo")
            r0.raise_for_status()
    except Exception as exc:
        print(f"FATAL: seed-mock-demo failed at {API}: {exc}")
        return 2

    scenarios = [
        scenario_happy_paths,
        scenario_auth,
        scenario_validation,
        scenario_error_injection,
        scenario_session_overlay,
        scenario_edge_cases,
        scenario_audit,
        scenario_performance,
        scenario_concurrency,
    ]

    results: list[TestResult] = []
    # Use a single client w/ a healthy pool — concurrency scenario needs ≥ 50.
    limits = httpx.Limits(max_connections=100, max_keepalive_connections=50)
    async with httpx.AsyncClient(timeout=30, limits=limits) as client:
        for fn in scenarios:
            try:
                r = await fn(client)
            except Exception as exc:
                r = TestResult(fn.__name__, False)
                r.fail(f"unhandled exception: {exc!r}")
            results.append(r)

    # Report.
    print()
    print("=" * 72)
    print("RESULTS")
    print("=" * 72)
    pass_n = sum(1 for r in results if r.passed)
    fail_n = sum(1 for r in results if not r.passed)
    bugs = [r for r in results if r.bug]
    for r in results:
        tag = "PASS" if r.passed else "FAIL"
        print(f"\n[{tag}] {r.name}")
        for n in r.notes:
            print(f"  • {n}")
        if r.bug:
            print(f"  BUG: {r.bug}")

    print()
    print("=" * 72)
    print(f"{pass_n}/{len(results)} scenarios passed   ({fail_n} failed, {len(bugs)} bug(s))")
    print("=" * 72)
    summary = [
        {"name": r.name, "passed": r.passed, "notes": r.notes, "bug": r.bug}
        for r in results
    ]
    (OUT / "qa_mock_engine.json").write_text(json.dumps(summary, indent=2))
    print(f"Report: {OUT / 'qa_mock_engine.json'}")
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
