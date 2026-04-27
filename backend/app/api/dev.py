"""
Developer-only endpoints. Mounted under `/api/dev` from `main.py`. Not
intended for production — these exist to make local smoke testing
reproducible (seed the mock-engine demo, reset its scratch session, etc).

Anything in here is fair game to hide behind an auth check or strip
entirely once the v1 ships. v1 is single-user local; we'll harden later.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services import seed_demo

router = APIRouter()


@router.post("/seed-mock-demo")
async def seed_mock_demo(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Seed the demo integration + Zip mock spec + test bank + connector rows.

    Idempotent: re-running wipes the bank entities and the scratch
    session, then re-inserts the canonical demo data. Returns the ids
    you'll need to hit `/api/mock/{integration_id}/source/...` and the
    `{name: id}` map for the registered connectors.
    """
    return await seed_demo.seed(db)
