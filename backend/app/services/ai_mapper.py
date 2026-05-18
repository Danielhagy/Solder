"""
Per-edge field mapping suggestion using Claude Sonnet.

Mirrors `services/ai_synthesizer.py`'s tool-use shape. Cache lives
server-side in `ProcessDiagram.document.aiMappingCache[edge_id]` (per
plan v3 audit) — survives incognito + Chrome update.

Failure falls back to deterministic name-match suggestions so the demo
never dies offline.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.agents import SONNET
from app.config import settings
from app.models import ProcessDiagram


@dataclass
class MappingSuggestion:
    target_path: str
    source_expression: str
    confidence: float
    rationale: str
    needs_review: bool = False


async def suggest_for_edge(
    *,
    db: AsyncSession,
    diagram: ProcessDiagram,
    edge_id: str,
    source_object_id: Optional[str] = None,
    target_object_id: Optional[str] = None,
    edge_action: Optional[str] = None,
    extra_context: Optional[str] = None,
) -> dict:
    """Return mapping suggestions for one edge, prefer cache → live → fallback.

    Persists the live response back to `ProcessDiagram.document.aiMappingCache`
    so the next call hits cache (and the demo replays from disk after the
    first dry-run pass)."""
    doc = diagram.document or {}
    flows = doc.get("flows") or []
    flow = next((f for f in flows if f.get("id") == edge_id), None)
    if not flow:
        raise ValueError(f"edge {edge_id!r} not found in diagram")

    objects = {o["id"]: o for o in (doc.get("objects") or [])}
    source_obj = objects.get(source_object_id or flow.get("from") or "")
    target_obj = objects.get(target_object_id or flow.get("to") or "")
    if not source_obj or not target_obj:
        raise ValueError("source or target object missing from diagram")

    action = edge_action or flow.get("action") or "create"
    ctx = (
        extra_context
        or f"{flow.get('role') or 'data flow'} — {flow.get('label') or edge_id}; "
        f"source kind={source_obj.get('kind')}, target kind={target_obj.get('kind')}"
    )

    source_fields = source_obj.get("fields") or []
    target_fields = target_obj.get("fields") or []
    api_key = getattr(settings, "anthropic_api_key", None) or ""

    suggestions: list[MappingSuggestion] = []
    live_source = "fallback"

    if api_key:
        try:
            suggestions = _call_sonnet(
                source_fields=source_fields,
                target_fields=target_fields,
                action=action,
                extra_context=ctx,
                api_key=api_key,
            )
            live_source = "live"
        except Exception as e:  # noqa: BLE001 — fallback is the contract
            suggestions = _fallback_heuristic(source_fields, target_fields)
            live_source = "fallback"
    else:
        suggestions = _fallback_heuristic(source_fields, target_fields)

    payload = [asdict(s) for s in suggestions]
    # Persist back to the document cache
    cache = dict(doc.get("aiMappingCache") or {})
    cache[edge_id] = {"mappings": payload, "source": live_source}
    new_doc = dict(doc)
    new_doc["aiMappingCache"] = cache
    diagram.document = new_doc
    await db.commit()

    return {"mappings": payload, "cached": False, "source": live_source}


def _call_sonnet(
    *,
    source_fields: list[dict],
    target_fields: list[dict],
    action: str,
    extra_context: str,
    api_key: str,
) -> list[MappingSuggestion]:
    """One Sonnet call returning structured MappingSuggestion[]."""
    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)
    system = (
        "You are a senior integration consultant doing live field mapping "
        "between two systems. Bias toward exact-name + same-type matches "
        "(confidence >= 0.95); slightly different names but same semantic "
        "meaning (e.g. id ↔ external_id) get 0.85-0.92; semantically close "
        "but ambiguous gets 0.70-0.80; below that, omit. NEVER swap source "
        "and target. Source paths use dotted notation rooted at "
        "$.loop.item."
    )
    prompt = (
        f"Edge action: {action}\nContext: {extra_context}\n\n"
        f"Source object fields:\n{json.dumps(source_fields, indent=2, default=str)}\n\n"
        f"Target object fields:\n{json.dumps(target_fields, indent=2, default=str)}\n\n"
        "Return a mapping suggestion for as many target fields as you can "
        "confidently propose."
    )
    response = client.messages.create(
        model=SONNET,
        max_tokens=2000,
        system=system,
        tools=[
            {
                "name": "submit_mappings",
                "description": "Submit field mappings.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "mappings": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "target_path": {"type": "string"},
                                    "source_expression": {"type": "string"},
                                    "confidence": {"type": "number"},
                                    "rationale": {"type": "string"},
                                },
                                "required": [
                                    "target_path",
                                    "source_expression",
                                    "confidence",
                                    "rationale",
                                ],
                            },
                        }
                    },
                    "required": ["mappings"],
                },
            }
        ],
        tool_choice={"type": "tool", "name": "submit_mappings"},
        messages=[{"role": "user", "content": prompt}],
    )
    out: list[MappingSuggestion] = []
    for block in response.content:
        if getattr(block, "type", None) == "tool_use":
            payload = block.input or {}
            for m in (payload.get("mappings") or []):
                conf = float(m.get("confidence") or 0)
                out.append(
                    MappingSuggestion(
                        target_path=str(m.get("target_path") or ""),
                        source_expression=str(m.get("source_expression") or ""),
                        confidence=conf,
                        rationale=str(m.get("rationale") or ""),
                        needs_review=0.70 <= conf < 0.90,
                    )
                )
            break
    return out


def _fallback_heuristic(
    source_fields: list[dict], target_fields: list[dict]
) -> list[MappingSuggestion]:
    """Deterministic name-match. Used when the API is unset/unreachable.

    Three passes: exact name (0.95), suffix overlap (0.80), hand-curated
    cross-system bridges (po_number → PONUMBER etc., 0.85). NewMedCo
    storyboard hits the bridge path in particular."""
    out: list[MappingSuggestion] = []
    target_by_name = {f.get("name"): f for f in target_fields if f.get("name")}

    bridges = {
        "po_number": ["PONUMBER", "external_id", "idempotency_key", "remote_id"],
        "receipt_id": ["external_id", "remote_id"],
        "vendor_id": ["VENDORID", "external_id", "remote_id"],
        "invoice_number": ["RECORDID"],
        "method": ["PAYMENTMETHOD"],
        "amount": ["PAYMENTAMOUNT"],
        "id": ["external_id", "remote_id", "id"],
    }

    for sf in source_fields:
        sname = sf.get("name")
        if not sname:
            continue
        # Exact match
        if sname in target_by_name:
            out.append(MappingSuggestion(
                target_path=sname,
                source_expression=f"$.loop.item.{sname}",
                confidence=0.95,
                rationale=f"Exact name match on `{sname}`.",
                needs_review=False,
            ))
            continue
        # Bridge
        bridged = None
        for cand in bridges.get(sname, []):
            if cand in target_by_name:
                bridged = cand
                break
        if bridged:
            out.append(MappingSuggestion(
                target_path=bridged,
                source_expression=f"$.loop.item.{sname}",
                confidence=0.85,
                rationale=f"Cross-system bridge: `{sname}` ↔ `{bridged}`.",
                needs_review=True,
            ))
            continue
        # Suffix overlap (e.g. amount ↔ unit_amount)
        for tname in target_by_name:
            if not tname:
                continue
            sn = sname.lower()
            tn = tname.lower()
            if (sn.endswith(tn) or tn.endswith(sn)) and sn != tn:
                out.append(MappingSuggestion(
                    target_path=tname,
                    source_expression=f"$.loop.item.{sname}",
                    confidence=0.75,
                    rationale=f"Suffix overlap: `{sname}` ~ `{tname}`.",
                    needs_review=True,
                ))
                break
    return out
