"""
Populate `OpenAPISpec.entity_schemas` per entity type.

The diagram editor's ObjectPanel needs to ask "what fields does
PurchaseOrder have?" without re-walking the spec on every click. We
pre-resolve at spec-save time and cache the result on the OpenAPISpec
row.

Output shape (per entity):
  {
    "jsonSchema": <fully-resolved JSON Schema dict>,
    "samplePath": "/developer/v1/purchase-orders",   # collection GET
    "createPath": "/developer/v1/purchase-orders",   # POST
    "enums":      {"<dotted.path>": ["VAL1","VAL2"]},
    "formats":    {"<dotted.path>": "date-time"},
    "required":   ["id", "vendor_id", ...],
    "refs":       {"<dotted.path>": "<entity_type>"},
    "fields":     [<FieldSpec dict>...],               # for the inspector grid
  }
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Optional

from app.services.openapi_resolver import (
    FieldSpec,
    resolve_refs,
    walk_schema,
)
from app.services.openapi_ingest import _entity_type_from_path, _is_collection_path


def _ref_targets(schema: Any, path: str = "") -> dict[str, str]:
    """Walk a (raw, pre-resolve) schema and collect dotted-path → ref-target
    pairs so the deep loader's cross-record threading knows which leaves
    point to which entity-type bank.
    """
    out: dict[str, str] = {}
    if not isinstance(schema, dict):
        return out
    # Top-level ref
    if "$ref" in schema:
        ref = schema["$ref"]
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            out[path] = ref.rsplit("/", 1)[-1]
        return out
    t = schema.get("type")
    if t == "object" or "properties" in schema:
        for k, v in (schema.get("properties") or {}).items():
            sub = f"{path}.{k}" if path else k
            out.update(_ref_targets(v, sub))
    elif t == "array" or "items" in schema:
        items = schema.get("items") or {}
        out.update(_ref_targets(items, f"{path}[]"))
    return out


def _entity_paths_from_spec(spec: dict) -> dict[str, dict[str, str]]:
    """Group operations by entity type → {samplePath, createPath}."""
    by_entity: dict[str, dict[str, str]] = {}
    paths = spec.get("paths", {}) or {}
    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        entity_type = _entity_type_from_path(path)
        if not entity_type:
            continue
        is_coll = _is_collection_path(path)
        for verb in ("get", "post"):
            op = methods.get(verb)
            if not isinstance(op, dict):
                continue
            slot = by_entity.setdefault(entity_type, {})
            if verb == "get" and is_coll and "samplePath" not in slot:
                slot["samplePath"] = path
            if verb == "post" and is_coll and "createPath" not in slot:
                slot["createPath"] = path
    return by_entity


def _response_schema_for_op(spec: dict, op: dict) -> Any:
    """Return the raw (un-resolved) schema dict for the operation's 200/201
    response, or {} if absent. We keep it raw so `_ref_targets` can
    introspect refs."""
    responses = op.get("responses") or {}
    for code in ("200", "201", "default"):
        candidate = responses.get(code)
        if isinstance(candidate, dict):
            content = (candidate.get("content") or {}).get("application/json") or {}
            schema = content.get("schema")
            if schema:
                return schema
    return {}


def populate_entity_schemas(spec: dict) -> dict[str, Any]:
    """Produce the `entity_schemas` dict for an OpenAPI spec."""
    paths = spec.get("paths", {}) or {}
    by_entity_paths = _entity_paths_from_spec(spec)

    entity_schemas: dict[str, Any] = {}
    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        entity_type = _entity_type_from_path(path)
        if not entity_type:
            continue
        if not _is_collection_path(path):
            continue
        get_op = methods.get("get")
        if not isinstance(get_op, dict):
            continue
        if entity_type in entity_schemas:
            continue

        raw_response_schema = _response_schema_for_op(spec, get_op)
        # Unwrap one level of paginated envelope when present
        # (Ramp's PaginatedResponseApiBillResourceSchema → its items shape).
        item_raw_schema = _unwrap_envelope_raw(spec, raw_response_schema)
        resolved = resolve_refs(spec, item_raw_schema)
        field_specs: list[FieldSpec] = walk_schema(resolved)

        enums: dict[str, list[Any]] = {}
        formats: dict[str, str] = {}
        required: list[str] = []
        for fs in field_specs:
            if fs.enum_values:
                enums[fs.path] = list(fs.enum_values)
            if fs.format:
                formats[fs.path] = fs.format
            if fs.required:
                required.append(fs.path)

        refs = _ref_targets(item_raw_schema)
        # Normalise ref target component names → entity types via path scan.
        # For now, expose raw ref name; callers (synthesizer threading) map
        # by lowercasing + singularising the path component.

        paths_for_entity = by_entity_paths.get(entity_type, {})

        entity_schemas[entity_type] = {
            "jsonSchema": resolved,
            "samplePath": paths_for_entity.get("samplePath") or path,
            "createPath": paths_for_entity.get("createPath"),
            "enums": enums,
            "formats": formats,
            "required": required,
            "refs": refs,
            "fields": [asdict(fs) for fs in field_specs],
        }

    return entity_schemas


def _unwrap_envelope_raw(spec: dict, schema: Any) -> Any:
    """For a response schema that's a paginated wrapper (e.g.
    `PaginatedResponseApiBillResourceSchema` with `data: [...]`), return
    the item schema so callers walk the record shape directly, not the
    envelope."""
    if not isinstance(schema, dict):
        return schema
    if "$ref" in schema:
        resolved = resolve_refs(spec, schema)
        return _unwrap_envelope_raw(spec, resolved)
    props = schema.get("properties") or {}
    for envelope_key in ("data", "items", "results"):
        nested = props.get(envelope_key) or {}
        if isinstance(nested, dict):
            if nested.get("type") == "array":
                items = nested.get("items") or {}
                if "$ref" in items:
                    return items  # let caller resolve
                return items
            if "$ref" in nested:
                return nested
    return schema
