from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class RunStatus(str, Enum):
    """Status of an integration run."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Integration(Base, TimestampMixin):
    """Integration definition with workflow configuration."""

    __tablename__ = "integrations"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    is_active: Mapped[bool] = mapped_column(default=True)
    # Draft (unshipped), active (ready to run), disabled (temporarily off).
    # Orthogonal to is_active — is_active drives whether triggers fire.
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="draft", default="draft"
    )
    # Trigger config — discriminated on `type`: manual|webhook|schedule|on_event
    trigger: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{\"type\":\"manual\"}'::jsonb"),
        default=lambda: {"type": "manual"},
    )
    # True for reusable subprocesses callable from other integrations via
    # `process.call`. Library integrations are not directly triggered from
    # the outside world; they run as inlined bodies inside a parent run.
    is_library: Mapped[bool] = mapped_column(
        default=False, server_default="false", nullable=False
    )

    # ── v1 mock-engine + connector wiring (Slice 2.5) ──
    #
    # Connections are bound via the `integration_connections` join table
    # (N per integration, alias-keyed). The pre-2.5 binary
    # source/target connector + credential FKs were dropped in
    # favour of that model — direction is read off canvas wiring, not
    # the schema.
    # 'sandbox' (mock-engine) | 'production' (real APIs). Defaults to sandbox
    # so a fresh integration is always safe to run.
    environment: Mapped[str] = mapped_column(
        String(16), nullable=False, default="sandbox", server_default=text("'sandbox'")
    )
    # Captured during intent-capture (agent phase 3, spec § 7.3). Free-form
    # human-readable summary the AI restates to the user. Empty until phase 3
    # runs.
    intent_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # 'pending' | 'running' | 'complete' | 'failed'. Drives the IntegrationCreate
    # flow's progress display.
    discovery_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default=text("'pending'")
    )
    # Optional pointer to the latest mock spec. The pre-2.5
    # `source_test_bank_id` / `target_test_bank_id` columns were dropped in
    # Slice 2.5 — banks are walked from `integration_connections` instead.
    mock_spec_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("mock_specs.id"), nullable=True
    )
    # Next scheduled fire time for `trigger.type == 'schedule'` integrations.
    # The polling executor (Phase 2) reads this; Phase 1 emits it via the
    # diagram compiler so the data is captured even though nothing reads it.
    next_run_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None, index=True
    )
    # Soft-delete marker. Set by the DELETE handler; null on live rows. The
    # purge cron (app/services/purge_deleted.py) hard-deletes any row whose
    # `deleted_at` is older than 30 days AND has no Run rows referencing it
    # (the Run.integration_id FK is non-nullable, so cascading would orphan
    # run history). Frontend can render "deleted X days ago" off this column.
    deleted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    # Relationships
    runs: Mapped[list["Run"]] = relationship(back_populates="integration")
    openapi_specs: Mapped[list["OpenAPISpec"]] = relationship(
        back_populates="integration"
    )


class OpenAPISpec(Base, TimestampMixin):
    """Cached OpenAPI documentation."""

    __tablename__ = "openapi_specs"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    version: Mapped[str] = mapped_column(String(50), nullable=False, default="3.0.0")
    spec_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    parsed_markdown: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    integration_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("integrations.id"), nullable=True
    )
    # Pre-resolved per-entity schemas + create/list paths, populated by
    # `services/entity_resolver.py` (called from `openapi_ingest` on save).
    # Shape:
    #   { "<entity_type>": {
    #       "jsonSchema": {<deref'd JSON Schema>},
    #       "samplePath": "/developer/v1/purchase-orders",
    #       "createPath": "/developer/v1/purchase-orders",
    #       "enums": {"<field_path>": ["VAL1","VAL2"]},
    #       "formats": {"<field_path>": "date-time"},
    #       "required": ["id", "vendor_id", ...],
    #       "refs": {"<field_path>": "<entity_type>"}
    #     }, ... }
    # Avoids resolving $refs on every editor click; drives the diagram
    # editor's object pickers + the AI mapper's nested-schema prompts.
    entity_schemas: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    # Relationships
    integration: Mapped[Optional["Integration"]] = relationship(
        back_populates="openapi_specs"
    )


class Run(Base, TimestampMixin):
    """Execution history of integrations."""

    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    integration_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("integrations.id"), nullable=False
    )
    status: Mapped[RunStatus] = mapped_column(
        String(50), nullable=False, default=RunStatus.PENDING
    )
    input_data: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    output_data: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    steps: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    temporal_workflow_id: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )
    # How this run was initiated — manual|webhook|schedule|on_event. Null for
    # rows created before the trigger feature landed.
    trigger_source: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    # Relationships
    integration: Mapped["Integration"] = relationship(back_populates="runs")


class IntegrationVersion(Base, TimestampMixin):
    """One frozen snapshot of an integration's state at save-time.

    Created automatically by the integrations API on every effective
    create/update. Supports listing history and restoring prior snapshots.

    Table is created via ``Base.metadata.create_all()`` at app startup — no
    manual migration needed for this new table on a fresh DB. Deployments with
    an existing schema need to run ``create_all`` once after pulling this
    change (the app already does this in ``main.py``'s startup hook).
    """

    __tablename__ = "integration_versions"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    integration_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("integrations.id"),
        nullable=False,
        index=True,
    )
    # 1-indexed per integration. Monotonically increasing; no reuse on delete.
    version_number: Mapped[int] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    trigger: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=lambda: {"type": "manual"}
    )
    is_library: Mapped[bool] = mapped_column(default=False, nullable=False)
    # Human-readable, auto-generated summary of what changed vs the previous
    # version. Empty string for version 1 (initial save) is not used — we emit
    # "Initial save." so the UI always has a caption to render.
    change_summary: Mapped[str] = mapped_column(Text, nullable=False, default="")


class AILearning(Base, TimestampMixin):
    """AI agent learnings from test results for recursive improvement."""

    __tablename__ = "ai_learnings"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    run_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("runs.id"), nullable=True
    )
    integration_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("integrations.id"), nullable=True
    )
    pattern_type: Mapped[str] = mapped_column(
        String(100), nullable=False
    )  # e.g., "error_resolution", "optimization"
    context: Mapped[dict] = mapped_column(JSONB, nullable=False)
    insight: Mapped[str] = mapped_column(Text, nullable=False)
    success_rate: Mapped[float] = mapped_column(default=0.0)
    usage_count: Mapped[int] = mapped_column(default=0)
