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

from app.models import Connection, Connector, MockSpec, TestBank, TestBankEntity


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
