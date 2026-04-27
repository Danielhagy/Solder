"""
Session-state CRUD (FullSpec.md § 5.3).

A `MockSession` is the writable overlay over a read-only test bank. Every
write the mock-engine receives is recorded as a `MockSessionWrite` row;
reads merge bank entries with the latest write per (side, entity_type,
entity_id) — session wins on conflicts; tombstones hide the bank record.

Sessions are run-scoped by default (one per integration run, dropped on
completion). Persistent sessions survive across runs (FullSpec § 5.3 user
opt-in) and are NOT yet exposed by this MVP — they're a UI flag in v1.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MockSession, MockSessionWrite


async def get_or_create_session(
    db: AsyncSession,
    integration_id: str,
    run_id: Optional[str] = None,
    *,
    scope: Optional[str] = None,
) -> MockSession:
    """Resolve to a `MockSession` row, creating one when none exists.

    Scopes:
      - `'run'`         — tied to a real `Run.id` (passed as `run_id`).
                          Cleaned up when the run finishes.
      - `'scratch'`     — ephemeral session for dev / unauthenticated
                          mock traffic. `run_id` is null.
      - `'persistent'`  — survives across runs (user opt-in). `run_id`
                          is null. Only one per integration.

    `scope` defaults to `'run'` when `run_id` is provided, `'scratch'`
    otherwise. Callers can force `'persistent'` explicitly.
    """
    if scope is None:
        scope = "run" if run_id else "scratch"
    if scope == "run":
        if run_id is None:
            raise ValueError("run-scoped sessions require a run_id")
        stmt = select(MockSession).where(
            MockSession.integration_id == integration_id,
            MockSession.run_id == run_id,
            MockSession.scope == "run",
        )
    else:
        stmt = select(MockSession).where(
            MockSession.integration_id == integration_id,
            MockSession.run_id.is_(None),
            MockSession.scope == scope,
        )
    existing = (await db.execute(stmt)).scalar_one_or_none()
    if existing is not None:
        return existing
    session = MockSession(
        id=str(uuid4()),
        integration_id=integration_id,
        run_id=run_id if scope == "run" else None,
        scope=scope,
    )
    db.add(session)
    await db.flush()
    return session


async def record_write(
    db: AsyncSession,
    *,
    mock_session_id: str,
    connector_name: str,
    entity_type: str,
    entity_id: str,
    operation: str,
    data: Optional[dict[str, Any]],
) -> MockSessionWrite:
    """Append one write into a session.

    No collapsing of (create + update) into a single row — every write is
    its own audit record. `merge_overlay` reads in id-order and the latest
    write wins per (entity_type, entity_id), so create-then-update
    materialises correctly without us having to mutate prior rows.
    """
    write = MockSessionWrite(
        id=str(uuid4()),
        mock_session_id=mock_session_id,
        connector_name=connector_name,
        entity_type=entity_type,
        entity_id=entity_id,
        operation=operation,
        data=data,
    )
    db.add(write)
    await db.flush()
    return write


async def session_writes(
    db: AsyncSession,
    *,
    mock_session_id: str,
    connector_name: str,
    entity_type: str,
) -> list[MockSessionWrite]:
    """All writes for one (session, connector, entity_type), oldest first."""
    stmt = (
        select(MockSessionWrite)
        .where(
            MockSessionWrite.mock_session_id == mock_session_id,
            MockSessionWrite.connector_name == connector_name,
            MockSessionWrite.entity_type == entity_type,
        )
        .order_by(MockSessionWrite.created_at.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


def merge_overlay(
    bank_entities: Iterable[dict[str, Any]],
    writes: Iterable[MockSessionWrite],
) -> list[dict[str, Any]]:
    """Apply session writes on top of bank entities; return the merged set.

    Bank entities are passed as plain dicts (the responder reads them out
    of `TestBankEntity.data` keyed by `entity_id`). Writes win by latest;
    deletes are tombstones that drop the entity entirely from the result.
    """
    by_id: dict[str, Optional[dict[str, Any]]] = {}
    for be in bank_entities:
        eid = str(be.get("id") or be.get("entity_id") or "")
        if eid:
            by_id[eid] = be
    for w in writes:
        if w.operation == "delete":
            by_id[w.entity_id] = None
        elif w.operation in ("create", "update"):
            by_id[w.entity_id] = w.data or {}
    return [v for v in by_id.values() if v is not None]


async def reset(db: AsyncSession, mock_session_id: str) -> int:
    """Drop every write from a session. Returns the count of writes deleted."""
    stmt = select(MockSessionWrite).where(
        MockSessionWrite.mock_session_id == mock_session_id
    )
    rows = list((await db.execute(stmt)).scalars().all())
    for r in rows:
        await db.delete(r)
    return len(rows)
