"""
Whole-diagram discovery-question generator using Claude Haiku.

The "secret weapon" surface — the topbar's small readiness pip opens this.
Six sharp questions a savvy consultant should be asking the client RIGHT
NOW. Falls back to NewMedCo-flavoured pre-canned questions if the live
call fails (mirrors `design_handoff_workflow_builder/src/ai-gap.jsx`'s
FALLBACK_QUESTIONS).
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.agents import HAIKU
from app.config import settings


FALLBACK_QUESTIONS: list[dict[str, str]] = [
    {"tag": "volume", "q": "How many POs does NewMedCo create per month today, and what's the peak day during quarter-close?"},
    {"tag": "ownership", "q": "If a PO is edited in Oro after it's been pushed to Ramp, who owns the conflict resolution — Oro or AP review?"},
    {"tag": "failure handling", "q": "When Sage rejects a bill (closed period, missing GL account), should we hold it in Ramp or auto-reroute it for re-coding?"},
    {"tag": "org structure", "q": "Does NewMedCo run multiple Sage entities, and does Ramp need to map POs to a specific entity based on the requester or location?"},
    {"tag": "cutover", "q": "For the migration, do you want historical Oro POs back-loaded into Ramp, or only forward-going? And from what date?"},
    {"tag": "compliance", "q": "What's your audit requirement — do auditors need to see the source Oro PO ID on every Ramp bill, or is the match-trail in Ramp sufficient?"},
]


async def suggest_questions(doc: dict) -> dict:
    """Call Haiku with a serialized diagram, return {questions, cached:False, source}.

    Always falls back to FALLBACK_QUESTIONS on any error so the demo's
    "secret weapon" beat never dies."""
    api_key = getattr(settings, "anthropic_api_key", None) or ""
    if not api_key:
        return {"questions": FALLBACK_QUESTIONS, "cached": False, "source": "fallback"}
    summary = _serialize_scenario(doc)
    prompt = (
        "You are coaching a Ramp Technical Consultant who is LIVE on a discovery call "
        f"with the customer. They've drawn this integration diagram so far:\n\n{summary}\n\n"
        "Generate 6 SHARP, SPECIFIC discovery questions the consultant should ask the "
        "customer RIGHT NOW to close gaps in this diagram. Questions should be:\n"
        "- Phrased exactly as the consultant would say them (conversational, not robotic)\n"
        "- Specific to artifacts in the diagram (not generic)\n"
        "- Cover different gap categories: data ownership / volume & scale / failure "
        "handling / org structure / compliance / cutover\n\n"
        'Return ONLY a JSON array. Each item: { "tag": "<category lowercase, 1-2 words>", '
        '"q": "<question>" }. No prose, no code fence.'
    )
    try:
        from anthropic import Anthropic

        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=HAIKU,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        text = ""
        for block in response.content:
            if getattr(block, "type", None) == "text":
                text = block.text
                break
        cleaned = re.sub(r"^```(?:json)?", "", text.strip()).rstrip("`").strip()
        parsed = _parse_json_array(cleaned)
        if not isinstance(parsed, list) or not parsed:
            raise ValueError("model returned empty or non-list")
        return {"questions": parsed, "cached": False, "source": "live"}
    except Exception:
        return {"questions": FALLBACK_QUESTIONS, "cached": False, "source": "fallback"}


def _parse_json_array(text: str) -> Any:
    """Best-effort JSON array extraction (the model sometimes wraps with
    prose despite instructions)."""
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\[[\s\S]*\]", text)
        if m:
            return json.loads(m.group(0))
        raise


def _serialize_scenario(doc: dict) -> str:
    """Port of `design_handoff_workflow_builder/src/ai-gap.jsx:serializeScenario`."""
    lines: list[str] = []
    lines.append(f"Client: {doc.get('client') or '(unknown)'}")
    if doc.get("goal"):
        lines.append(f"Goal: {doc['goal']}")
    lines.append("\nSystems:")
    for s in doc.get("systems") or []:
        lines.append(f"  - {s.get('label')} ({s.get('role')}) · env={s.get('env')}")
    lines.append("\nObjects:")
    for o in doc.get("objects") or []:
        lines.append(
            f"  - {o.get('system')}.{o.get('label')} [{o.get('kind')}] · "
            f"{len(o.get('fields') or [])} fields · sample={o.get('sample')}"
        )
    lines.append("\nFlows:")
    for f in doc.get("flows") or []:
        native = " · NATIVE" if f.get("native") else ""
        lines.append(
            f"  - {f.get('from')} → {f.get('to')} · {f.get('direction')}/{f.get('mode')} · "
            f"{f.get('role')} · {f.get('cadence')} · mapped={f.get('mapped')}/{f.get('total')}{native}"
        )
    lines.append("\nError guards:")
    for e in doc.get("edges") or []:
        lines.append(f"  - {e.get('kind')}: {e.get('label')} → {e.get('detail')}")
    return "\n".join(lines)
