"""Compute human-readable summaries between integration snapshots.

Used by the integrations API to tag each ``IntegrationVersion`` row with a
compact ``change_summary`` describing what changed relative to the prior
version. Pure/stateless — no DB access, no side effects.

Shape of a snapshot payload::

    {
        "name": str,
        "description": str | None,
        "config": dict,   # {"nodes": [...], "variables": {...}, ...}
        "trigger": dict,  # {"type": "manual" | "webhook" | ...}
        "is_library": bool,
    }

The output is a single sentence suitable for a history feed. We cap detected
changes at roughly 5 lines and collapse bulk node add/remove into counts.
"""

from __future__ import annotations

from typing import Any

# Max number of individual change phrases we emit before we stop listing.
_MAX_PHRASES = 5
# Collapse threshold for per-node add/remove listings.
_COLLAPSE_THRESHOLD = 3


def describe_changes(prev: dict | None, curr: dict) -> str:
    """Return a short human-readable description of what changed from prev to curr.

    ``prev`` and ``curr`` are full integration payloads:
    ``{name, description, config, trigger, is_library}``. When ``prev`` is
    ``None`` (first save), returns ``"Initial save."``. When nothing changed,
    returns ``"No changes."``.
    """
    if prev is None:
        return "Initial save."

    phrases: list[str] = []

    # 1. Name change
    prev_name = prev.get("name")
    curr_name = curr.get("name")
    if prev_name != curr_name:
        phrases.append(f"Renamed to {_fmt_name(curr_name)}")

    # 2. Trigger change
    prev_trigger = prev.get("trigger") or {}
    curr_trigger = curr.get("trigger") or {}
    prev_ttype = prev_trigger.get("type")
    curr_ttype = curr_trigger.get("type")
    if prev_ttype != curr_ttype:
        phrases.append(
            f"changed trigger: {prev_ttype or 'none'} -> {curr_ttype or 'none'}"
        )
    elif prev_trigger != curr_trigger:
        phrases.append(f"updated {curr_ttype or 'manual'} trigger config")

    # 3. is_library toggle
    prev_lib = bool(prev.get("is_library"))
    curr_lib = bool(curr.get("is_library"))
    if prev_lib != curr_lib:
        phrases.append("made reusable" if curr_lib else "removed from library")

    # 4-7. Node-level diff (includes nested branches)
    prev_cfg = prev.get("config") or {}
    curr_cfg = curr.get("config") or {}
    node_phrases = _diff_nodes(
        prev_cfg.get("nodes") or [],
        curr_cfg.get("nodes") or [],
        scope=None,
    )
    phrases.extend(node_phrases)

    # 8. Variables changed
    if (prev_cfg.get("variables") or {}) != (curr_cfg.get("variables") or {}):
        phrases.append("updated variables")

    # Also catch description change if nothing else fired — keeps the summary
    # meaningful for docs-only edits.
    if not phrases:
        if (prev.get("description") or "") != (curr.get("description") or ""):
            phrases.append("updated description")

    if not phrases:
        return "No changes."

    # Normalize capitalization: first phrase starts with a capital, rest lowercase.
    trimmed = phrases[:_MAX_PHRASES]
    first = trimmed[0]
    if first and first[0].islower():
        first = first[0].upper() + first[1:]
    rest = [p[0].lower() + p[1:] if p and p[0].isupper() else p for p in trimmed[1:]]
    out = ", ".join([first, *rest])
    if not out.endswith("."):
        out += "."
    return out


def _fmt_name(name: Any) -> str:
    if name is None:
        return "(unnamed)"
    return f"'{name}'"


def _node_label(node: dict) -> str:
    """Return `kind.action` (or just `kind`) for a node dict.

    Defensive — nodes in the wild may lack one field. Falls back to `type` or
    `id` before declaring the node anonymous.
    """
    kind = node.get("kind") or node.get("type") or node.get("id") or "node"
    action = node.get("action")
    return f"{kind}.{action}" if action else str(kind)


def _node_stage(node: dict) -> Any:
    """Best-effort stage index. Integrations may store this under different keys."""
    for key in ("stage", "stage_index", "stageIndex"):
        if key in node:
            return node[key]
    return None


def _diff_nodes(
    prev_nodes: list[dict], curr_nodes: list[dict], scope: str | None
) -> list[str]:
    """Recursively compare two node lists by id.

    ``scope`` is a human-readable prefix like ``"Branch.true"`` used to
    qualify phrases from nested branches. ``None`` at the top level.
    """
    phrases: list[str] = []

    prev_by_id = {n.get("id"): n for n in prev_nodes if isinstance(n, dict)}
    curr_by_id = {n.get("id"): n for n in curr_nodes if isinstance(n, dict)}

    added_ids = [nid for nid in curr_by_id if nid not in prev_by_id]
    removed_ids = [nid for nid in prev_by_id if nid not in curr_by_id]
    common_ids = [nid for nid in curr_by_id if nid in prev_by_id]

    # Additions
    added_phrases = []
    for nid in added_ids:
        node = curr_by_id[nid]
        label = _node_label(node)
        stage = _node_stage(node)
        where = _where(scope, stage)
        added_phrases.append(f"added {label}{where}")
    if len(added_phrases) >= _COLLAPSE_THRESHOLD:
        suffix = f" in {scope}" if scope else ""
        phrases.append(f"added {len(added_phrases)} nodes{suffix}")
    else:
        phrases.extend(added_phrases)

    # Removals
    removed_phrases = []
    for nid in removed_ids:
        node = prev_by_id[nid]
        label = _node_label(node)
        removed_phrases.append(f"removed {label}{(' in ' + scope) if scope else ''}")
    if len(removed_phrases) >= _COLLAPSE_THRESHOLD:
        suffix = f" in {scope}" if scope else ""
        phrases.append(f"removed {len(removed_phrases)} nodes{suffix}")
    else:
        phrases.extend(removed_phrases)

    # Edits + moves for surviving nodes
    moved_stages: set[Any] = set()
    reordered_stages: set[Any] = set()
    for nid in common_ids:
        prev_node = prev_by_id[nid]
        curr_node = curr_by_id[nid]
        label = _node_label(curr_node)

        prev_stage = _node_stage(prev_node)
        curr_stage = _node_stage(curr_node)
        if prev_stage != curr_stage and curr_stage is not None:
            phrases.append(
                f"moved {label} to stage {curr_stage}"
                + (f" in {scope}" if scope else "")
            )
            moved_stages.add(curr_stage)

        # Recurse into branches if present. Branch container shape assumed:
        # {"branches": {"true": {"nodes": [...]}, "false": {"nodes": [...]}}}
        prev_branches = prev_node.get("branches") or {}
        curr_branches = curr_node.get("branches") or {}
        if isinstance(prev_branches, dict) and isinstance(curr_branches, dict):
            branch_keys = set(prev_branches.keys()) | set(curr_branches.keys())
            for bkey in branch_keys:
                prev_branch = prev_branches.get(bkey) or {}
                curr_branch = curr_branches.get(bkey) or {}
                prev_inner = prev_branch.get("nodes") or []
                curr_inner = curr_branch.get("nodes") or []
                inner_scope = f"Branch.{bkey}"
                phrases.extend(_diff_nodes(prev_inner, curr_inner, scope=inner_scope))

        # Config-level edit: compare everything except the positional/branch
        # fields we already handled separately.
        if _node_config_changed(prev_node, curr_node):
            phrases.append(
                f"edited {label}"
                + (f" at stage {curr_stage}" if curr_stage is not None and scope is None else "")
                + (f" in {scope}" if scope else "")
            )

    # Stage reorder detection: if the sequence of ids within a stage changed
    # but membership didn't, call that out.
    if scope is None:
        prev_by_stage = _group_by_stage(prev_nodes)
        curr_by_stage = _group_by_stage(curr_nodes)
        for stage, curr_ids in curr_by_stage.items():
            prev_ids = prev_by_stage.get(stage, [])
            if (
                set(prev_ids) == set(curr_ids)
                and prev_ids != curr_ids
                and len(curr_ids) > 1
                and stage not in moved_stages
                and stage not in reordered_stages
            ):
                phrases.append(f"reordered stage {stage}")
                reordered_stages.add(stage)

    return phrases


_POSITIONAL_KEYS = {"stage", "stage_index", "stageIndex", "slot", "branches"}


def _node_config_changed(prev_node: dict, curr_node: dict) -> bool:
    """True if anything outside positional/branch fields differs."""
    keys = (set(prev_node.keys()) | set(curr_node.keys())) - _POSITIONAL_KEYS
    for k in keys:
        if prev_node.get(k) != curr_node.get(k):
            return True
    return False


def _group_by_stage(nodes: list[dict]) -> dict[Any, list[Any]]:
    out: dict[Any, list[Any]] = {}
    for n in nodes:
        if not isinstance(n, dict):
            continue
        stage = _node_stage(n)
        out.setdefault(stage, []).append(n.get("id"))
    return out


def _where(scope: str | None, stage: Any) -> str:
    """Return a trailing clause like ' at stage 2' / ' in Branch.true'."""
    if scope:
        return f" in {scope}"
    if stage is not None:
        return f" at stage {stage}"
    return ""
