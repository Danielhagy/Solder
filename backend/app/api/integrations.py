from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Integration, IntegrationVersion
from app.schemas import (
    IntegrationCreate,
    IntegrationResponse,
    IntegrationUpdate,
    IntegrationVersionResponse,
)
from app.services.version_diff import describe_changes

router = APIRouter()


# -- helpers -----------------------------------------------------------------


def _snapshot_payload(integration: Integration) -> dict:
    """Extract the diff-relevant payload from an integration row."""
    return {
        "name": integration.name,
        "description": integration.description,
        "config": integration.config or {},
        "trigger": integration.trigger or {},
        "is_library": bool(integration.is_library),
    }


def _version_payload(version: IntegrationVersion) -> dict:
    return {
        "name": version.name,
        "description": version.description,
        "config": version.config or {},
        "trigger": version.trigger or {},
        "is_library": bool(version.is_library),
    }


async def _latest_version(
    db: AsyncSession, integration_id: str
) -> Optional[IntegrationVersion]:
    result = await db.execute(
        select(IntegrationVersion)
        .where(IntegrationVersion.integration_id == integration_id)
        .order_by(IntegrationVersion.version_number.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _next_version_number(db: AsyncSession, integration_id: str) -> int:
    result = await db.execute(
        select(func.max(IntegrationVersion.version_number)).where(
            IntegrationVersion.integration_id == integration_id
        )
    )
    current = result.scalar_one_or_none()
    return (current or 0) + 1


async def _snapshot_integration(
    db: AsyncSession,
    integration: Integration,
    *,
    force_summary: Optional[str] = None,
) -> Optional[IntegrationVersion]:
    """Create an IntegrationVersion row capturing the current state.

    Returns the new version, or ``None`` if nothing effectively changed since
    the last version (so PATCH with no-op bodies doesn't spam history).
    Pass ``force_summary`` to override auto-generated text (used by restore).
    """
    prior = await _latest_version(db, integration.id)
    curr_payload = _snapshot_payload(integration)

    if force_summary is not None:
        summary = force_summary
    else:
        prev_payload = _version_payload(prior) if prior is not None else None
        summary = describe_changes(prev_payload, curr_payload)
        if summary == "No changes." and prior is not None:
            return None

    version = IntegrationVersion(
        integration_id=integration.id,
        version_number=await _next_version_number(db, integration.id),
        name=integration.name,
        description=integration.description,
        config=integration.config or {},
        trigger=integration.trigger or {"type": "manual"},
        is_library=bool(integration.is_library),
        change_summary=summary,
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)
    return version


# -- integration CRUD --------------------------------------------------------


@router.get("", response_model=List[IntegrationResponse])
async def list_integrations(
    skip: int = 0, limit: int = 100, db: AsyncSession = Depends(get_db)
):
    """List all integrations."""
    result = await db.execute(
        select(Integration).offset(skip).limit(limit).order_by(Integration.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=IntegrationResponse, status_code=201)
async def create_integration(
    integration: IntegrationCreate, db: AsyncSession = Depends(get_db)
):
    """Create a new integration.

    Also snapshots the newly-created state as version 1 (``"Initial save."``).
    """
    # exclude_none preserves the SQLAlchemy column defaults (trigger, status,
    # is_library) when the client didn't supply the field — otherwise Pydantic
    # surfaces explicit `None` and overrides the defaults.
    db_integration = Integration(**integration.model_dump(exclude_none=True))
    db.add(db_integration)
    await db.commit()
    await db.refresh(db_integration)

    # First snapshot. `prev` is None so describe_changes returns "Initial save.".
    await _snapshot_integration(db, db_integration)
    await db.refresh(db_integration)
    return db_integration


@router.get("/{integration_id}", response_model=IntegrationResponse)
async def get_integration(integration_id: str, db: AsyncSession = Depends(get_db)):
    """Get an integration by ID."""
    result = await db.execute(
        select(Integration).where(Integration.id == integration_id)
    )
    integration = result.scalar_one_or_none()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")
    return integration


@router.patch("/{integration_id}", response_model=IntegrationResponse)
async def update_integration(
    integration_id: str,
    integration_update: IntegrationUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update an integration.

    Snapshots post-commit if the update produced an effective change (the diff
    helper returning ``"No changes."`` suppresses the snapshot to keep the
    history feed clean).
    """
    result = await db.execute(
        select(Integration).where(Integration.id == integration_id)
    )
    integration = result.scalar_one_or_none()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")

    update_data = integration_update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(integration, field, value)

    await db.commit()
    await db.refresh(integration)

    await _snapshot_integration(db, integration)
    await db.refresh(integration)
    return integration


@router.delete("/{integration_id}", status_code=204)
async def delete_integration(integration_id: str, db: AsyncSession = Depends(get_db)):
    """Delete an integration.

    Soft-delete: flips is_active=False and status="disabled" rather than issuing
    an actual SQL DELETE. Run.integration_id is a non-nullable FK, so hard
    deleting would 500 as soon as any run history exists. The UI still shows
    "Delete" — this is an internal implementation detail. List endpoint
    behaviour is unchanged (rows remain returned) until/unless a caller wants
    to add an is_active filter.
    """
    result = await db.execute(
        select(Integration).where(Integration.id == integration_id)
    )
    integration = result.scalar_one_or_none()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")

    integration.is_active = False
    integration.status = "disabled"
    await db.commit()


# -- versions ----------------------------------------------------------------


@router.get(
    "/{integration_id}/versions",
    response_model=List[IntegrationVersionResponse],
)
async def list_integration_versions(
    integration_id: str,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    """List snapshots for an integration, newest first."""
    # 404 if the integration itself is unknown — cleaner than returning [].
    existing = await db.execute(
        select(Integration.id).where(Integration.id == integration_id)
    )
    if existing.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Integration not found")

    result = await db.execute(
        select(IntegrationVersion)
        .where(IntegrationVersion.integration_id == integration_id)
        .order_by(IntegrationVersion.version_number.desc())
        .offset(skip)
        .limit(limit)
    )
    return result.scalars().all()


@router.get(
    "/{integration_id}/versions/{version_number}",
    response_model=IntegrationVersionResponse,
)
async def get_integration_version(
    integration_id: str,
    version_number: int,
    db: AsyncSession = Depends(get_db),
):
    """Get a specific version by its 1-indexed version number."""
    result = await db.execute(
        select(IntegrationVersion).where(
            IntegrationVersion.integration_id == integration_id,
            IntegrationVersion.version_number == version_number,
        )
    )
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


@router.post(
    "/{integration_id}/versions/{version_number}/restore",
    response_model=IntegrationResponse,
)
async def restore_integration_version(
    integration_id: str,
    version_number: int,
    db: AsyncSession = Depends(get_db),
):
    """Overwrite the integration with a prior version's snapshot.

    Creates a new version on top (not a revert of history) tagged
    ``"Restored from v<n>"`` so the restore itself is auditable.
    """
    integration_result = await db.execute(
        select(Integration).where(Integration.id == integration_id)
    )
    integration = integration_result.scalar_one_or_none()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")

    version_result = await db.execute(
        select(IntegrationVersion).where(
            IntegrationVersion.integration_id == integration_id,
            IntegrationVersion.version_number == version_number,
        )
    )
    version = version_result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    integration.name = version.name
    integration.description = version.description
    integration.config = version.config or {}
    integration.trigger = version.trigger or {"type": "manual"}
    integration.is_library = bool(version.is_library)

    await db.commit()
    await db.refresh(integration)

    # Always snapshot a restore — even if the state matches the latest, we
    # want the event recorded. force_summary bypasses the No-changes suppression.
    await _snapshot_integration(
        db, integration, force_summary=f"Restored from v{version_number}."
    )
    await db.refresh(integration)
    return integration
