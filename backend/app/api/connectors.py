"""
Connectors API — read-only list of supported connectors.

Connectors are static code definitions (subclasses of `BaseConnector`)
plus a DB row carrying the id we hand out as a foreign key. Adding a new
connector is a code change, not a DB change, so this endpoint is
deliberately simple: list what's in the registry, joined to whatever rows
exist in `connectors`. The IntegrationCreate flow's modal reads from
this to populate its connector picker.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors import REGISTRY
from app.database import get_db
from app.models import Connector
from app.schemas import ConnectorOut, DiscoverableEndpoint

router = APIRouter()


@router.get("", response_model=list[ConnectorOut])
async def list_connectors(db: AsyncSession = Depends(get_db)) -> list[ConnectorOut]:
    """Return one entry per registered connector, joined to the DB row."""
    rows = list((await db.execute(select(Connector))).scalars().all())
    by_name = {row.name: row for row in rows}
    out: list[ConnectorOut] = []
    for name, conn in REGISTRY.items():
        row = by_name.get(name)
        if row is None:
            # Connector class registered but DB row missing — this happens
            # before the seeder runs. Skip; the create flow won't be able
            # to bind a credential to a connector that has no id yet.
            continue
        out.append(
            ConnectorOut(
                id=row.id,
                name=conn.name,
                display_name=conn.display_name,
                auth_scheme=conn.auth_scheme,
                base_url=conn.base_url,
                brand_domain=conn.brand_domain,
                description=row.description,
                discoverable_endpoints=[
                    DiscoverableEndpoint(**d) for d in conn.discoverable_endpoints()
                ],
                metadata_json=row.metadata_json or {},
            )
        )
    return out
