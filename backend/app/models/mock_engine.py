"""
Mock-engine models — mock spec, run-time session state, run audit log.

Spec references: §§ 5.1, 5.3, 5.4, 6.3, 6.4, 6.5.

Design notes:
- `MockSpec` is the source of truth for mock-engine behaviour. Per spec § 11
  ("Conventions"), mock spec is *versioned and additive*: every authored entry
  carries provenance via `generated_by` so future agent enrichment can layer
  on top without rewriting earlier work.
- `MockSession` + `MockSessionWrite` form the writable overlay over the
  read-mostly test bank (§ 5.3). Every POST/PUT/DELETE through the mock
  engine becomes a `MockSessionWrite` row; reads merge bank + session
  with session winning on conflicts.
- `RunAuditEvent` captures every request and response that touched the
  mock-engine for one run. Backs the run drawer's detailed view (§ 8.5)
  and is the user's primary debugging surface.
"""

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class MockSpec(Base, TimestampMixin):
    """One mock spec per (integration, side)."""

    __tablename__ = "mock_specs"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    integration_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("integrations.id"), nullable=False, index=True
    )
    # Connector name ("zip", "hubspot"). One spec per (integration,
    # connector) — multiple connections to the same connector share it.
    api_name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    version: Mapped[int] = mapped_column(default=1, nullable=False)
    # See spec § 6.4 for shape: list of {path, method, responder, validators}.
    routes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Reusable validator definitions referenced by route entries.
    request_validators: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # Reusable responder definitions; routes reference these by name.
    response_generators: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # Empty in v1, scaffolded for the agent-curated rules layer described in
    # the North Star (spec § 10).
    business_rules: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # 'discovery' | 'agent_curated' | 'hand_authored'. Drives how the spec is
    # merged when later layers extend it.
    generated_by: Mapped[str] = mapped_column(
        String(32), nullable=False, default="discovery", server_default=text("'discovery'")
    )


class MockSession(Base, TimestampMixin):
    """One writable overlay over a test bank for one integration."""

    __tablename__ = "mock_sessions"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    integration_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("integrations.id"), nullable=False, index=True
    )
    # Run-scoped sessions tie to a single run and get cleaned up on completion;
    # persistent sessions survive across runs (user opt-in).
    run_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("runs.id"), nullable=True
    )
    scope: Mapped[str] = mapped_column(String(16), nullable=False, default="run")
    reset_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    writes: Mapped[list["MockSessionWrite"]] = relationship(back_populates="session")


class MockSessionWrite(Base, TimestampMixin):
    """One write into a mock session — the building block of session state."""

    __tablename__ = "mock_session_writes"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    mock_session_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("mock_sessions.id"), nullable=False
    )
    # Connector name ("zip", "hubspot") — namespace per service so a Zip
    # write doesn't bleed into HubSpot reads.
    connector_name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # 'create' | 'update' | 'delete'. Deletes are tombstones — `data` is null
    # but the row still wins over the test bank during reads.
    operation: Mapped[str] = mapped_column(String(16), nullable=False)
    data: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    session: Mapped["MockSession"] = relationship(back_populates="writes")

    __table_args__ = (
        Index(
            "ix_msw_session_connector_type_id",
            "mock_session_id",
            "connector_name",
            "entity_type",
            "entity_id",
        ),
    )


class RunAuditEvent(Base):
    """One request or response logged during a run."""

    __tablename__ = "run_audit_events"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    run_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("runs.id"), nullable=False, index=True
    )
    # Canvas node id that initiated the call. May be empty for system-generated
    # calls (e.g. discovery sampling).
    node_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # 'request' | 'response'.
    direction: Mapped[str] = mapped_column(String(16), nullable=False)
    # Connector this event hit ("zip", "hubspot").
    connector_name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    path: Mapped[str] = mapped_column(String(2048), nullable=False)
    headers: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    body: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    status: Mapped[Optional[int]] = mapped_column(nullable=True)
    # If the corpus injected an error, this holds the corpus entry's id so the
    # UI can link back to the explanation (spec § 8.6).
    error_injected: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column(nullable=True)
