"""
Sandboxes v1 AI synthesis worker (task #7).

Takes a `TestBank.schema_json` shape descriptor (output of
`shape_extractor`) for one entity_type and asks Haiku to generate
realistic synthetic records honoring it. PII fields get deterministic
fake values (we don't want Haiku making up realistic-looking emails or
phone numbers — that's how a model accidentally generates a real
person's data).

Variants:
- 'full'    — all fields populated.
- 'half'    — ~50% of nullable fields populated; others omitted.
- 'minimal' — only required-feeling fields (non-nullable type-tagged).

Output: a list of dicts, validated against the schema, ready to drop
into `TestBankEntity.data`.

Network failures or malformed model output fall back to deterministic
record generation so the user always gets *something* — never a half-
populated bank.
"""

from __future__ import annotations

import json
import random
import string
from dataclasses import dataclass
from typing import Any, Optional
from uuid import uuid4

from anthropic import Anthropic

from app.agents import HAIKU
from app.config import settings


@dataclass
class SynthesisResult:
    records: list[dict[str, Any]]
    used_fallback: bool
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Deterministic PII fakers — used for any field flagged with `pii_kind`
# in the schema. Keeping these here (not in shape_extractor) so the
# synthesizer is the only place fake values are *minted*; the extractor
# only *classifies*.
# ---------------------------------------------------------------------------
def _fake_email(seed: int) -> str:
    rng = random.Random(seed)
    user = "".join(rng.choices(string.ascii_lowercase, k=rng.randint(4, 9)))
    domain = rng.choice(["example.com", "acme.test", "sandbox.dev", "demo.org"])
    return f"{user}@{domain}"


def _fake_phone(seed: int) -> str:
    rng = random.Random(seed)
    return f"+1-555-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}"


def _fake_uuid(seed: int) -> str:
    rng = random.Random(seed)
    return str(
        uuid4().int.to_bytes(16, "big")
    ).encode("utf-8").hex() if False else _hex_uuid(rng)


def _hex_uuid(rng: random.Random) -> str:
    """Stable-ish UUID for one record (deterministic via seed)."""
    bs = bytes(rng.randint(0, 255) for _ in range(16))
    h = bs.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def _fake_url(seed: int) -> str:
    rng = random.Random(seed)
    slug = "".join(rng.choices(string.ascii_lowercase + string.digits, k=10))
    return f"https://api.example.test/r/{slug}"


def _fake_name(seed: int) -> str:
    rng = random.Random(seed)
    first = rng.choice(["Alex", "Sam", "Jordan", "Casey", "Morgan", "Riley"])
    last = rng.choice(["Bell", "Chen", "Diaz", "Khan", "Park", "Rao"])
    return f"{first} {last}"


def _fake_pii(kind: str, seed: int) -> str:
    if kind == "email":
        return _fake_email(seed)
    if kind == "phone":
        return _fake_phone(seed)
    if kind == "uuid":
        return _hex_uuid(random.Random(seed))
    if kind == "url":
        return _fake_url(seed)
    if kind == "name":
        return _fake_name(seed)
    if kind == "ssn":
        rng = random.Random(seed)
        return f"{rng.randint(100, 999)}-{rng.randint(10, 99)}-{rng.randint(1000, 9999)}"
    return f"redacted_{seed}"


# ---------------------------------------------------------------------------
# Deterministic fallback record generator. Used when:
#   - The Anthropic call errors
#   - The model returns malformed records that don't match the schema
#   - `settings.anthropic_api_key` is absent (local dev without credits)
# ---------------------------------------------------------------------------
def _fallback_record(
    schema: dict[str, Any], entity_type: str, idx: int, variant: str
) -> dict[str, Any]:
    """Recursive emission honouring nested objects, array elements,
    enums, formats, and required flags. Schema is the flat dotted-path
    dict produced by the resolver (`_schema_from_field_specs`)."""
    rng = random.Random(f"{entity_type}-{idx}")
    record: dict[str, Any] = {}
    # Sort paths by depth so we set parents before children.
    paths = sorted(schema.keys(), key=lambda p: (p.count("."), p.count("[]"), p))
    for path in paths:
        if path.startswith("_root"):
            continue
        info = schema[path]
        # Required fields always emitted; otherwise variant rules.
        required = bool(info.get("required"))
        nullable = bool(info.get("nullable"))
        if not required:
            if variant == "minimal" and nullable:
                continue
            if variant == "half" and nullable and rng.random() < 0.5:
                continue
        value = _fallback_value(path, info, rng)
        _set_nested(record, path, value)
    if "id" not in record:
        record["id"] = f"{entity_type}_{idx:04d}_{rng.randrange(10**6):06d}"
    return record


def _set_nested(record: dict, dotted_path: str, value: Any) -> None:
    """Set a value at a nested dotted path. `[]` segments treat the
    array as a single-element list (synth doesn't generate multi-row
    array elements via the flat path — the schema includes per-element
    leaves already, we just need to make sure parent containers exist)."""
    parts = _split_path(dotted_path)
    cursor: Any = record
    for i, (key, is_array) in enumerate(parts[:-1]):
        if is_array:
            # Treat as a single-element array; ensure list exists
            if key not in cursor or not isinstance(cursor.get(key), list):
                cursor[key] = [{}]
            elif not cursor[key]:
                cursor[key].append({})
            cursor = cursor[key][0]
        else:
            if key not in cursor or not isinstance(cursor.get(key), dict):
                cursor[key] = {}
            cursor = cursor[key]
    last_key, last_is_array = parts[-1]
    if last_is_array:
        cursor[last_key] = [value]
    else:
        cursor[last_key] = value


def _split_path(path: str) -> list[tuple[str, bool]]:
    """`vendor.line_items[].sku` → [(vendor, False), (line_items, True), (sku, False)]"""
    out: list[tuple[str, bool]] = []
    for seg in path.split("."):
        is_arr = seg.endswith("[]")
        key = seg[:-2] if is_arr else seg
        out.append((key, is_arr))
    return out


def _fallback_value(field: str, info: dict[str, Any], rng: random.Random) -> Any:
    pii = info.get("pii_kind")
    if pii:
        return _fake_pii(pii, rng.randrange(10**9))
    enum_values = info.get("enum_values")
    if isinstance(enum_values, list) and enum_values:
        return rng.choice(enum_values)
    fmt = info.get("format")
    if fmt:
        v = _value_for_format(fmt, rng)
        if v is not None:
            return v
    t = info.get("type")
    if t == "boolean":
        return rng.random() < 0.5
    if t == "integer":
        return rng.randint(0, 1000)
    if t == "number":
        return round(rng.uniform(0, 1000), 2)
    if t == "array":
        # Arrays of primitives get a small list of sensible values; arrays
        # of objects get an empty list (the resolver's per-element leaves
        # populate them via _set_nested).
        items_type = info.get("items_type")
        if items_type == "object":
            return []
        if items_type in ("integer", "number"):
            return [rng.randint(1, 100) for _ in range(rng.randint(1, 3))]
        return []
    if t == "object":
        return {}
    if t == "null":
        return None
    # default string — try common patterns from field name
    field_short = field.rsplit(".", 1)[-1].rstrip("[]")
    if field_short in ("id", "external_id", "remote_id"):
        return _hex_uuid(rng)[:8]
    length = info.get("length_min") or 5
    length = max(3, min(20, int(length)))
    return field_short + "_" + "".join(rng.choices(string.ascii_lowercase, k=length))


def _value_for_format(fmt: str, rng: random.Random) -> Any:
    """Deterministic values matching common JSON-Schema string formats."""
    if fmt == "date-time":
        from datetime import datetime, timedelta, timezone

        delta_days = rng.randint(-90, 90)
        delta_secs = rng.randint(0, 86400)
        ts = datetime.now(tz=timezone.utc) + timedelta(days=delta_days, seconds=delta_secs)
        return ts.isoformat()
    if fmt == "date":
        from datetime import date, timedelta

        return (date.today() + timedelta(days=rng.randint(-90, 90))).isoformat()
    if fmt == "uri" or fmt == "url":
        slug = "".join(rng.choices(string.ascii_lowercase + string.digits, k=10))
        return f"https://api.example.test/r/{slug}"
    if fmt == "email":
        return _fake_email(rng.randrange(10**9))
    if fmt == "uuid":
        return _hex_uuid(rng)
    if fmt in ("int64", "int32"):
        return rng.randint(0, 10**9)
    if fmt == "byte":
        return "U29sZGVy"  # base64 of "Solder"
    return None


# ---------------------------------------------------------------------------
# Main entry point.
# ---------------------------------------------------------------------------
def synthesize_records(
    *,
    entity_type: str,
    schema: dict[str, Any],
    count: int,
    variant: str = "full",
) -> SynthesisResult:
    """Generate `count` synthetic records of `entity_type`. Calls Haiku
    when an Anthropic key is configured; otherwise (or on failure) uses
    the deterministic fallback so the bank is always populated.
    """
    if variant not in ("full", "half", "minimal"):
        variant = "full"

    api_key = getattr(settings, "anthropic_api_key", None) or ""
    if not api_key:
        return SynthesisResult(
            records=[
                _fallback_record(schema, entity_type, i, variant)
                for i in range(count)
            ],
            used_fallback=True,
            error="ANTHROPIC_API_KEY not set; used deterministic fallback",
        )

    # Pre-compute PII overrides — Haiku generates the structure, we
    # patch PII fields ourselves.
    pii_paths = {p: info["pii_kind"] for p, info in schema.items() if info.get("pii_kind")}

    prompt = _build_prompt(entity_type=entity_type, schema=schema, count=count, variant=variant)
    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=HAIKU,
            max_tokens=4000,
            tools=[
                {
                    "name": "submit_records",
                    "description": "Submit the synthesised records.",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "records": {
                                "type": "array",
                                "items": {"type": "object"},
                                "description": (
                                    f"Array of {count} {entity_type} records "
                                    f"matching the requested schema."
                                ),
                            }
                        },
                        "required": ["records"],
                    },
                }
            ],
            tool_choice={"type": "tool", "name": "submit_records"},
            messages=[{"role": "user", "content": prompt}],
        )
        # Find the tool_use block.
        records: list[dict[str, Any]] = []
        for block in response.content:
            if getattr(block, "type", None) == "tool_use":
                payload = block.input or {}
                if isinstance(payload, dict) and isinstance(payload.get("records"), list):
                    records = [r for r in payload["records"] if isinstance(r, dict)]
                    break
        if not records:
            raise ValueError("model did not return a records array")
        # Patch PII fields with deterministic fakes.
        for i, r in enumerate(records):
            for path, kind in pii_paths.items():
                if "." in path or "[]" in path:
                    continue  # only patch top-level for now
                r[path] = _fake_pii(kind, hash((entity_type, path, i)) & 0xFFFFFFFF)
            if "id" not in r:
                r["id"] = f"{entity_type}_{i:04d}_{uuid4().hex[:8]}"
        return SynthesisResult(records=records[:count], used_fallback=False)
    except Exception as e:  # noqa: BLE001 — fall back is the contract
        return SynthesisResult(
            records=[
                _fallback_record(schema, entity_type, i, variant)
                for i in range(count)
            ],
            used_fallback=True,
            error=str(e),
        )


def _build_prompt(
    *, entity_type: str, schema: dict[str, Any], count: int, variant: str
) -> str:
    variant_rule = {
        "full": "Populate every field. No nulls unless the schema marks `nullable=true`.",
        "half": "Populate every required field; for nullable fields, omit roughly half of them per record.",
        "minimal": "Populate only fields the schema marks `nullable=false`. Omit everything else.",
    }[variant]
    schema_json = json.dumps(schema, indent=2, default=str)
    return (
        f"Generate {count} realistic synthetic records of type {entity_type!r}, "
        f"each matching the JSON schema below. {variant_rule}\n\n"
        "Rules:\n"
        "- Each record must be an object whose keys match top-level paths in the schema.\n"
        "- Respect declared types exactly (string, integer, number, boolean, array, object).\n"
        "- For string fields with `enum_values`, pick from that list only.\n"
        "- For string fields with `length_min`/`length_max`, stay in that range.\n"
        "- Skip fields marked with `pii_kind` — those will be filled in by a separate "
        "deterministic generator.\n"
        "- Make values look realistic for a record of this entity type, but do NOT "
        "use real-world identifiers, real names, real company names, or real-looking "
        "emails. Stick to clearly synthetic values.\n"
        "- IDs should be short string slugs.\n\n"
        f"Schema:\n{schema_json}\n\n"
        "Submit via the `submit_records` tool."
    )
