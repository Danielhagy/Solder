"""
Build a response payload from a route's `responder` block + the test bank +
the session overlay.

Responder types (v1):
- `list_entities`   — paginated list. Reads bank entities of `entity_type`,
                      applies session overlay, paginates, returns the
                      connector-shaped envelope (e.g. `{"data": [...]}` for
                      Zip, configurable per spec).
- `get_entity`      — single entity by `id`. Bank + overlay; 404 if not
                      found (after overlay tombstones applied).
- `create_entity`   — writes a new entity to the session (NOT the bank);
                      generates an id via `id_generator` if not supplied.

Pagination uses simple `offset` / `limit` query parameters in v1; the
connector-aware token/cursor styles described in `http.request`'s
pagination config are a v2 concern (mock-engine doesn't need them yet to
exercise integrations end-to-end).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MockSession, TestBankEntity

from .session_manager import (
    merge_overlay,
    record_write,
    session_writes,
)


@dataclass
class GeneratedResponse:
    status: int
    body: Any


async def generate(
    db: AsyncSession,
    *,
    test_bank_id: str,
    session: MockSession,
    responder: Mapping[str, Any],
    method: str,
    path_params: Mapping[str, str],
    query: Mapping[str, str],
    body: Optional[Mapping[str, Any]],
    connector_name: str,
) -> GeneratedResponse:
    """Dispatch on `responder.type` and produce a response."""
    rtype = responder.get("type")
    if rtype == "list_entities":
        return await _list_entities(
            db,
            test_bank_id=test_bank_id,
            connector_name=connector_name,
            session=session,
            responder=responder,
            query=query,
        )
    if rtype == "get_entity":
        return await _get_entity(
            db,
            test_bank_id=test_bank_id,
            connector_name=connector_name,
            session=session,
            responder=responder,
            path_params=path_params,
        )
    if rtype == "create_entity":
        return await _create_entity(
            db,
            session=session,
            responder=responder,
            body=body,
            connector_name=connector_name,
        )
    return GeneratedResponse(
        status=501,
        body={"error": {"code": "NOT_IMPLEMENTED", "message": f"responder type {rtype!r} not in v1"}},
    )


async def _list_entities(
    db: AsyncSession,
    *,
    test_bank_id: str,
    connector_name: str,
    session: MockSession,
    responder: Mapping[str, Any],
    query: Mapping[str, str],
) -> GeneratedResponse:
    entity_type = str(responder["entity_type"])
    page_size = int(responder.get("page_size_default", 25))
    try:
        limit = max(1, min(int(query.get("limit", page_size)), 200))
    except (TypeError, ValueError):
        limit = page_size
    try:
        offset = max(0, int(query.get("offset", 0)))
    except (TypeError, ValueError):
        offset = 0

    bank_rows = await _bank_entities(db, test_bank_id, entity_type)
    overlay = await session_writes(
        db,
        mock_session_id=session.id,
        connector_name=connector_name,
        entity_type=entity_type,
    )
    merged = merge_overlay(bank_rows, overlay)

    total = len(merged)
    page = merged[offset : offset + limit]
    envelope = {
        "data": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + limit < total,
    }
    return GeneratedResponse(status=200, body=envelope)


async def _get_entity(
    db: AsyncSession,
    *,
    test_bank_id: str,
    connector_name: str,
    session: MockSession,
    responder: Mapping[str, Any],
    path_params: Mapping[str, str],
) -> GeneratedResponse:
    entity_type = str(responder["entity_type"])
    id_param = str(responder.get("id_param", "id"))
    eid = path_params.get(id_param)
    if not eid:
        return GeneratedResponse(
            status=400,
            body={"error": {"code": "BAD_REQUEST", "message": f"missing path param: {id_param}"}},
        )
    bank_rows = await _bank_entities(db, test_bank_id, entity_type)
    overlay = await session_writes(
        db,
        mock_session_id=session.id,
        connector_name=connector_name,
        entity_type=entity_type,
    )
    merged = merge_overlay(bank_rows, overlay)
    for ent in merged:
        if str(ent.get("id") or ent.get("entity_id") or "") == eid:
            return GeneratedResponse(status=200, body=ent)
    return GeneratedResponse(
        status=404,
        body={
            "error": {
                "code": "NOT_FOUND",
                "message": f"{entity_type} with id {eid!r} not found",
            }
        },
    )


async def _create_entity(
    db: AsyncSession,
    *,
    session: MockSession,
    responder: Mapping[str, Any],
    body: Optional[Mapping[str, Any]],
    connector_name: str,
) -> GeneratedResponse:
    entity_type = str(responder["entity_type"])
    required = list(responder.get("required_fields") or [])
    if not isinstance(body, Mapping):
        return GeneratedResponse(
            status=400,
            body={"error": {"code": "BAD_REQUEST", "message": "body must be a JSON object"}},
        )
    for field in required:
        if field not in body or body[field] in (None, "", []):
            return GeneratedResponse(
                status=422,
                body={
                    "error": {
                        "code": "VALIDATION_ERROR",
                        "message": f"Missing required field: {field}",
                        "field": field,
                    }
                },
            )
    # `body.get("id") or generate` would silently swallow falsy ids ("", 0,
    # false) and return a different id than the caller posted, so a
    # subsequent GET would 404. Generate only when the key is genuinely
    # absent; treat anything the caller provided as authoritative.
    if "id" in body:
        eid = str(body["id"])
    else:
        eid = _generate_id(responder.get("id_generator"))
    record = dict(body)
    record["id"] = eid
    await record_write(
        db,
        mock_session_id=session.id,
        connector_name=connector_name,
        entity_type=entity_type,
        entity_id=eid,
        operation="create",
        data=record,
    )
    return GeneratedResponse(status=201, body=record)


def _generate_id(spec: Optional[str]) -> str:
    """`po_{ulid}` style — emit `<prefix>_<random>` with a 16-char suffix."""
    suffix = secrets.token_urlsafe(12).rstrip("=")[:16]
    if not spec:
        return suffix
    if "{ulid}" in spec:
        return spec.replace("{ulid}", suffix)
    return f"{spec}_{suffix}" if not spec.endswith("_") else f"{spec}{suffix}"


async def _bank_entities(
    db: AsyncSession, test_bank_id: str, entity_type: str
) -> Sequence[dict[str, Any]]:
    stmt = select(TestBankEntity).where(
        TestBankEntity.test_bank_id == test_bank_id,
        TestBankEntity.entity_type == entity_type,
    )
    rows = list((await db.execute(stmt)).scalars().all())
    return [dict(r.data or {}, id=r.entity_id) for r in rows]
