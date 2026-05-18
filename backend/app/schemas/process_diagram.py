"""Pydantic schemas for the ProcessDiagram editor surface."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class ProcessDiagramCreate(BaseModel):
    """Create a new ProcessDiagram. `document` is the full diagram JSON
    (see `frontend/src/lib/process-diagram.ts` for the typed shape)."""

    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    document: dict = Field(default_factory=dict)
    # Optional pre-link to an existing Integration. The /generate
    # endpoint sets this for newly-compiled diagrams.
    integration_id: Optional[str] = None


class ProcessDiagramUpdate(BaseModel):
    """Partial update — autosave path. Only the supplied fields are touched."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    document: Optional[dict] = None
    integration_id: Optional[str] = None


class ProcessDiagramOut(BaseModel):
    id: str
    name: str
    description: Optional[str]
    document: dict
    integration_id: Optional[str]
    last_generated_at: Optional[datetime]
    last_generated_doc_hash: Optional[str]
    deleted_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class GenerateRequest(BaseModel):
    """POST /process-diagrams/{id}/generate body.

    `target_integration_id` lets the user re-generate over an existing
    Integration (drift-aware path). When null, a brand-new Integration
    is created and linked back to the diagram.
    """

    target_integration_id: Optional[str] = None
    # When True, overwrite even if the existing Integration has been
    # hand-edited since the last generate. Drives the GenerateModal's
    # "overwrite anyway" confirmation.
    force: bool = False


class GenerateResponse(BaseModel):
    """Returned by /generate."""

    integration_id: str
    nodes_count: int
    # Validation warnings — yellow UI flags in GenerateModal but never
    # block. Common shape: missing MockSpec routes, ambiguous mapping,
    # native flow detected.
    warnings: list[dict[str, Any]] = Field(default_factory=list)
    # The compiled IntegrationConfig.nodes preview — used by the modal
    # to render a read-only StagesGraph before the user confirms.
    preview_config: dict


class GapFinderResponse(BaseModel):
    """Returned by /gap-finder. Either cached (instant) or live (Haiku)."""

    questions: list[dict[str, str]]  # [{tag, q}, ...]
    cached: bool
    source: str  # 'cache' | 'live' | 'fallback'


class SuggestMappingsRequest(BaseModel):
    """POST /process-diagrams/{id}/edges/{edge_id}/suggest-mappings body.

    The client can override what the server otherwise derives from the
    diagram (e.g. to test alternative source/target objects without
    persisting the change to the document first).
    """

    source_object_id: Optional[str] = None
    target_object_id: Optional[str] = None
    edge_action: Optional[str] = None
    extra_context: Optional[str] = None


class SuggestMappingsResponse(BaseModel):
    """Returned by /suggest-mappings."""

    mappings: list[dict[str, Any]]  # see services/ai_mapper.MappingSuggestion
    cached: bool
    source: str  # 'cache' | 'live' | 'fallback'
