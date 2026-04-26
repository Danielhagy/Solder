import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio.client import Client

from app.config import settings
from app.database import get_db
from app.models import Integration, Run
from app.models.integration import RunStatus
from app.schemas import RunCreate, RunResponse, RunUpdate
from app.temporal.workflows import IntegrationRunInput, IntegrationRunWorkflow

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("", response_model=List[RunResponse])
async def list_runs(
    integration_id: Optional[str] = None,
    status: Optional[RunStatus] = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    """List runs with optional filtering."""
    query = select(Run)

    if integration_id:
        query = query.where(Run.integration_id == integration_id)
    if status:
        query = query.where(Run.status == status)

    query = query.offset(skip).limit(limit).order_by(Run.created_at.desc())
    result = await db.execute(query)
    return result.scalars().all()


@router.post("", response_model=RunResponse, status_code=201)
async def create_run(run: RunCreate, db: AsyncSession = Depends(get_db)):
    """Create a new run for an integration."""
    # Verify integration exists
    result = await db.execute(
        select(Integration).where(Integration.id == run.integration_id)
    )
    integration = result.scalar_one_or_none()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")

    db_run = Run(
        integration_id=run.integration_id,
        input_data=run.input_data,
        status=RunStatus.PENDING,
        steps=[],
    )
    db.add(db_run)
    await db.commit()
    await db.refresh(db_run)
    return db_run


@router.get("/{run_id}", response_model=RunResponse)
async def get_run(run_id: str, db: AsyncSession = Depends(get_db)):
    """Get a run by ID."""
    result = await db.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.patch("/{run_id}", response_model=RunResponse)
async def update_run(
    run_id: str, run_update: RunUpdate, db: AsyncSession = Depends(get_db)
):
    """Update a run."""
    result = await db.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    update_data = run_update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(run, field, value)

    # Auto-set timestamps based on status
    if run_update.status == RunStatus.RUNNING and not run.started_at:
        run.started_at = datetime.utcnow()
    elif run_update.status in [RunStatus.SUCCESS, RunStatus.FAILED, RunStatus.CANCELLED]:
        run.completed_at = datetime.utcnow()

    await db.commit()
    await db.refresh(run)
    return run


@router.post("/{run_id}/execute", response_model=RunResponse)
async def execute_run(run_id: str, db: AsyncSession = Depends(get_db)):
    """Start execution of a run — triggers the Temporal workflow."""
    result = await db.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    if run.status != RunStatus.PENDING:
        raise HTTPException(
            status_code=400, detail=f"Run is not in pending state: {run.status}"
        )

    # Load the integration's config so the workflow has everything it needs.
    integ_result = await db.execute(
        select(Integration).where(Integration.id == run.integration_id)
    )
    integration = integ_result.scalar_one_or_none()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")

    # Flip to RUNNING before we ship work off to Temporal so the UI can
    # reflect the transition even if the worker is slow to pick up the task.
    run.status = RunStatus.RUNNING
    run.started_at = datetime.utcnow()
    workflow_id = f"integration-run-{run.id}"
    run.temporal_workflow_id = workflow_id
    await db.commit()
    await db.refresh(run)

    try:
        client = await Client.connect(
            settings.temporal_host, namespace=settings.temporal_namespace
        )
        await client.start_workflow(
            IntegrationRunWorkflow.run,
            IntegrationRunInput(
                run_id=run.id,
                integration_id=integration.id,
                config=integration.config or {},
                input_data=run.input_data or {},
            ),
            id=workflow_id,
            task_queue=settings.temporal_task_queue,
        )
    except Exception as exc:
        # Couldn't start — mark the run failed so it doesn't sit as RUNNING forever.
        logger.exception("Failed to start Temporal workflow for run %s", run.id)
        run.status = RunStatus.FAILED
        run.error_message = f"Failed to start workflow: {exc}"
        run.completed_at = datetime.utcnow()
        await db.commit()
        await db.refresh(run)
        raise HTTPException(status_code=500, detail=str(exc))

    return run
