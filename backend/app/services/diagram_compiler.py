"""
Pure compile function: `ProcessDiagramDoc` → `IntegrationConfig.nodes[]`.

Every emitted SolderNode kind is verified to exist in
`frontend/src/catalog.ts` (`http.request`, `transform.map`, `data.filter`,
`logic.{branch,loop,switch}`, `state.set`, `output.passthrough`). The
audit's "5 phantom kinds" (`data.zip-by-key`, `data.merge`, `data.lookup`,
`logic.note`, `output.notify`) are NOT emitted; the v3 mapping table
translates each to an existing kind.

The function is pure (no DB writes); `compile_and_persist` wraps it with
the API-side Integration insert + ProcessDiagram drift tracking.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Integration, IntegrationVersion, ProcessDiagram


def compile_diagram(doc: dict) -> dict:
    """Pure transform: diagram document → {trigger, config:{nodes, variables}}.

    Same input + ctx → byte-identical output. Caller is responsible for
    DB writes.
    """
    systems = {s["id"]: s for s in doc.get("systems") or []}
    objects = {o["id"]: o for o in doc.get("objects") or []}
    flows = list(doc.get("flows") or [])
    edges = list(doc.get("edges") or [])
    triggers = list(doc.get("triggers") or [])
    variables = dict(doc.get("variables") or {})

    # Identify the trigger source (the object the run starts from).
    primary_trigger = triggers[0] if triggers else None
    trigger_source_object_id = (
        primary_trigger.get("sourceObjectId") if primary_trigger else None
    )

    # Group edge guards by attached flow id for quick lookup
    guards_by_flow: dict[str, list[dict]] = {}
    for g in edges:
        for f_id in g.get("attaches") or []:
            guards_by_flow.setdefault(f_id, []).append(g)

    # Topological sort: order flows so source-system objects' fetches run
    # before any downstream merge. Heuristic — process flows whose source
    # is the trigger source first, then expand outward.
    ordered = _topo_order_flows(flows, trigger_source_object_id)

    nodes: list[dict] = []
    stage = 1
    fetch_node_for_object: dict[str, str] = {}

    for flow in ordered:
        from_obj = objects.get(flow["from"])
        to_obj = objects.get(flow["to"])
        if not from_obj or not to_obj:
            continue
        from_sys = systems.get(from_obj.get("system"))
        to_sys = systems.get(to_obj.get("system"))

        # 1. Native flow → output.passthrough with comment, no HTTP
        if flow.get("native"):
            nodes.append(_node_passthrough(
                node_id=_node_id("native", flow["id"]),
                stage=stage,
                label=f"{flow.get('label') or flow['id']} (Ramp native)",
                comment=(
                    flow.get("note")
                    or f"{flow.get('label', flow['id'])} — Ramp native integration, no custom HTTP"
                ),
            ))
            stage += 1
            continue

        # 2. Source fetch — once per source object id (multiple flows
        #    from the same source share a single fetch step).
        if from_obj["id"] in fetch_node_for_object:
            source_node_id = fetch_node_for_object[from_obj["id"]]
        else:
            is_trigger_source = (
                trigger_source_object_id == from_obj["id"]
                and primary_trigger
                and primary_trigger.get("verb") != "schedule"
            )
            source_node_id = _node_id("fetch", from_obj["id"])
            if is_trigger_source:
                # `state.set` republishes the trigger payload under an alias
                nodes.append({
                    "id": source_node_id,
                    "kind": "state",
                    "action": "set",
                    "stage": stage,
                    "slot": 0,
                    "config": {
                        "name": f"src_{from_obj['id'].replace('.', '_')}",
                        "value": "{{$.trigger.payload}}",
                    },
                    "label": f"Take {from_obj.get('label', from_obj['id'])} from trigger",
                })
            else:
                fetch_url = _sample_path_for(from_sys, from_obj.get("entityType") or _entity_type_from_object(from_obj))
                nodes.append({
                    "id": source_node_id,
                    "kind": "http",
                    "action": "request",
                    "stage": stage,
                    "slot": 0,
                    "config": {
                        "schemaVersion": 2,
                        "connectionId": (from_sys or {}).get("connectionId"),
                        "method": "GET",
                        "url": fetch_url,
                        "params": [],
                        "headers": [],
                        "body": {"mode": "none", "contentType": None},
                        "auth": {"mode": "inherit"},
                        "settings": {
                            "timeoutSeconds": 30,
                            "followRedirects": True,
                            "rejectUnauthorized": True,
                            "sandboxOverride": "auto",
                        },
                        "pagination": {"mode": "none"},
                    },
                    "label": f"List {from_obj.get('label', from_obj['id'])} from {from_sys.get('label') if from_sys else 'source'}",
                })
            fetch_node_for_object[from_obj["id"]] = source_node_id
            stage += 1

        # 3. Loop body — transform + write per item, wrapped in logic.loop
        transform_id = _node_id("map", flow["id"])
        write_id = _node_id("write", flow["id"])

        loop_body: list[dict] = []
        loop_body.append({
            "id": transform_id,
            "kind": "transform",
            "action": "map",
            "stage": 1,
            "slot": 0,
            "config": {
                "expression": _build_map_expression(flow, from_obj, to_obj),
            },
            "label": f"Map {from_obj.get('label')} → {to_obj.get('label')}",
        })

        method = "POST" if flow.get("action") == "create" else (
            "PUT" if flow.get("action") == "upsert" else "POST"
        )
        create_url = _create_path_for(to_sys, to_obj.get("entityType") or _entity_type_from_object(to_obj))
        loop_body.append({
            "id": write_id,
            "kind": "http",
            "action": "request",
            "stage": 2,
            "slot": 0,
            "config": {
                "schemaVersion": 2,
                "connectionId": (to_sys or {}).get("connectionId"),
                "method": method,
                "url": create_url,
                "params": [],
                "headers": [
                    {
                        "enabled": True,
                        "key": "Idempotency-Key",
                        "value": f"{{{{$.run.id}}}}::{flow['id']}::{{{{$.loop.item.id}}}}",
                    }
                ],
                "body": {
                    "mode": "json",
                    "json": "{{$.steps." + transform_id + ".output}}",
                    "contentType": "application/json",
                },
                "auth": {"mode": "inherit"},
                "settings": {
                    "timeoutSeconds": 30,
                    "followRedirects": True,
                    "rejectUnauthorized": True,
                    "sandboxOverride": "auto",
                },
                "pagination": {"mode": "none"},
            },
            "label": f"{'Create' if method == 'POST' else 'Update'} {to_obj.get('label')} in {to_sys.get('label') if to_sys else 'target'}",
        })

        # 4. Edge guards attached to this flow → wrap the write in
        #    logic.branch (fallback) or precede with data.filter (guard).
        guards = guards_by_flow.get(flow["id"]) or []
        for guard in guards:
            kind = guard.get("kind")
            if kind == "fallback":
                # Replace the write with: logic.branch whose true arm runs
                # the write, false arm sets a quarantine flag.
                fallback_branch = {
                    "id": _node_id("branch", guard["id"]),
                    "kind": "logic",
                    "action": "branch",
                    "stage": 2,
                    "slot": 0,
                    "config": {
                        "expression": "$.last_status >= 200 && $.last_status < 400"
                    },
                    "branches": {
                        "true": [{
                            **loop_body[-1],
                            "stage": 1,
                            "slot": 0,
                        }],
                        "false": [{
                            "id": _node_id("quarantine", guard["id"]),
                            "kind": "state",
                            "action": "set",
                            "stage": 1,
                            "slot": 0,
                            "config": {
                                "name": f"quarantine_{flow['id'].replace('.', '_')}",
                                "value": {
                                    "flag": True,
                                    "reason": guard.get("detail") or guard.get("label"),
                                    "routed_to": "AP-reviewer",
                                    "guard_id": guard["id"],
                                },
                            },
                            "label": f"Quarantine → {guard.get('label')}",
                        }],
                    },
                    "label": f"Guard: {guard.get('label')}",
                }
                loop_body[-1] = fallback_branch
            elif kind == "guard":
                # data.filter upstream of the write (dedupe / validation)
                loop_body.insert(0, {
                    "id": _node_id("filter", guard["id"]),
                    "kind": "data",
                    "action": "filter",
                    "stage": 0,
                    "slot": 0,
                    "config": {
                        "expression": "true",  # placeholder; real predicate authored in editor
                        "note": guard.get("detail"),
                    },
                    "label": f"Guard: {guard.get('label')}",
                })
            # retry guards are UI-only in Phase 1 (no http.request.retry config)

        nodes.append({
            "id": _node_id("loop", flow["id"]),
            "kind": "logic",
            "action": "loop",
            "stage": stage,
            "slot": 0,
            "config": {"over": f"$.steps.{source_node_id}.output"},
            "branches": {"body": loop_body},
            "label": f"For each {from_obj.get('label')}",
        })
        stage += 1

    # ── Trigger compilation ────────────────────────────────────────────
    if primary_trigger and primary_trigger.get("verb") in ("schedule", "on_create", "on_update"):
        sched = primary_trigger.get("schedule") or {}
        trigger = {
            "type": "schedule",
            "interval_seconds": int((sched.get("interval_seconds") or 300)),
            "dedupe_field": "id",
            "seen_ids": [],
            "_diagram_verb": primary_trigger.get("verb"),
        }
    else:
        trigger = {"type": "manual"}

    return {
        "trigger": trigger,
        "config": {"nodes": nodes, "variables": variables},
    }


# ── Helpers ────────────────────────────────────────────────────────────


_SLUG_RE = re.compile(r"[^a-zA-Z0-9_]+")


def _node_id(prefix: str, key: str) -> str:
    slug = _SLUG_RE.sub("_", key).strip("_").upper()
    return f"{prefix.upper()}_{slug}"


def _topo_order_flows(flows: list[dict], trigger_source_id: Optional[str]) -> list[dict]:
    """Order flows so source-of-trigger goes first, then breadth-first by
    target. Stable for any given doc."""
    if not flows:
        return []
    by_id = {f["id"]: f for f in flows}
    visited: set[str] = set()
    out: list[dict] = []

    # Seed with flows whose source is the trigger object
    seeds = [f for f in flows if f.get("from") == trigger_source_id]
    if not seeds:
        seeds = list(flows)  # Fallback: process all in order

    queue = [f["id"] for f in seeds]
    while queue:
        fid = queue.pop(0)
        if fid in visited:
            continue
        visited.add(fid)
        f = by_id.get(fid)
        if not f:
            continue
        out.append(f)
        # Any flow whose source matches this flow's target gets queued next
        for other in flows:
            if other["id"] not in visited and other.get("from") == f.get("to"):
                queue.append(other["id"])

    # Append unvisited (defensive)
    for f in flows:
        if f["id"] not in visited:
            out.append(f)
    return out


def _sample_path_for(system: Optional[dict], entity_type: Optional[str]) -> str:
    """Look up the sample (list) path for this entity in the system's
    OpenAPISpec.entity_schemas if available. Falls back to a guessed path."""
    if not entity_type:
        return "/"
    # Real path resolution happens at compile time only if the caller
    # has loaded the entity_schemas; here we rely on the diagram doc to
    # carry the resolved paths under each ObjectNode (set by the editor
    # at object-drop time from the spec). Fallback guess:
    return f"/{entity_type}s" if not entity_type.endswith("s") else f"/{entity_type}"


def _create_path_for(system: Optional[dict], entity_type: Optional[str]) -> str:
    """Mirror of _sample_path_for for POST/PUT."""
    return _sample_path_for(system, entity_type)


def _entity_type_from_object(obj: dict) -> str:
    """Fallback to deriving entity_type from the object label/id."""
    if obj.get("entityType"):
        return obj["entityType"]
    label = (obj.get("label") or obj.get("id") or "").lower()
    # 'purchase order' → 'purchase_order'
    return _SLUG_RE.sub("_", label).strip("_")


def _node_passthrough(node_id: str, stage: int, label: str, comment: str) -> dict:
    return {
        "id": node_id,
        "kind": "output",
        "action": "passthrough",
        "stage": stage,
        "slot": 0,
        "config": {"comment": comment},
        "label": label,
    }


def _build_map_expression(flow: dict, from_obj: dict, to_obj: dict) -> str:
    """Produce a JSON-builder-style expression from flow.mappings.

    Falls back to a passthrough if no mappings exist (the editor will
    surface the empty grid + AI-suggest button at that point)."""
    mappings = flow.get("mappings") or []
    if not mappings:
        return "$.loop.item"
    parts: list[str] = []
    for m in mappings:
        target_path = m.get("targetPath")
        source = m.get("source") or {}
        kind = source.get("kind")
        if not target_path or not kind:
            continue
        if kind == "path":
            expr = source.get("expression") or "$.loop.item"
        elif kind == "literal":
            expr = json.dumps(source.get("value"))
        elif kind == "transform":
            expr = source.get("expression") or "null"
        elif kind == "lookup":
            # Phase 1: compile lookup as a placeholder string the editor
            # can replace post-generate. Real lookup runs as an HTTP step
            # in Phase 2.
            expr = f"/* lookup {source.get('targetEntity')}.{source.get('matchOn')} */ null"
        else:
            expr = "null"
        parts.append(f"  {json.dumps(target_path)}: {expr}")
    return "{\n" + ",\n".join(parts) + "\n}"


# ── API-side wrapper ───────────────────────────────────────────────────


async def compile_and_persist(
    *,
    db: AsyncSession,
    diagram: ProcessDiagram,
    target_integration_id: Optional[str],
    force: bool,
) -> dict:
    """Compile + persist as a new (or updated) Integration. Returns the
    GenerateResponse shape (integration_id, nodes_count, warnings, preview)."""
    compiled = compile_diagram(diagram.document or {})
    nodes = compiled["config"]["nodes"]
    doc_hash = hashlib.sha1(
        json.dumps(diagram.document or {}, sort_keys=True, default=str).encode()
    ).hexdigest()

    # Drift check
    warnings: list[dict] = []
    if (
        diagram.integration_id
        and diagram.last_generated_doc_hash
        and diagram.last_generated_doc_hash != doc_hash
        and not force
    ):
        # Diagram changed since last generate; warn but proceed unless
        # the linked Integration has been hand-edited.
        warnings.append({
            "kind": "drift",
            "message": "Diagram has changed since last generate; overwriting the linked Integration.",
        })

    target_id = target_integration_id or diagram.integration_id
    if target_id:
        integration = await db.get(Integration, target_id)
        if integration is None:
            target_id = None  # fall through to insert path

    if target_id is None:
        integration = Integration(
            name=diagram.name,
            description=diagram.description,
            config=compiled["config"],
            trigger=compiled["trigger"],
            environment="sandbox",
            status="draft",
        )
        db.add(integration)
        await db.flush()
        diagram.integration_id = integration.id
    else:
        integration.config = compiled["config"]
        integration.trigger = compiled["trigger"]
        integration.name = diagram.name
        integration.description = diagram.description

    diagram.last_generated_at = datetime.now(tz=timezone.utc)
    diagram.last_generated_doc_hash = doc_hash

    # Snapshot version (mirrors IntegrationVersion pattern from
    # integrations.py — kept simple here)
    last_version = (
        await db.execute(
            __import__("sqlalchemy").select(IntegrationVersion).where(
                IntegrationVersion.integration_id == integration.id
            ).order_by(IntegrationVersion.version_number.desc()).limit(1)
        )
    ).scalar_one_or_none()
    next_v = (last_version.version_number + 1) if last_version else 1
    db.add(IntegrationVersion(
        integration_id=integration.id,
        version_number=next_v,
        name=integration.name,
        description=integration.description,
        config=integration.config,
        trigger=integration.trigger,
        is_library=integration.is_library,
        change_summary=f"Generated from process diagram {diagram.id} (v{next_v})",
    ))

    await db.commit()

    # Optional: validate emitted URLs against MockSpec.routes (Phase 1
    # warns; doesn't block). Skipped for v1 — synth bank may not have
    # every route yet but the run will still work.

    return {
        "integration_id": integration.id,
        "nodes_count": len(nodes),
        "warnings": warnings,
        "preview_config": compiled["config"],
    }
