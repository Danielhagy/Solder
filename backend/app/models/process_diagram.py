"""
ProcessDiagram — the swimlane workflow document that the integration
consultant draws live on a discovery call.

The document is a self-contained JSONB blob (systems, objects, flows,
edges, lanes, mappings, AI caches) that the editor reads/writes whole.
A compile step (`services/diagram_compiler.py`) turns the document into
an `IntegrationConfig.nodes[]` graph, creates/updates an Integration row,
and links back via `integration_id`.

The 1:1 link is intentional: the diagram is the SOURCE, the Integration
is the OUTPUT. Keeping them in separate tables means:

  - Edits to the diagram never dirty an IntegrationVersion snapshot.
  - The compile step is a pure function — same doc + ctx → byte-identical
    IntegrationConfig — enabling drift detection if the user hand-edits
    the Integration in the Builder.

Versioning is deferred (see plan: ProcessDiagramVersion is Phase 2);
Phase 1 is a single mutable doc + autosave.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ProcessDiagram(Base, TimestampMixin):
    """One swimlane workflow document."""

    __tablename__ = "process_diagrams"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Full diagram payload — see `frontend/src/lib/process-diagram.ts`
    # `ProcessDiagramDoc` for the typed shape. Includes systems, objects,
    # flows, edges, triggers, sampleRun, plus UI state (lanePositions,
    # matchPos, askedQuestions) and AI caches (aiMappingCache,
    # gapFinderCache) so refresh restores pixel-perfect arrangement and
    # the demo fails-soft offline.
    document: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Bidirectional link to the most-recent Generate output. Nullable on
    # both sides — a diagram can exist before its first Generate, and an
    # Integration can exist without a diagram (the existing Builder path
    # is untouched).
    integration_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("integrations.id"),
        nullable=True,
        index=True,
    )
    # Drift detection vs hand-edited Integration. If the user runs the
    # Builder on the generated Integration and edits nodes, then later
    # clicks Re-Generate on the diagram, we compare `compile(doc).hash`
    # against `last_generated_doc_hash` — if different, warn before overwrite.
    last_generated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_generated_doc_hash: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )
    # Soft-delete (mirrors Integration.deleted_at). Hard-purged by the
    # same `purge_deleted` cron after 30 days.
    deleted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
