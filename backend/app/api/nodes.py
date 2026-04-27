"""
Node-scoped operations — the right-rail "Test" button calls into here.

Two endpoints:
  - `POST /api/nodes/test`            — sync per-node executor.
  - `GET  /api/nodes/replay-input`    — derive the input a node received
                                          in a past run, so the user can
                                          replay it through the node's
                                          *current* config.

Both are thin wrappers around `services/node_test_executor.py` — see that
module for the dispatch logic.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import cast, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Run
from app.services import node_test_executor

router = APIRouter()


class NodeTestIn(BaseModel):
    """Single-node test invocation. The `node` shape mirrors what the
    workflow consumes — id, kind, action, config, optional `when`. Only
    `kind`, `action`, and `config` are load-bearing for the test runner;
    `id` is echoed back for client correlation."""

    node: dict[str, Any] = Field(
        description=(
            "Node spec: {id, kind, action, config, when?, branches?}. "
            "Containers/process.call are returned as `not_testable`."
        )
    )
    input_data: Any = Field(
        default=None,
        description="JSON value handed to the node as `current_data`.",
    )


class NodeTestOut(BaseModel):
    ok: bool
    kind: str
    duration_ms: int
    output: Optional[Any] = None
    error: Optional[str] = None
    error_kind: Optional[str] = None
    # Captured stdout for kinds whose runtime supports `print()` capture
    # (today: code.python). `null` when nothing was printed; the field
    # is always present so the client doesn't branch on shape.
    stdout: Optional[str] = None


@router.post("/test", response_model=NodeTestOut)
async def test_node(payload: NodeTestIn) -> NodeTestOut:
    """Execute one node sync. Never persists anything — pure read-side
    test surface."""
    if not isinstance(payload.node, dict) or not payload.node.get("kind"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="node.kind is required",
        )
    result = await node_test_executor.execute_node(payload.node, payload.input_data)
    return NodeTestOut(**result)


class ReplayInputOut(BaseModel):
    run_id: str
    node_id: str
    found: bool
    input_data: Optional[Any] = None
    note: Optional[str] = None


@router.get("/replay-input", response_model=ReplayInputOut)
async def get_replay_input(
    run_id: str = Query(..., description="Run UUID to derive input from"),
    node_id: str = Query(..., description="Target node id"),
    db: AsyncSession = Depends(get_db),
) -> ReplayInputOut:
    """Derive the input the given node received in the given past run.

    Returns `found=False` when the node didn't actually execute in that
    run (e.g. conditional skipped its whole stage). Otherwise returns the
    JSON that would have flowed in — useful for "replay this run with my
    new config" workflows.
    """
    run = await db.get(Run, run_id)
    if run is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f"run {run_id!r} not found"
        )
    derived = node_test_executor.derive_node_input(
        run.steps or [], node_id, run.input_data
    )
    if derived is None:
        return ReplayInputOut(
            run_id=run_id,
            node_id=node_id,
            found=False,
            note=(
                "node didn't run in this run — likely skipped by a conditional "
                "or short-circuited by an earlier failure"
            ),
        )
    return ReplayInputOut(
        run_id=run_id, node_id=node_id, found=True, input_data=derived
    )


class NodeRunSummary(BaseModel):
    """Slim run record — just what the test-overlay picker needs to render
    one row. Skips heavy fields (`steps`, `output_data`) the picker
    wouldn't show anyway."""

    id: str
    integration_id: str
    status: str
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime


@router.get("/runs", response_model=list[NodeRunSummary])
async def list_runs_for_node(
    integration_id: str = Query(..., description="Filter by parent integration"),
    node_id: str = Query(..., description="Only runs whose `steps` array contains this node id"),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[NodeRunSummary]:
    """Return runs where this specific node actually executed.

    JSONB containment filter (`steps @> '[{"node_id": <X>}]'`) — uses the
    same Postgres operator that's optimisable with a GIN index on
    `runs.steps` if we ever care about throughput. For v1's per-host
    workload (a few thousand runs) the seq scan is fine.
    """
    needle = [{"node_id": node_id}]
    stmt = (
        select(Run)
        .where(
            Run.integration_id == integration_id,
            cast(Run.steps, JSONB).op("@>")(cast(needle, JSONB)),
        )
        .order_by(Run.created_at.desc())
        .limit(limit)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    return [
        NodeRunSummary(
            id=r.id,
            integration_id=r.integration_id,
            status=str(r.status.value) if hasattr(r.status, "value") else str(r.status),
            started_at=r.started_at,
            completed_at=r.completed_at,
            created_at=r.created_at,
        )
        for r in rows
    ]


class NodeOutputOut(BaseModel):
    """A specific past output produced by `node_id` — used by the
    reference picker to drive schema inference from real run data."""

    integration_id: str
    node_id: str
    found: bool
    run_id: Optional[str] = None
    finished_at: Optional[datetime] = None
    status: Optional[str] = None
    output: Optional[Any] = None
    note: Optional[str] = None


@router.get("/output", response_model=NodeOutputOut)
async def get_recent_output(
    integration_id: str = Query(..., description="Filter by parent integration"),
    node_id: str = Query(..., description="Step whose output to surface"),
    run_id: Optional[str] = Query(
        default=None,
        description=(
            "When set, returns this specific run's output for the node. "
            "When omitted, returns the most-recent SUCCESSFUL output."
        ),
    ),
    db: AsyncSession = Depends(get_db),
) -> NodeOutputOut:
    """Return the JSON output a step produced in a past run.

    Drives the reference picker's runtime-aware schema. When `run_id` is
    omitted, walks runs newest-first (JSONB filter on `steps`) and
    returns the first one where the step record both contains this node
    AND has a populated `output`. Skipped/failed step records are
    skipped for the auto pick — users authoring references almost
    always want the real data shape, not the empty / error case.
    """
    if run_id is not None:
        # Caller specified a run — return that specific output exactly.
        run = await db.get(Run, run_id)
        if run is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail=f"run {run_id!r} not found"
            )
        step = _find_step(run.steps or [], node_id)
        if step is None:
            return NodeOutputOut(
                integration_id=integration_id,
                node_id=node_id,
                found=False,
                run_id=run_id,
                note="node didn't run in this run",
            )
        return NodeOutputOut(
            integration_id=integration_id,
            node_id=node_id,
            found="output" in step,
            run_id=run_id,
            status=str(step.get("status") or ""),
            output=step.get("output"),
            finished_at=run.completed_at or run.created_at,
            note=None if "output" in step else "step recorded no output",
        )

    # Auto-pick: latest run where this node has a populated output.
    needle = [{"node_id": node_id}]
    stmt = (
        select(Run)
        .where(
            Run.integration_id == integration_id,
            cast(Run.steps, JSONB).op("@>")(cast(needle, JSONB)),
        )
        .order_by(Run.created_at.desc())
        .limit(20)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    for r in rows:
        step = _find_step(r.steps or [], node_id)
        if step is None or "output" not in step:
            continue
        if step.get("status") not in ("success", None):
            continue
        return NodeOutputOut(
            integration_id=integration_id,
            node_id=node_id,
            found=True,
            run_id=r.id,
            status=str(step.get("status") or ""),
            output=step.get("output"),
            finished_at=r.completed_at or r.created_at,
        )
    return NodeOutputOut(
        integration_id=integration_id,
        node_id=node_id,
        found=False,
        note="no successful run with this step's output yet",
    )


def _find_step(steps: list, node_id: str) -> Optional[dict]:
    """Walk a step record list (workflow's stage-flat append shape) and
    return the entry for `node_id`. Branch / Loop containers don't emit
    nested step records today — every dispatched node appends one — so a
    flat scan is correct."""
    for s in steps:
        if isinstance(s, dict) and s.get("node_id") == node_id:
            return s
    return None
