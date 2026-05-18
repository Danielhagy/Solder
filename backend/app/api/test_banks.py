"""
TestBank read + synth + deep-reseed endpoints.

The diagram editor's ObjectPanel + the Sandboxes Records tab both ask
"give me 5 sample <entity_type> records from this connection's bank."
This module exposes that query (which didn't have a HTTP surface before
Phase 1) plus a thin synth wrapper and a deep-reseed admin endpoint.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import TestBank, TestBankEntity

router = APIRouter()


class BankEntityOut(BaseModel):
    id: str
    entity_type: str
    entity_id: Optional[str]
    data: dict
    is_golden: bool
    references: dict

    model_config = {"from_attributes": True}


class ListEntitiesResponse(BaseModel):
    entities: list[BankEntityOut]
    entity_type: Optional[str]
    total: int


@router.get(
    "/by-connection/{connection_id}/entities",
    response_model=ListEntitiesResponse,
)
async def list_bank_entities(
    connection_id: str,
    entity_type: Optional[str] = Query(default=None),
    limit: int = Query(default=5, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return up to `limit` TestBankEntity rows for a connection, optionally
    filtered to one entity_type. Golden rows first."""
    bank_row = (
        await db.execute(
            select(TestBank).where(TestBank.connection_id == connection_id)
        )
    ).scalar_one_or_none()
    if bank_row is None:
        return ListEntitiesResponse(entities=[], entity_type=entity_type, total=0)
    q = select(TestBankEntity).where(TestBankEntity.test_bank_id == bank_row.id)
    if entity_type:
        q = q.where(TestBankEntity.entity_type == entity_type)
    q = q.order_by(TestBankEntity.is_golden.desc()).limit(limit)
    rows = (await db.execute(q)).scalars().all()
    return ListEntitiesResponse(
        entities=[BankEntityOut.model_validate(r) for r in rows],
        entity_type=entity_type,
        total=len(rows),
    )


class SynthesizeRequest(BaseModel):
    entity_type: str = Field(..., min_length=1)
    count: int = Field(default=5, ge=1, le=50)
    variant: str = Field(default="full")


class SynthesizeResponse(BaseModel):
    created: int
    used_fallback: bool
    error: Optional[str] = None
    examples: list[dict] = Field(default_factory=list)


@router.post(
    "/by-connection/{connection_id}/entities/synthesize",
    response_model=SynthesizeResponse,
)
async def synthesize_bank_entities(
    connection_id: str,
    payload: SynthesizeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate N more synthetic records for an entity type and land them
    in the bank. Thin wrapper around `services.ai_synthesizer.synthesize_records`
    plus a persistence pass."""
    from uuid import uuid4

    from app.services.ai_synthesizer import synthesize_records

    bank_row = (
        await db.execute(
            select(TestBank).where(TestBank.connection_id == connection_id)
        )
    ).scalar_one_or_none()
    if bank_row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"no TestBank for connection {connection_id!r}",
        )

    schema = (bank_row.schema_json or {}).get(payload.entity_type) or {}
    result = synthesize_records(
        entity_type=payload.entity_type,
        schema=schema,
        count=payload.count,
        variant=payload.variant,
    )
    for record in result.records:
        entity_id = str(record.get("id") or uuid4())
        db.add(
            TestBankEntity(
                id=str(uuid4()),
                test_bank_id=bank_row.id,
                entity_type=payload.entity_type,
                entity_id=entity_id,
                data=record,
                is_golden=False,
                references={},
            )
        )
    await db.commit()
    return SynthesizeResponse(
        created=len(result.records),
        used_fallback=result.used_fallback,
        error=result.error,
        examples=result.records[:3],
    )


class DeepReseedResponse(BaseModel):
    entities_seeded: int
    examples_collected: int
    enums_extracted: int
    formats_extracted: int
    refs_resolved: int
    error_shapes_captured: int


@router.post(
    "/by-connection/{connection_id}/sandbox/deep-reseed",
    response_model=DeepReseedResponse,
)
async def deep_reseed(connection_id: str, db: AsyncSession = Depends(get_db)):
    """Wipe + re-populate the connection's TestBank using the deep-extraction
    loader (Step 2). Reads the bound OpenAPISpec, resolves all $refs, walks
    every nested schema, captures all examples (including from
    `components.schemas.<X>.example` where Ramp puts them), honours enums +
    formats + required, and threads cross-record refs.
    """
    try:
        from app.services.openapi_ingest import deep_reseed_connection
    except ImportError:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "deep_reseed_connection not yet wired (Step 2 of process-diagram build)",
        )
    return await deep_reseed_connection(db=db, connection_id=connection_id)
