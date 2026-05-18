"""
ProcessDiagram CRUD + Generate / Gap-finder / Suggest-mappings.

Phase 1 surface for the workflow-builder editor. The four AI-adjacent
endpoints (`/generate`, `/gap-finder`, `/edges/{edge_id}/suggest-mappings`)
delegate to services that land in Step 3 — until then they return 501 so
the wiring is testable from the start.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ProcessDiagram
from app.schemas import (
    GapFinderResponse,
    GenerateRequest,
    GenerateResponse,
    ProcessDiagramCreate,
    ProcessDiagramOut,
    ProcessDiagramUpdate,
    SuggestMappingsRequest,
    SuggestMappingsResponse,
)

router = APIRouter()


# ── CRUD ────────────────────────────────────────────────────────────────


@router.get("", response_model=list[ProcessDiagramOut])
async def list_diagrams(
    include_deleted: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """List all diagrams. Soft-deleted rows hidden by default."""
    q = select(ProcessDiagram).order_by(ProcessDiagram.created_at.desc())
    if not include_deleted:
        q = q.where(ProcessDiagram.deleted_at.is_(None))
    result = await db.execute(q)
    return result.scalars().all()


@router.post("", response_model=ProcessDiagramOut, status_code=status.HTTP_201_CREATED)
async def create_diagram(
    payload: ProcessDiagramCreate, db: AsyncSession = Depends(get_db)
):
    """Create a new diagram. Editor calls this on first-stroke autosave."""
    row = ProcessDiagram(
        name=payload.name,
        description=payload.description,
        document=payload.document or {},
        integration_id=payload.integration_id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/{diagram_id}", response_model=ProcessDiagramOut)
async def get_diagram(diagram_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(ProcessDiagram, diagram_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"diagram {diagram_id!r} not found")
    return row


@router.patch("/{diagram_id}", response_model=ProcessDiagramOut)
async def update_diagram(
    diagram_id: str,
    payload: ProcessDiagramUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Autosave path. Editor PATCHes the full `document` every ~2 seconds."""
    row = await db.get(ProcessDiagram, diagram_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"diagram {diagram_id!r} not found")
    if payload.name is not None:
        row.name = payload.name
    if payload.description is not None:
        row.description = payload.description
    if payload.document is not None:
        row.document = payload.document
    if payload.integration_id is not None:
        row.integration_id = payload.integration_id
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/{diagram_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_diagram(diagram_id: str, db: AsyncSession = Depends(get_db)):
    """Soft-delete — sets deleted_at; the purge cron hard-deletes after 30 days."""
    from datetime import datetime, timezone

    row = await db.get(ProcessDiagram, diagram_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"diagram {diagram_id!r} not found")
    row.deleted_at = datetime.now(tz=timezone.utc)
    await db.commit()


# ── Generate (compile diagram → Integration) ────────────────────────────


@router.post("/{diagram_id}/generate", response_model=GenerateResponse)
async def generate_integration(
    diagram_id: str,
    payload: GenerateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Compile the diagram into a runnable Integration. Returns the
    Integration id + node count + any validation warnings.

    Step 3 wires `services.diagram_compiler.compile_diagram` here.
    """
    row = await db.get(ProcessDiagram, diagram_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"diagram {diagram_id!r} not found")
    try:
        from app.services.diagram_compiler import compile_and_persist
    except ImportError:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "diagram compiler not yet wired (Step 3 of process-diagram build)",
        )
    return await compile_and_persist(
        db=db,
        diagram=row,
        target_integration_id=payload.target_integration_id,
        force=payload.force,
    )


# ── AI Gap-finder (Haiku) ──────────────────────────────────────────────


@router.post("/{diagram_id}/gap-finder", response_model=GapFinderResponse)
async def gap_finder(
    diagram_id: str,
    demo_replay: bool = False,
    regenerate: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Run the AI gap-finder against the diagram's serialized scenario.

    Source priority (per plan):
      1. `?demo_replay=1` AND `document.gapFinderCache` present → cache
      2. `document.gapFinderCache` present AND not `regenerate=1` → cache
      3. Live Haiku call (Step 3 wires this)
      4. FALLBACK_QUESTIONS hardcoded list
    """
    row = await db.get(ProcessDiagram, diagram_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"diagram {diagram_id!r} not found")

    cached = (row.document or {}).get("gapFinderCache")
    if cached and (demo_replay or not regenerate):
        return GapFinderResponse(
            questions=cached.get("questions", []),
            cached=True,
            source="cache",
        )

    try:
        from app.services.ai_gap_finder import suggest_questions
    except ImportError:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "ai_gap_finder not yet wired (Step 3 of process-diagram build)",
        )
    return await suggest_questions(row.document)


# ── AI Mapper (Sonnet) — per-edge field mapping suggestions ────────────


@router.post(
    "/{diagram_id}/edges/{edge_id}/suggest-mappings",
    response_model=SuggestMappingsResponse,
)
async def suggest_mappings(
    diagram_id: str,
    edge_id: str,
    payload: SuggestMappingsRequest,
    demo_replay: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Per-edge AI mapping suggestion. Server-side cache lives in
    `document.aiMappingCache[edge_id]` so cached responses survive
    incognito / Chrome update.
    """
    row = await db.get(ProcessDiagram, diagram_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"diagram {diagram_id!r} not found")

    cache_map = (row.document or {}).get("aiMappingCache") or {}
    cached = cache_map.get(edge_id)
    if cached and demo_replay:
        return SuggestMappingsResponse(
            mappings=cached.get("mappings", []),
            cached=True,
            source="cache",
        )

    try:
        from app.services.ai_mapper import suggest_for_edge
    except ImportError:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "ai_mapper not yet wired (Step 3 of process-diagram build)",
        )
    return await suggest_for_edge(
        db=db,
        diagram=row,
        edge_id=edge_id,
        source_object_id=payload.source_object_id,
        target_object_id=payload.target_object_id,
        edge_action=payload.edge_action,
        extra_context=payload.extra_context,
    )
