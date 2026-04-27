"""
FastAPI router exposing the mock-engine on
`/api/mock/{integration_id}/{connector_name}/{path:path}` (FullSpec.md § 5.1).

Pipeline per request:
  1. Resolve integration → load mock spec for the connector (`spec_loader`)
  2. Match route → 404 if absent
  3. Validate request → 4xx if invalid (`request_validator`)
  4. Check error injection → corpus error if triggered (`error_injector`)
  5. Resolve response → bank + session overlay (`response_generator`)
  6. Audit → log to `run_audit_event`

Hot-path target: sub-50ms p95. No LLM calls. Reads are plain Postgres
queries against pre-generated rows.

Slice 2.5 simplified: route is keyed by **connector name** (`zip`,
`hubspot`). The intermediate `IntegrationConnection` alias indirection
is gone — connections are authored globally in `/connections`, and the
per-node editor's `connection_id` choice only matters for credential
selection at real-API time. The mock-engine doesn't decrypt secrets;
it only checks that *some* bearer token is present.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import (
    Integration,
    MockSession,
    RunAuditEvent,
    TestBank,
    TestBankEntity,
)

from . import error_injector, request_validator, response_generator, session_manager
from .spec_loader import extract_path_params, find_route, load_spec

router = APIRouter()


@router.api_route(
    "/{integration_id}/{connector_name}/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
)
async def mock_handler(
    integration_id: str,
    connector_name: str,
    path: str,
    request: Request,
) -> Response:
    started = perf_counter()
    method = request.method
    body = await _read_json_body(request)
    headers = {k: v for k, v in request.headers.items()}
    query = dict(request.query_params)

    async with async_session() as db:
        # 1. Resolve integration + spec.
        integration = await db.get(Integration, integration_id)
        if integration is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="integration not found")

        spec = await load_spec(db, integration_id, connector_name)
        if spec is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail=(
                    f"no mock spec for integration {integration_id} "
                    f"connector {connector_name!r}"
                ),
            )

        bank = await _load_bank(db, integration_id, connector_name)
        if bank is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail=(
                    f"no test bank for integration {integration_id} "
                    f"connector {connector_name!r}"
                ),
            )

        # 2. Match route.
        normalised_path = "/" + path
        route = find_route(spec, method, normalised_path)
        if route is None:
            return await _audit_and_respond(
                db,
                started=started,
                run_id=_resolve_run_id(headers),
                integration_id=integration_id,
                connector_name=connector_name,
                method=method,
                path=normalised_path,
                req_body=body,
                req_headers=headers,
                resp_status=404,
                resp_body={
                    "error": {
                        "code": "NOT_FOUND",
                        "message": f"{method} {normalised_path} is not in the mock spec",
                    }
                },
                error_injected=None,
            )

        path_template: str = route.get("path", normalised_path)
        path_params = extract_path_params(path_template, normalised_path)

        # 3. Validate request.
        v = request_validator.validate(
            validators=route.get("validators") or [],
            method=method,
            headers=headers,
            body=body,
        )
        if v is not None:
            return await _audit_and_respond(
                db,
                started=started,
                run_id=_resolve_run_id(headers),
                integration_id=integration_id,
                connector_name=connector_name,
                method=method,
                path=normalised_path,
                req_body=body,
                req_headers=headers,
                resp_status=v.status,
                resp_body={
                    "error": {
                        "code": v.error_id.split(".")[-1].upper(),
                        "message": v.message,
                        "field": v.field,
                    }
                },
                error_injected=v.error_id,
            )

        # 4. Error injection (corpus).
        chaos_mode = headers.get("x-solder-chaos", "").lower() in ("1", "true", "yes")
        bank_ids = await _bank_entity_ids(db, bank.id)
        injected = error_injector.maybe_inject(
            api_name=spec.api_name,
            method=method,
            path_template=path_template,
            body=body,
            headers=headers,
            bank_entity_ids=bank_ids,
            chaos_mode=chaos_mode,
        )
        if injected is not None:
            return await _audit_and_respond(
                db,
                started=started,
                run_id=_resolve_run_id(headers),
                integration_id=integration_id,
                connector_name=connector_name,
                method=method,
                path=normalised_path,
                req_body=body,
                req_headers=headers,
                resp_status=injected.status,
                resp_body=injected.body,
                error_injected=injected.error_id,
                extra_headers=injected.headers,
            )

        # 5. Response generator.
        session = await _resolve_session(
            db, integration_id=integration_id, run_id=_resolve_run_id(headers)
        )
        responder = route.get("responder") or {}
        gen = await response_generator.generate(
            db,
            test_bank_id=bank.id,
            session=session,
            responder=responder,
            method=method,
            path_params=path_params,
            query=query,
            body=body,
            connector_name=connector_name,
        )

        return await _audit_and_respond(
            db,
            started=started,
            run_id=_resolve_run_id(headers),
            integration_id=integration_id,
            connector_name=connector_name,
            method=method,
            path=normalised_path,
            req_body=body,
            req_headers=headers,
            resp_status=gen.status,
            resp_body=gen.body,
            error_injected=None,
        )


async def _read_json_body(request: Request) -> Optional[dict[str, Any]]:
    if request.method.upper() in ("GET", "HEAD", "DELETE"):
        return None
    raw = await request.body()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _resolve_run_id(headers: dict[str, str]) -> Optional[str]:
    """Mock-engine reads the active run from `X-Solder-Run-Id`. Absent ⇒
    no run-scoped session; the engine falls back to a synthetic
    "scratch" session keyed off the integration alone."""
    for k, v in headers.items():
        if k.lower() == "x-solder-run-id" and v:
            return v
    return None


async def _resolve_session(
    db: AsyncSession, *, integration_id: str, run_id: Optional[str]
) -> MockSession:
    """When a real run id is on the request, attach to that run's session;
    otherwise resolve to the integration's `scope='scratch'` session so
    repeated dev calls accumulate state predictably (and `reset()` is
    reachable from the UI)."""
    return await session_manager.get_or_create_session(
        db, integration_id=integration_id, run_id=run_id
    )


async def _load_bank(
    db: AsyncSession, integration_id: str, connector_name: str
) -> Optional[TestBank]:
    stmt = select(TestBank).where(
        TestBank.integration_id == integration_id,
        TestBank.api_name == connector_name,
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _bank_entity_ids(db: AsyncSession, test_bank_id: str) -> dict[str, set[str]]:
    """Pre-build `{entity_type: {ids…}}` for the error injector's
    `not_in_test_bank` predicate. One query, small result set."""
    stmt = select(TestBankEntity.entity_type, TestBankEntity.entity_id).where(
        TestBankEntity.test_bank_id == test_bank_id
    )
    rows = (await db.execute(stmt)).all()
    out: dict[str, set[str]] = {}
    for et, eid in rows:
        out.setdefault(et, set()).add(eid)
    return out


async def _audit_and_respond(
    db: AsyncSession,
    *,
    started: float,
    run_id: Optional[str],
    integration_id: str,
    connector_name: str,
    method: str,
    path: str,
    req_body: Optional[Any],
    req_headers: dict[str, str],
    resp_status: int,
    resp_body: Any,
    error_injected: Optional[str],
    extra_headers: Optional[dict[str, str]] = None,
) -> Response:
    """One roundtrip → two RunAuditEvent rows (request + response)."""
    duration_ms = int((perf_counter() - started) * 1000)
    if run_id:
        # Only persist audits when there's a real run id; scratch traffic
        # (no `X-Solder-Run-Id` header) would otherwise spam the table
        # during integration construction and bench testing.
        ts = datetime.now(tz=timezone.utc)
        db.add(
            RunAuditEvent(
                id=str(uuid4()),
                run_id=run_id,
                node_id=req_headers.get("x-solder-node-id"),
                timestamp=ts,
                direction="request",
                connector_name=connector_name,
                method=method,
                path=path,
                headers=_safe_headers(req_headers),
                body=req_body,
                status=None,
                error_injected=None,
                duration_ms=None,
            )
        )
        db.add(
            RunAuditEvent(
                id=str(uuid4()),
                run_id=run_id,
                node_id=req_headers.get("x-solder-node-id"),
                timestamp=ts,
                direction="response",
                connector_name=connector_name,
                method=method,
                path=path,
                headers=_safe_headers(extra_headers or {}),
                body=resp_body if isinstance(resp_body, (dict, list)) else None,
                status=resp_status,
                error_injected=error_injected,
                duration_ms=duration_ms,
            )
        )
    await db.commit()

    payload = json.dumps(resp_body, default=str).encode("utf-8")
    response = Response(
        content=payload,
        status_code=resp_status,
        media_type="application/json",
    )
    for hk, hv in (extra_headers or {}).items():
        response.headers[hk] = hv
    response.headers["X-Mock-Engine"] = "1"
    if error_injected:
        response.headers["X-Mock-Error-Id"] = error_injected
    return response


def _safe_headers(headers: dict[str, str]) -> dict[str, str]:
    """Strip auth from audit storage. We keep the rest verbatim — useful
    for debugging, no PII concern at this layer (PII only lives in the
    bank data, not the request envelope)."""
    out = {}
    for k, v in headers.items():
        if k.lower() == "authorization":
            out[k] = "<redacted>"
        else:
            out[k] = v
    return out
