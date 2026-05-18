"""
Sandboxes v1 OpenAPI ingest (task #5).

Scaffolds a synthetic-mode connection's `MockSpec` + `TestBank` from an
OpenAPI 3.x spec. The cheapest path to a usable sandbox: walk the spec's
paths, classify each operation (list_entities / get_entity /
create_entity), pull response examples for fallback shapes, and persist
both the spec routes and a seed bank.

What this does NOT do:
- Walk live data (that's the active probe — task #6)
- Synthesize new records (that's the AI synthesis worker — task #7)
- Run continuously (idempotent: replaces existing spec/bank for the
  connection on each call)

Provenance: every route entry carries `provenance='openapi'`; every
seeded entity is `is_golden=False` so the active probe + observed
traffic can graduate observed records into the golden slot later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Connection, Connector, MockSpec, OpenAPISpec, TestBank, TestBankEntity


@dataclass
class IngestResult:
    """Per-call summary so the UI can show what happened."""

    routes_added: int = 0
    entities_seeded: int = 0
    endpoints_seen: int = 0
    skipped: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Path classification heuristics. REST conventions vary, but the 80% case
# is `/v1/<resource>` (collection) or `/v1/<resource>/{id}` (single).
# ---------------------------------------------------------------------------
def _entity_type_from_path(path: str) -> Optional[str]:
    """Pull a singular entity type name from a REST path.

    Examples:
      `/v1/vendors`              → 'vendor'
      `/v1/vendors/{id}`         → 'vendor'
      `/api/v2/purchase-orders`  → 'purchase_order'
      `/v1/vendors/{id}/notes`   → 'note'
    """
    parts = [
        p
        for p in path.split("/")
        if p and not (p.startswith("{") and p.endswith("}"))
    ]
    if not parts:
        return None
    last = parts[-1]
    # naive depluralization — "vendors" → "vendor", "addresses" → "address"
    if last.endswith("ies"):
        last = last[:-3] + "y"
    elif last.endswith("ses"):
        last = last[:-2]
    elif last.endswith("s"):
        last = last[:-1]
    return last.replace("-", "_").lower()


def _is_collection_path(path: str) -> bool:
    """True if the path's terminal segment is a plural noun (not `{id}`)."""
    parts = path.rstrip("/").split("/")
    if not parts:
        return False
    last = parts[-1]
    return not (last.startswith("{") and last.endswith("}"))


def _required_fields_from_request_body(op: dict[str, Any]) -> list[str]:
    body = op.get("requestBody", {}) or {}
    content = body.get("content", {}) or {}
    json_content = content.get("application/json", {}) or {}
    schema = json_content.get("schema", {}) or {}
    required = schema.get("required", [])
    return list(required) if isinstance(required, list) else []


def _extract_example_from_response(op: dict[str, Any]) -> Optional[Any]:
    """Pull a 200/201 example. Falls through `example` → `examples.<first>.value`
    → `schema.example`."""
    responses = op.get("responses", {}) or {}
    success: Optional[dict[str, Any]] = None
    for code in ("200", "201", "default"):
        candidate = responses.get(code)
        if isinstance(candidate, dict):
            success = candidate
            break
    if success is None:
        return None
    content = success.get("content", {}) or {}
    json_content = content.get("application/json", {}) or {}
    if "example" in json_content:
        return json_content["example"]
    examples = json_content.get("examples", {}) or {}
    if examples:
        first = next(iter(examples.values()))
        if isinstance(first, dict) and "value" in first:
            return first["value"]
    schema = json_content.get("schema", {}) or {}
    if "example" in schema:
        return schema["example"]
    return None


def _flatten_record(example: Any, entity_type: str) -> Optional[dict[str, Any]]:
    """Pluck a single record from a paginated envelope.

    APIs typically wrap collections as `{data: [...], total}` or similar;
    callers want the inner record shape, not the envelope.
    """
    if isinstance(example, dict):
        for key in ("data", "items", "results", f"{entity_type}s"):
            value = example.get(key)
            if isinstance(value, list) and value and isinstance(value[0], dict):
                return value[0]
        return example
    if isinstance(example, list) and example and isinstance(example[0], dict):
        return example[0]
    return None


def _type_of(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return "unknown"


def _infer_schema(example: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Top-level field classification. Deeper structure (nested objects,
    array element types) is left to the shape extractor in task #7."""
    out: dict[str, dict[str, Any]] = {}
    for k, v in example.items():
        out[k] = {"type": _type_of(v), "nullable": v is None}
    return out


# ---------------------------------------------------------------------------
# Main entry point.
# ---------------------------------------------------------------------------
async def ingest_openapi_for_connection(
    db: AsyncSession,
    *,
    connection_id: str,
    spec_json: dict[str, Any],
    endpoint_allowlist: Optional[list[str]] = None,
) -> IngestResult:
    """Replace the connection's MockSpec + TestBank with an OpenAPI-derived
    scaffold. Returns a summary the UI can render.

    `endpoint_allowlist`, when provided, is a list of `"METHOD /path"`
    strings; any operation not in the set is dropped. Drives the
    "Sandbox from Spec" wizard's checkbox curation — users pick the
    procurement endpoints they care about, the rest stay invisible to
    the mock engine. Persisted to `connection.sandbox_config` so a
    later re-ingest from the same wizard preserves the picks.
    """
    connection = await db.get(Connection, connection_id)
    if connection is None:
        raise ValueError(f"connection {connection_id!r} not found")

    # Normalize allowlist to an upper-cased "METHOD /path" set so the
    # match is case-insensitive on method (OpenAPI uses lowercase verbs).
    allow_set: Optional[set[str]] = None
    if endpoint_allowlist:
        allow_set = {f"{m.upper()} {p}" for m, p in (e.split(" ", 1) for e in endpoint_allowlist if " " in e)}

    # api_name lets the engine + error_injector look up connector-specific
    # corpora. Custom connections (no Connector binding) carry the special
    # name "custom".
    api_name = "custom"
    if connection.connector_id:
        connector = await db.get(Connector, connection.connector_id)
        if connector:
            api_name = connector.name

    paths = spec_json.get("paths", {}) or {}
    routes: list[dict[str, Any]] = []
    entity_examples: dict[str, dict[str, Any]] = {}
    schema_json: dict[str, dict[str, Any]] = {}
    result = IngestResult(endpoints_seen=len(paths))

    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        entity_type = _entity_type_from_path(path)
        if not entity_type:
            result.skipped.append(path)
            continue
        is_collection = _is_collection_path(path)
        for method_name, op in methods.items():
            method_upper = method_name.upper()
            if method_upper not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                continue
            if not isinstance(op, dict):
                continue
            # Wizard-driven curation: drop any operation the user
            # didn't tick. Allowlist absent ⇒ ingest everything (legacy
            # behaviour preserved for existing callers).
            if allow_set is not None and f"{method_upper} {path}" not in allow_set:
                result.skipped.append(f"{method_upper} {path} (not in allowlist)")
                continue
            route = _route_for(
                method=method_upper,
                path=path,
                entity_type=entity_type,
                is_collection=is_collection,
                op=op,
            )
            if route is None:
                result.skipped.append(f"{method_upper} {path}")
                continue
            routes.append(route)
            # Capture an example for schema enrichment + entity seeding.
            if method_upper == "GET":
                example = _extract_example_from_response(op)
                record = _flatten_record(example, entity_type)
                if record and entity_type not in entity_examples:
                    entity_examples[entity_type] = record
                    schema_json[entity_type] = _infer_schema(record)

    result.routes_added = len(routes)

    # Replace MockSpec for this connection — additive layering would be
    # nice (preserve agent_curated layer) but v1 keeps it simple.
    await db.execute(
        delete(MockSpec).where(MockSpec.connection_id == connection_id)
    )
    spec = MockSpec(
        id=str(uuid4()),
        connection_id=connection_id,
        api_name=api_name,
        version=1,
        routes={"routes": routes},
        request_validators={},
        response_generators={},
        business_rules={},
        generated_by="discovery",
    )
    db.add(spec)

    # Replace TestBank for this connection.
    existing_bank = (
        await db.execute(
            select(TestBank).where(TestBank.connection_id == connection_id)
        )
    ).scalar_one_or_none()
    if existing_bank:
        await db.execute(
            delete(TestBankEntity).where(
                TestBankEntity.test_bank_id == existing_bank.id
            )
        )
        await db.delete(existing_bank)
        await db.flush()
    bank = TestBank(
        id=str(uuid4()),
        connection_id=connection_id,
        api_name=api_name,
        schema_json=schema_json,
        value_sets={},
        pii_classifications={},
        source_sample_size=0,
    )
    db.add(bank)
    await db.flush()

    # Seed one example entity per entity type. is_golden=False so observed
    # traffic + active probe can promote a real record into the golden slot.
    for entity_type, example in entity_examples.items():
        eid = (
            str(example.get("id"))
            if example.get("id") is not None
            else f"{entity_type}_openapi_example"
        )
        record = dict(example)
        record["id"] = eid
        db.add(
            TestBankEntity(
                id=str(uuid4()),
                test_bank_id=bank.id,
                entity_type=entity_type,
                entity_id=eid,
                data=record,
                is_golden=False,
                references={},
            )
        )
        result.entities_seeded += 1

    # Update sandbox_config.endpoints with provenance + initial coverage.
    cfg = dict(connection.sandbox_config or {})
    endpoints = dict(cfg.get("endpoints") or {})
    for r in routes:
        key = f"{r['method']} {r['path']}"
        # Preserve any prior coverage info the active probe stamped here;
        # OpenAPI just establishes the floor.
        prior = endpoints.get(key) or {}
        endpoints[key] = {
            "coverage_pct": prior.get("coverage_pct", 30),
            "last_observed_at": prior.get("last_observed_at"),
            "sample_count": prior.get("sample_count", 0),
            "source": prior.get("source", "openapi"),
        }
    cfg["endpoints"] = endpoints
    # Stash the allowlist used for this ingest so the wizard can prefill
    # the same picks next time. None ⇒ "all endpoints" (don't write).
    if endpoint_allowlist is not None:
        cfg["endpoint_allowlist"] = list(endpoint_allowlist)
    connection.sandbox_config = cfg

    await db.flush()
    return result


def _route_for(
    *,
    method: str,
    path: str,
    entity_type: str,
    is_collection: bool,
    op: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """Map (method, collection?) onto a responder shape. Returns None for
    operations we don't yet know how to mock (PUT/PATCH/DELETE)."""
    base = {
        "path": path,
        "method": method,
        "validators": ["auth_bearer"],
        "provenance": "openapi",
    }
    if method == "GET" and is_collection:
        return {
            **base,
            "responder": {
                "type": "list_entities",
                "entity_type": entity_type,
                "supports_pagination": True,
                "page_size_default": 25,
            },
        }
    if method == "GET" and not is_collection:
        return {
            **base,
            "responder": {
                "type": "get_entity",
                "entity_type": entity_type,
            },
        }
    if method == "POST" and is_collection:
        return {
            **base,
            "responder": {
                "type": "create_entity",
                "entity_type": entity_type,
                "required_fields": _required_fields_from_request_body(op),
                "id_generator": f"{entity_type}_{{ulid}}",
            },
            "validators": ["auth_bearer", "json_body"],
        }
    return None


# ---------------------------------------------------------------------------
# Deep-extraction loader (Phase 1 v3 — supersedes the inline-example-only
# path above for any caller that needs a fully-loaded sandbox).
#
# Wires together:
#   - openapi_resolver.collect_records_for_op (every available example,
#     including those reachable only via $ref to components)
#   - openapi_resolver.collect_error_shapes (4xx/5xx envelopes)
#   - entity_resolver.populate_entity_schemas (the rich per-entity catalog
#     the diagram editor reads)
#   - ai_synthesizer.synthesize_records (top-up to per-entity seed_count)
#   - cross-record threading (substitute *_id fields with actual sibling-
#     bank ids so GET /vendors/{Bill.vendor.id} resolves)
# ---------------------------------------------------------------------------


_DEFAULT_SEED_COUNTS = {
    "vendor": 12,
    "purchase_order": 8,
    "item_receipt": 8,
    "bill": 6,
    "accounting_field": 4,
    "field": 4,
    "entity": 3,
}
_FALLBACK_SEED_COUNT = 4


async def deep_reseed_connection(
    db: AsyncSession, *, connection_id: str
) -> dict[str, int]:
    """Wipe + repopulate the connection's TestBank using the resolver +
    synthesizer. Returns a counters dict the API surface returns to the
    UI ("Deep reseed" button)."""
    from app.services.entity_resolver import populate_entity_schemas
    from app.services.openapi_resolver import (
        collect_error_shapes,
        collect_records_for_op,
    )
    from app.services.ai_synthesizer import synthesize_records

    connection = await db.get(Connection, connection_id)
    if connection is None:
        raise ValueError(f"connection {connection_id!r} not found")

    # Resolve the spec source: prefer the connection's openapi_spec_id
    # (custom Oro/Sage path); fall back to the connector's bundled spec
    # if one was loaded under the connector's name.
    spec_row: Optional[OpenAPISpec] = None
    if connection.openapi_spec_id:
        spec_row = await db.get(OpenAPISpec, connection.openapi_spec_id)
    if spec_row is None and connection.connector_id:
        connector = await db.get(Connector, connection.connector_id)
        if connector:
            result = await db.execute(
                select(OpenAPISpec).where(
                    OpenAPISpec.name.ilike(f"{connector.display_name}%")
                ).limit(1)
            )
            spec_row = result.scalar_one_or_none()
    if spec_row is None:
        raise ValueError(
            f"connection {connection_id!r} has no OpenAPISpec bound — "
            "set Connection.openapi_spec_id or seed a spec named after "
            "the connector"
        )

    spec = spec_row.spec_json or {}
    api_name = "custom"
    if connection.connector_id:
        c = await db.get(Connector, connection.connector_id)
        if c:
            api_name = c.name

    # 1. Populate OpenAPISpec.entity_schemas (the diagram editor reads this)
    entity_schemas = populate_entity_schemas(spec)
    spec_row.entity_schemas = entity_schemas

    # 2. Wipe existing TestBank for the connection
    bank_row = (
        await db.execute(
            select(TestBank).where(TestBank.connection_id == connection_id)
        )
    ).scalar_one_or_none()
    if bank_row:
        await db.execute(
            delete(TestBankEntity).where(TestBankEntity.test_bank_id == bank_row.id)
        )
        await db.delete(bank_row)
        await db.flush()

    schema_json: dict[str, dict[str, Any]] = {}
    error_shapes: dict[str, dict[str, Any]] = {}

    # 3. Walk every operation, capture all examples + all error shapes
    extracted_by_entity: dict[str, list[dict]] = {}
    counts = {
        "entities_seeded": 0,
        "examples_collected": 0,
        "enums_extracted": 0,
        "formats_extracted": 0,
        "refs_resolved": 0,
        "error_shapes_captured": 0,
    }
    for path, methods in (spec.get("paths") or {}).items():
        if not isinstance(methods, dict):
            continue
        entity_type = _entity_type_from_path(path)
        if not entity_type:
            continue
        for verb in ("get", "post"):
            op = methods.get(verb)
            if not isinstance(op, dict):
                continue
            if verb == "get":
                records = collect_records_for_op(spec, op, entity_type)
                counts["examples_collected"] += len(records)
                extracted_by_entity.setdefault(entity_type, []).extend(records)
            errs = collect_error_shapes(spec, op)
            if errs:
                slot = error_shapes.setdefault(f"{verb.upper()} {path}", {})
                slot.update(errs)
                counts["error_shapes_captured"] += len(errs)

    # 4. Build schema_json from entity_schemas (flat path → typed entry,
    #    consumed by the synth fallback)
    for entity_type, info in entity_schemas.items():
        schema_json[entity_type] = _schema_from_field_specs(info.get("fields") or [])
        counts["enums_extracted"] += len(info.get("enums") or {})
        counts["formats_extracted"] += len(info.get("formats") or {})
        counts["refs_resolved"] += len(info.get("refs") or {})

    bank_row = TestBank(
        id=str(uuid4()),
        connection_id=connection_id,
        api_name=api_name,
        schema_json=schema_json,
        value_sets={},
        pii_classifications={},
        source_sample_size=counts["examples_collected"],
    )
    db.add(bank_row)
    await db.flush()

    # 5. Seed extracted examples + top up to seed_count via synthesizer
    seeded_by_type: dict[str, list[dict]] = {}
    for entity_type in (entity_schemas.keys() | extracted_by_entity.keys()):
        target = _DEFAULT_SEED_COUNTS.get(entity_type, _FALLBACK_SEED_COUNT)
        records = list(extracted_by_entity.get(entity_type) or [])
        # Top up via synthesizer.
        if len(records) < target:
            need = target - len(records)
            synth = synthesize_records(
                entity_type=entity_type,
                schema=schema_json.get(entity_type, {}),
                count=need,
                variant="full",
            )
            records.extend(synth.records)
        seeded_by_type[entity_type] = records[:target]

    # 6. Cross-record threading — substitute *_id fields with sibling-bank ids
    _thread_cross_record_refs(seeded_by_type, entity_schemas)

    # 7. Persist — dedupe by entity_id within each type (Ramp examples
    #    repeat across operations; multiple examples for the same record
    #    would violate the test_bank_entities unique constraint).
    for entity_type, records in seeded_by_type.items():
        seen_ids: set[str] = set()
        for record in records:
            eid = str(record.get("id") or uuid4())
            if eid in seen_ids:
                eid = f"{eid}_{uuid4().hex[:8]}"
            seen_ids.add(eid)
            record["id"] = eid
            db.add(
                TestBankEntity(
                    id=str(uuid4()),
                    test_bank_id=bank_row.id,
                    entity_type=entity_type,
                    entity_id=eid,
                    data=record,
                    is_golden=False,
                    references={},
                )
            )
            counts["entities_seeded"] += 1

    # 8. Stash error_shapes on the bank's value_sets (no separate column
    #    for v1 — JSONB blob has room).
    bank_row.value_sets = {"error_shapes": error_shapes}

    # 9. Mark the connection as primed
    cfg = dict(connection.sandbox_config or {})
    cfg["deep_reseeded_at"] = datetime_now_iso()
    cfg["deep_reseed_counts"] = counts
    connection.sandbox_config = cfg

    await db.flush()
    return counts


def datetime_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).isoformat()


def _schema_from_field_specs(fields: list[dict]) -> dict[str, dict[str, Any]]:
    """Convert resolver's FieldSpec[] → the flat dotted-path → typed-info
    dict that the synthesizer's fallback path consumes."""
    out: dict[str, dict[str, Any]] = {}
    for fs in fields:
        path = fs.get("path")
        if not path:
            continue
        entry: dict[str, Any] = {
            "type": fs.get("type"),
            "nullable": bool(fs.get("nullable")),
        }
        if fs.get("format"):
            entry["format"] = fs["format"]
        if fs.get("enum_values"):
            entry["enum_values"] = fs["enum_values"]
        if fs.get("required"):
            entry["required"] = True
        if fs.get("ref_name"):
            entry["ref_name"] = fs["ref_name"]
        if fs.get("description"):
            entry["description"] = fs["description"]
        if fs.get("items_type"):
            entry["items_type"] = fs["items_type"]
        out[path] = entry
    return out


def _thread_cross_record_refs(
    seeded_by_type: dict[str, list[dict]],
    entity_schemas: dict[str, Any],
) -> None:
    """Walk every record and, for any field whose name ends in `_id`
    OR who has a known `ref_name`, substitute the value with an actual id
    from the entity-type guessed by name.

    `Bill.vendor.id` → matching Vendor id from `seeded_by_type['vendor']`.
    `Bill.purchase_order_id` → matching PO id (by suffix heuristic).

    Makes `GET /vendors/{Bill.vendor.id}` actually resolve.
    """
    import random

    rng = random.Random("solder-cross-record-seed")

    # Build entity_type → list of ids for quick picks
    ids_by_type: dict[str, list[str]] = {
        et: [str(r.get("id") or "") for r in recs if r.get("id")]
        for et, recs in seeded_by_type.items()
    }

    # Map possible field-name suffixes (e.g. `purchase_order_id`) →
    # candidate entity types in the bank
    def _guess_entity_for_field(field_name: str) -> Optional[str]:
        n = field_name.lower()
        if n.endswith("_id"):
            stem = n[:-3]
            if stem in ids_by_type:
                return stem
            # Try common pluralisation patterns
            if stem + "s" in ids_by_type:
                return stem + "s"
            # Drop a leading underscore-split prefix (e.g. `remote_vendor_id` → `vendor`)
            parts = stem.split("_")
            if parts and parts[-1] in ids_by_type:
                return parts[-1]
        if n in ids_by_type:
            return n
        return None

    def _walk_and_substitute(node: Any) -> Any:
        if isinstance(node, dict):
            for k, v in list(node.items()):
                guessed = _guess_entity_for_field(k)
                if guessed and ids_by_type.get(guessed):
                    if not isinstance(v, (dict, list)):
                        node[k] = rng.choice(ids_by_type[guessed])
                node[k] = _walk_and_substitute(v)
            return node
        if isinstance(node, list):
            return [_walk_and_substitute(item) for item in node]
        return node

    for entity_type, records in seeded_by_type.items():
        for record in records:
            _walk_and_substitute(record)
