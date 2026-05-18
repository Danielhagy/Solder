"""
OpenAPI spec deep-extraction primitives.

The existing `openapi_ingest.py` extracts at most one inline example per
operation. Confirmed against the bundled Ramp spec
(`ramp-procurement.json`): that approach finds ZERO examples because Ramp
puts every example on the COMPONENT (`components.schemas.<Name>.example`),
and 60 of 71 operations `$ref` into components.

This module does the deep walk: resolves `$ref` recursively (with cycle
detection), collects EVERY example available, and produces a flat
FieldSpec list per leaf with enum + format + required + description.

Output is consumed by:
  - `openapi_ingest.deep_reseed_connection` (TestBank population)
  - `ai_synthesizer.synthesize_records` (synth prompt context)
  - `entity_resolver.populate_entity_schemas` (per-entity catalog for
    the process-diagram editor)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Optional


# Avoid runaway resolution on cyclic specs. Ramp's procurement spec
# has nesting up to ~7 levels for Bill.inventory_line_items[]; 50 is
# the safety net that catches real cycles without truncating valid
# deep paths.
_MAX_REF_DEPTH = 50


def resolve_refs(
    spec: dict, schema_or_ref: Any, _depth: int = 0, _seen: Optional[set[str]] = None
) -> Any:
    """Recursively resolve `$ref` against the spec's components.

    Walks every key. `_seen` carries the set of refs in the current
    resolution chain so a self-referential schema (e.g. a Tree node that
    refs itself) doesn't loop forever — when we hit a ref already in the
    chain, we return an `_circular_ref` sentinel that downstream walkers
    treat as a generic object.
    """
    if _depth > _MAX_REF_DEPTH:
        return {"_truncated_at_depth": _depth}
    if not isinstance(schema_or_ref, (dict, list)):
        return schema_or_ref
    _seen = _seen or set()
    if isinstance(schema_or_ref, list):
        return [resolve_refs(spec, item, _depth + 1, _seen) for item in schema_or_ref]

    if "$ref" in schema_or_ref:
        ref = schema_or_ref["$ref"]
        if ref in _seen:
            return {"_circular_ref": ref}
        # Navigate `#/components/schemas/Bill` style
        if not ref.startswith("#/"):
            return {"_external_ref": ref}
        parts = ref[2:].split("/")
        target: Any = spec
        for p in parts:
            if not isinstance(target, dict) or p not in target:
                return {"_missing_ref": ref}
            target = target[p]
        # Resolve the target itself in case it $refs further.
        return resolve_refs(spec, target, _depth + 1, _seen | {ref})

    # Plain dict — walk every value
    out: dict[str, Any] = {}
    for k, v in schema_or_ref.items():
        out[k] = resolve_refs(spec, v, _depth + 1, _seen)
    return out


@dataclass
class FieldSpec:
    """One leaf or branch in a resolved schema.

    `path` uses dotted notation with `[]` suffix for array element types:
      'id'                       — top-level scalar
      'vendor.remote_id'         — nested object field
      'line_items[]'             — array of primitives (or marker for array of objects)
      'line_items[].amount.amount' — leaf inside an array-of-object
    """

    path: str
    type: str  # 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'unknown'
    format: Optional[str] = None  # 'date-time' | 'uri' | 'email' | 'uuid' | 'int64' | ...
    enum_values: Optional[list[Any]] = None
    required: bool = False
    nullable: bool = False
    description: Optional[str] = None
    example: Any = None
    # For type=object, names of nested keys (for navigation, not full re-walking).
    properties_keys: Optional[list[str]] = None
    # For arrays, the type of the element (or 'object' if structured).
    items_type: Optional[str] = None
    # If this leaf carries a $ref to another component schema (e.g. Bill.vendor
    # references the Vendor schema), `ref_name` is the un-prefixed name —
    # used by cross-record threading to substitute foreign keys with actual
    # ids from the bank.
    ref_name: Optional[str] = None
    # min/max constraints if present (numbers, strings, arrays)
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    min_length: Optional[int] = None
    max_length: Optional[int] = None
    pattern: Optional[str] = None


def walk_schema(
    resolved: Any, path: str = "", required_at_parent: Optional[list[str]] = None
) -> list[FieldSpec]:
    """Walk a resolved schema (no $refs left, or _circular_ref sentinels)
    and emit one FieldSpec per leaf + per nested branch.

    `required_at_parent` is the parent's `required` array — used to flag
    the current field as required when its key is in it.
    """
    if not isinstance(resolved, dict):
        return []

    # Determine this node's type. Handle `oneOf`/`anyOf`/`allOf` by picking
    # the first concrete schema — good enough for synth + mapping.
    schema = resolved
    for combinator in ("oneOf", "anyOf", "allOf"):
        if combinator in schema and isinstance(schema[combinator], list) and schema[combinator]:
            # For allOf, merge property dicts; for oneOf/anyOf, take the first.
            if combinator == "allOf":
                merged: dict[str, Any] = {}
                for sub in schema[combinator]:
                    if isinstance(sub, dict):
                        if "properties" in sub:
                            merged.setdefault("properties", {}).update(sub["properties"])
                        if "required" in sub:
                            merged.setdefault("required", []).extend(sub["required"])
                        for k, v in sub.items():
                            if k not in ("properties", "required"):
                                merged.setdefault(k, v)
                schema = {**schema, **merged}
            else:
                schema = {**schema, **schema[combinator][0]} if isinstance(schema[combinator][0], dict) else schema
            break

    t = schema.get("type")
    # Sometimes type is missing but `properties` is present — treat as object.
    if t is None:
        if "properties" in schema:
            t = "object"
        elif "items" in schema:
            t = "array"
        else:
            t = "unknown"

    nullable = bool(schema.get("nullable")) or t == "null"
    description = schema.get("description")
    example = schema.get("example")
    ref_name = _ref_name_from(resolved)
    is_required = bool(required_at_parent and path.rsplit(".", 1)[-1].rstrip("[]") in (required_at_parent or []))

    specs: list[FieldSpec] = []

    if t == "object":
        props = schema.get("properties") or {}
        prop_keys = list(props.keys())
        required_here = schema.get("required") or []
        # Emit a branch entry for the object itself if we're nested.
        if path:
            specs.append(FieldSpec(
                path=path, type="object", required=is_required, nullable=nullable,
                description=description, properties_keys=prop_keys, ref_name=ref_name,
            ))
        for key, sub_schema in props.items():
            sub_path = f"{path}.{key}" if path else key
            specs.extend(walk_schema(sub_schema, sub_path, required_here))
    elif t == "array":
        items = schema.get("items") or {}
        item_type = (items.get("type") if isinstance(items, dict) else None) or "unknown"
        if isinstance(items, dict) and "properties" in items:
            item_type = "object"
        specs.append(FieldSpec(
            path=path, type="array", required=is_required, nullable=nullable,
            description=description, items_type=item_type, ref_name=ref_name,
            example=example,
        ))
        # Recurse into element shape; mark sub-fields with `[]` to keep
        # the path unambiguous when arrays of objects flatten.
        if item_type == "object":
            specs.extend(walk_schema(items, f"{path}[]"))
    else:
        # Leaf
        specs.append(FieldSpec(
            path=path,
            type=str(t),
            format=schema.get("format"),
            enum_values=schema.get("enum"),
            required=is_required,
            nullable=nullable,
            description=description,
            example=example,
            ref_name=ref_name,
            minimum=_safe_num(schema.get("minimum")),
            maximum=_safe_num(schema.get("maximum")),
            min_length=_safe_int(schema.get("minLength")),
            max_length=_safe_int(schema.get("maxLength")),
            pattern=schema.get("pattern"),
        ))

    return specs


def _safe_num(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _safe_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _ref_name_from(schema_with_possible_ref: Any) -> Optional[str]:
    """If the original (pre-resolve) schema was a `$ref` to a component,
    return the component's un-prefixed name. Used by cross-record
    threading. The resolver loses the ref by definition, so callers
    that need this should pass the original unresolved schema in.

    For schemas that were resolved with our resolver, ref_name is None
    here — callers track refs separately via a small companion map.
    """
    return None  # placeholder; set by callers that track refs explicitly


# ── Example collection ─────────────────────────────────────────────────


def collect_all_examples(spec: dict, op: dict) -> list[Any]:
    """Pull EVERY example available for one operation, deduplicated by
    record hash. Source priority (all merged, not first-wins):

      1. responses.<code>.content.application/json.example for codes
         200, 201, 202, default (every successful code, not just first)
      2. responses.<code>.content.application/json.examples.*.value
         (all named examples)
      3. responses.<code>.content.application/json.schema.example
      4. Resolved-$ref component's `example` field
      5. Resolved-$ref component's `examples` array
    """
    out: list[Any] = []
    seen_hashes: set[str] = set()

    def _push(ex: Any) -> None:
        if ex is None:
            return
        try:
            h = hashlib.sha1(
                json.dumps(ex, sort_keys=True, default=str).encode()
            ).hexdigest()
        except Exception:
            h = str(id(ex))
        if h in seen_hashes:
            return
        seen_hashes.add(h)
        out.append(ex)

    responses = op.get("responses") or {}
    for code in ("200", "201", "202", "default"):
        candidate = responses.get(code)
        if not isinstance(candidate, dict):
            continue
        content = (candidate.get("content") or {}).get("application/json") or {}

        # Source 1 — inline example (singular)
        if "example" in content:
            _push(content["example"])

        # Source 2 — inline examples (plural, named)
        examples = content.get("examples") or {}
        if isinstance(examples, dict):
            for named in examples.values():
                if isinstance(named, dict) and "value" in named:
                    _push(named["value"])

        # Source 3 — schema.example (inline schema)
        schema = content.get("schema") or {}
        if isinstance(schema, dict) and "example" in schema:
            _push(schema["example"])

        # Source 4 + 5 — resolve $ref and pull its example fields
        if isinstance(schema, dict) and "$ref" in schema:
            resolved = resolve_refs(spec, schema)
            if isinstance(resolved, dict):
                if "example" in resolved:
                    _push(resolved["example"])
                comp_examples = resolved.get("examples")
                if isinstance(comp_examples, list):
                    for ex in comp_examples:
                        _push(ex)
                # Some specs nest example inside `properties.data.items` etc.
                # — collect the schema's example one level into common envelopes.
                for envelope_key in ("data", "items", "results"):
                    nested = (
                        (resolved.get("properties") or {})
                        .get(envelope_key) or {}
                    )
                    if isinstance(nested, dict):
                        if "example" in nested:
                            _push(nested["example"])
                        # If `data` is an array whose items have an example,
                        # pull each item.
                        if nested.get("type") == "array":
                            items = nested.get("items") or {}
                            if isinstance(items, dict):
                                if "example" in items:
                                    _push(items["example"])

    return out


def unwrap_envelope(example: Any, entity_type: str) -> list[Any]:
    """Pull individual records from a paginated envelope. APIs commonly
    wrap collections as `{data: [...]}` / `{items: [...]}` /
    `{results: [...]}` / `{<entity_type>s: [...]}`. If the example is a
    bare record, returns `[example]`. If a bare list, returns the list.
    Filters non-dict elements.
    """
    if isinstance(example, dict):
        for key in ("data", "items", "results", f"{entity_type}s"):
            value = example.get(key)
            if isinstance(value, list):
                return [r for r in value if isinstance(r, dict)]
        # Bare record
        return [example]
    if isinstance(example, list):
        return [r for r in example if isinstance(r, dict)]
    return []


def collect_records_for_op(spec: dict, op: dict, entity_type: str) -> list[dict]:
    """Convenience: every individual record extractable from an operation's
    responses, with envelopes unwrapped + deduped."""
    out: list[dict] = []
    seen: set[str] = set()
    for example in collect_all_examples(spec, op):
        for rec in unwrap_envelope(example, entity_type):
            try:
                h = hashlib.sha1(
                    json.dumps(rec, sort_keys=True, default=str).encode()
                ).hexdigest()
            except Exception:
                h = str(id(rec))
            if h not in seen:
                seen.add(h)
                out.append(rec)
    return out


# ── Per-operation request body extraction ──────────────────────────────


def required_fields_from_request_body(spec: dict, op: dict) -> list[str]:
    """Pulls `required` array from a resolved request body schema."""
    body = op.get("requestBody") or {}
    content = (body.get("content") or {}).get("application/json") or {}
    schema = content.get("schema") or {}
    if isinstance(schema, dict) and "$ref" in schema:
        schema = resolve_refs(spec, schema)
    if isinstance(schema, dict):
        req = schema.get("required") or []
        return list(req) if isinstance(req, list) else []
    return []


def collect_request_body_examples(spec: dict, op: dict) -> list[Any]:
    """Same shape as `collect_all_examples` but for request bodies. Used
    to populate the canonical write shape for transform defaults."""
    out: list[Any] = []
    seen: set[str] = set()

    def _push(ex: Any) -> None:
        if ex is None:
            return
        try:
            h = hashlib.sha1(
                json.dumps(ex, sort_keys=True, default=str).encode()
            ).hexdigest()
        except Exception:
            h = str(id(ex))
        if h in seen:
            return
        seen.add(h)
        out.append(ex)

    body = op.get("requestBody") or {}
    content = (body.get("content") or {}).get("application/json") or {}
    if "example" in content:
        _push(content["example"])
    examples = content.get("examples") or {}
    if isinstance(examples, dict):
        for named in examples.values():
            if isinstance(named, dict) and "value" in named:
                _push(named["value"])
    schema = content.get("schema") or {}
    if isinstance(schema, dict):
        if "$ref" in schema:
            resolved = resolve_refs(spec, schema)
            if isinstance(resolved, dict) and "example" in resolved:
                _push(resolved["example"])
        elif "example" in schema:
            _push(schema["example"])
    return out


# ── Error response shapes ─────────────────────────────────────────────


def collect_error_shapes(spec: dict, op: dict) -> dict[str, Any]:
    """Pulls every 4xx/5xx response example/schema. Used by the mock-
    engine's error_injector to surface realistic failure bodies.

    Returns: {"<code>": <example_dict>, ...}
    """
    out: dict[str, Any] = {}
    responses = op.get("responses") or {}
    for code, candidate in responses.items():
        try:
            code_int = int(code)
        except (TypeError, ValueError):
            continue
        if code_int < 400:
            continue
        if not isinstance(candidate, dict):
            continue
        content = (candidate.get("content") or {}).get("application/json") or {}
        if "example" in content:
            out[code] = content["example"]
            continue
        examples = content.get("examples") or {}
        if isinstance(examples, dict) and examples:
            first = next(iter(examples.values()))
            if isinstance(first, dict) and "value" in first:
                out[code] = first["value"]
                continue
        schema = content.get("schema") or {}
        if isinstance(schema, dict) and "$ref" in schema:
            resolved = resolve_refs(spec, schema)
            if isinstance(resolved, dict) and "example" in resolved:
                out[code] = resolved["example"]
                continue
        if isinstance(schema, dict) and "example" in schema:
            out[code] = schema["example"]
    return out
