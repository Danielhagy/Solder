"""
Connections API — encrypted at rest, never round-trips plaintext.

Two flavours of connection share the table:

  - **Built-in** — `connector_id` references a registered `Connector`
    row (Zip, HubSpot). The connector's `auth_scheme` and `base_url`
    are inherited.
  - **Custom**   — `connector_id` null; the user picked one of the five
    `auth_schemes.SCHEMES` primitives directly and supplied a name.

POST receives plaintext secrets; this layer immediately splits them on
the schema's `secret` flag — secret keys go through
`connection_crypto.encrypt` to become `(ciphertext, nonce)`; non-secret
keys land in `config_json`. GET / list return the metadata only —
secrets never leave the server.

To use a connection at execution time, call
`connection_crypto.decrypt(row.ciphertext, row.nonce)` and feed the
result to `auth_schemes.apply(row.auth_scheme, secrets, config)`.
"""

from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors import REGISTRY as CONNECTOR_REGISTRY
from app.connectors import auth_schemes
from app.database import get_db
from app.models import Connection, Connector
from app.schemas import ConnectionIn, ConnectionOut, ConnectionSandboxIn
from app.services import connection_crypto

router = APIRouter()


def _safe_sandbox_config(cfg: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Strip any encrypted vendor-sandbox creds from the read shape.

    `sandbox_config` is JSONB and may carry base64-encoded `ciphertext`
    + `nonce` for `mode='vendor'`. The UI never needs those values
    directly — only that creds are present — so we surface a
    `creds_set: bool` flag in their place. Synthetic-mode payload is
    public (priming state, coverage stats) and passes through.
    """
    if not cfg:
        return {}
    out = dict(cfg)
    if "ciphertext" in out or "nonce" in out:
        out.pop("ciphertext", None)
        out.pop("nonce", None)
        out["creds_set"] = True
    return out


def _to_out(row: Connection) -> ConnectionOut:
    return ConnectionOut(
        id=row.id,
        connector_id=row.connector_id,
        label=row.label,
        auth_scheme=row.auth_scheme,
        base_url=row.base_url,
        config_json=row.config_json or {},
        sandbox_mode=row.sandbox_mode or "none",
        sandbox_config=_safe_sandbox_config(row.sandbox_config),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("", response_model=list[ConnectionOut])
async def list_connections(
    connector_id: Optional[str] = Query(default=None),
    auth_scheme: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[ConnectionOut]:
    stmt = select(Connection)
    if connector_id:
        stmt = stmt.where(Connection.connector_id == connector_id)
    if auth_scheme:
        stmt = stmt.where(Connection.auth_scheme == auth_scheme)
    rows = list((await db.execute(stmt)).scalars().all())
    return [_to_out(r) for r in rows]


@router.post("", response_model=ConnectionOut, status_code=status.HTTP_201_CREATED)
async def create_connection(
    payload: ConnectionIn, db: AsyncSession = Depends(get_db)
) -> ConnectionOut:
    # Resolve the connector binding + scheme. Either:
    #   (a) connector_id given → look up the connector → scheme is its
    #       declared scheme (we still let an explicit `auth_scheme` in
    #       the payload override, in case a connector exposes multiple
    #       — none do today, but the model allows it).
    #   (b) connector_id null → custom connection; auth_scheme required.
    connector: Optional[Connector] = None
    if payload.connector_id is not None:
        connector = await db.get(Connector, payload.connector_id)
        if connector is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail=f"unknown connector_id {payload.connector_id!r}",
            )
    scheme_id = payload.auth_scheme or (connector.auth_scheme if connector else None)
    if scheme_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="auth_scheme is required when no connector_id is provided",
        )
    try:
        scheme = auth_schemes.get_scheme(scheme_id)
    except KeyError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=(
                f"unknown auth_scheme {scheme_id!r} — valid options: "
                + ", ".join(s.id for s in auth_schemes.SCHEMES)
            ),
        )

    # Validate the user's input against the scheme's required fields.
    # Required SECRET keys must appear in `payload.secrets`; required
    # PUBLIC keys must appear in `payload.config` (or default to the
    # scheme's `default` value).
    config = dict(payload.config)
    secrets = dict(payload.secrets)
    for field in scheme.fields:
        if field.required:
            bag = secrets if field.secret else config
            value = bag.get(field.key)
            if value in (None, ""):
                if not field.secret and field.default is not None:
                    config[field.key] = field.default
                    continue
                bucket = "secrets" if field.secret else "config"
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    detail=f"{bucket}.{field.key} is required for {scheme.id!r}",
                )

    if not secrets:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="at least one secret value is required",
        )

    # Resolve base_url: explicit override → connector default → null.
    base_url = payload.base_url
    if base_url is None and connector is not None:
        base_url = connector.base_url

    ciphertext, nonce = connection_crypto.encrypt(secrets)
    row = Connection(
        id=str(uuid4()),
        connector_id=payload.connector_id,
        label=payload.label,
        auth_scheme=scheme.id,
        base_url=base_url,
        config_json=config,
        ciphertext=ciphertext,
        nonce=nonce,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _to_out(row)


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: str, db: AsyncSession = Depends(get_db)
) -> None:
    row = await db.get(Connection, connection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"connection {connection_id!r} not found",
        )
    await db.delete(row)
    await db.commit()


@router.post("/{connection_id}/sandbox/ingest-openapi")
async def ingest_openapi_into_sandbox(
    connection_id: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Scaffold a synthetic-mode connection's MockSpec + TestBank from an
    OpenAPI spec. Body accepts either:

      - `{"spec_json": {...}}`          — paste a spec inline
      - `{"openapi_spec_id": "uuid"}`   — reference a stored OpenAPISpec row

    Connection must already be in `sandbox_mode='synthetic'`. Returns a
    summary `{routes_added, entities_seeded, endpoints_seen, skipped}`
    so the UI can show what landed.
    """
    from app.models import OpenAPISpec
    from app.services.openapi_ingest import ingest_openapi_for_connection

    row = await db.get(Connection, connection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"connection {connection_id!r} not found",
        )
    if row.sandbox_mode != "synthetic":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="connection must be in sandbox_mode='synthetic' to ingest a spec",
        )

    spec_json = payload.get("spec_json")
    spec_id = payload.get("openapi_spec_id")
    if spec_json is None and spec_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="provide either spec_json or openapi_spec_id",
        )
    if spec_json is None:
        spec_row = await db.get(OpenAPISpec, str(spec_id))
        if spec_row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail=f"openapi_spec_id {spec_id!r} not found",
            )
        spec_json = spec_row.spec_json

    if not isinstance(spec_json, dict):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="spec_json must be a JSON object",
        )

    raw_allow = payload.get("endpoint_allowlist")
    endpoint_allowlist: Optional[list[str]] = None
    if raw_allow is not None:
        if not isinstance(raw_allow, list) or not all(isinstance(x, str) for x in raw_allow):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail="endpoint_allowlist must be a list of 'METHOD /path' strings",
            )
        endpoint_allowlist = raw_allow

    try:
        result = await ingest_openapi_for_connection(
            db,
            connection_id=connection_id,
            spec_json=spec_json,
            endpoint_allowlist=endpoint_allowlist,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e))

    await db.commit()
    return {
        "routes_added": result.routes_added,
        "entities_seeded": result.entities_seeded,
        "endpoints_seen": result.endpoints_seen,
        "skipped": result.skipped,
    }


@router.get("/{connection_id}/sandbox/errors")
async def get_sandbox_errors(
    connection_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Errors tab data: hand-curated corpus entries for the connection's
    api_name + observed error responses aggregated from RunAuditEvent
    (grouped by path + status + error_injected).

    Audit rows aren't keyed on connection_id today (the mock-engine
    routes by integration_id+connector_name pre-Sandboxes-v1), so we
    scope by `connector_name` matching the connection's spec api_name.
    Multiple connections to the same connector share their observed
    error history at v1 — fine for the corpus view's intent.
    """
    import json
    from pathlib import Path

    from sqlalchemy import func

    from app.models import MockSpec, RunAuditEvent

    row = await db.get(Connection, connection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"connection {connection_id!r} not found",
        )

    spec = (
        await db.execute(
            select(MockSpec).where(MockSpec.connection_id == connection_id)
        )
    ).scalar_one_or_none()
    api_name = spec.api_name if spec else None

    # Hand-curated corpus, if a JSON file exists for this connector.
    corpus_entries: list[dict[str, Any]] = []
    if api_name:
        corpora_dir = (
            Path(__file__).resolve().parents[1]
            / "mock_engine"
            / "error_corpora"
        )
        corpus_path = corpora_dir / f"{api_name}.json"
        if corpus_path.exists():
            try:
                doc = json.loads(corpus_path.read_text(encoding="utf-8"))
                corpus_entries = doc.get("errors", []) or []
            except (json.JSONDecodeError, OSError):
                corpus_entries = []

    # Observed: group RunAuditEvent responses (status >= 400) by
    # (path, status, error_injected). Limited to the matching connector_name.
    observed: list[dict[str, Any]] = []
    if api_name:
        stmt = (
            select(
                RunAuditEvent.path,
                RunAuditEvent.status,
                RunAuditEvent.error_injected,
                func.count(RunAuditEvent.id).label("count"),
                func.max(RunAuditEvent.timestamp).label("last_seen"),
            )
            .where(
                RunAuditEvent.connector_name == api_name,
                RunAuditEvent.direction == "response",
                RunAuditEvent.status >= 400,
            )
            .group_by(
                RunAuditEvent.path,
                RunAuditEvent.status,
                RunAuditEvent.error_injected,
            )
            .order_by(func.count(RunAuditEvent.id).desc())
            .limit(100)
        )
        rows = (await db.execute(stmt)).all()
        observed = [
            {
                "path": p,
                "status": s,
                "error_injected": e,
                "count": int(c),
                "last_seen": ls.isoformat() if ls else None,
            }
            for p, s, e, c, ls in rows
        ]

    return {
        "api_name": api_name,
        "corpus": corpus_entries,
        "observed": observed,
    }


@router.post("/{connection_id}/sandbox/prime")
async def prime_sandbox(
    connection_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Run the read-only active probe against the connection's prod
    creds. Hits each `list_entities` GET route once, extracts shape,
    merges into TestBank.schema_json. Updates Connection.sandbox_config
    with coverage stats per endpoint.
    """
    from app.services.sandbox_primer import prime_connection

    try:
        result = await prime_connection(db, connection_id=connection_id)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"prime failed: {type(e).__name__}: {e}",
        )
    await db.commit()
    return {
        "endpoints_probed": result.endpoints_probed,
        "successes": result.successes,
        "failures": result.failures,
        "sample_count_total": result.sample_count_total,
        "outcomes": [
            {
                "path": o.path,
                "method": o.method,
                "success": o.success,
                "sample_count": o.sample_count,
                "fields_observed": o.fields_observed,
                "error": o.error,
            }
            for o in result.outcomes
        ],
    }


@router.get("/{connection_id}/sandbox/bank")
async def get_sandbox_bank(
    connection_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return a summary of the connection's TestBank: per-entity-type
    record counts + schema field names. Used by the Sandboxes Records
    tab to show what's been synthesised."""
    from sqlalchemy import func

    from app.models import TestBank, TestBankEntity

    row = await db.get(Connection, connection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"connection {connection_id!r} not found",
        )
    bank = (
        await db.execute(
            select(TestBank).where(TestBank.connection_id == connection_id)
        )
    ).scalar_one_or_none()
    if bank is None:
        return {"entity_types": [], "total": 0, "schema": {}}

    counts_stmt = (
        select(TestBankEntity.entity_type, func.count(TestBankEntity.id))
        .where(TestBankEntity.test_bank_id == bank.id)
        .group_by(TestBankEntity.entity_type)
    )
    rows = (await db.execute(counts_stmt)).all()
    schema = bank.schema_json or {}
    entity_types = [
        {
            "name": et,
            "count": int(c),
            "schema_keys": list((schema.get(et) or {}).keys()),
        }
        for et, c in rows
    ]
    # Include entity types declared in schema even if no records yet.
    seen = {e["name"] for e in entity_types}
    for et in schema.keys():
        if et not in seen:
            entity_types.append(
                {
                    "name": et,
                    "count": 0,
                    "schema_keys": list((schema.get(et) or {}).keys()),
                }
            )
    return {
        "entity_types": entity_types,
        "total": sum(e["count"] for e in entity_types),
        "schema": schema,
    }


@router.post("/{connection_id}/sandbox/synthesize")
async def synthesize_sandbox_records(
    connection_id: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Generate synthetic records for one entity_type and persist them
    into the connection's TestBank.

    Body: `{entity_type: str, count: int, variant: 'full'|'half'|'minimal'}`.
    Returns: `{created, used_fallback, error?, examples}` (first 3 records
    surfaced so the UI can preview).
    """
    from uuid import uuid4 as _uuid4

    from app.models import TestBank, TestBankEntity
    from app.services.ai_synthesizer import synthesize_records

    row = await db.get(Connection, connection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"connection {connection_id!r} not found",
        )
    if row.sandbox_mode != "synthetic":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="connection must be in sandbox_mode='synthetic'",
        )

    entity_type = payload.get("entity_type")
    count_raw = payload.get("count", 10)
    variant = payload.get("variant", "full")
    if not isinstance(entity_type, str) or not entity_type:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="entity_type is required"
        )
    try:
        count = max(1, min(int(count_raw), 200))
    except (TypeError, ValueError):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="count must be an integer"
        )

    bank = (
        await db.execute(
            select(TestBank).where(TestBank.connection_id == connection_id)
        )
    ).scalar_one_or_none()
    if bank is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="no test bank for this connection — ingest an OpenAPI spec first",
        )
    schema_for_entity = (bank.schema_json or {}).get(entity_type)
    if not schema_for_entity:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=(
                f"no schema for entity_type {entity_type!r} on this bank — "
                "ingest a spec or run the active probe to discover the shape"
            ),
        )

    result = synthesize_records(
        entity_type=entity_type,
        schema=schema_for_entity,
        count=count,
        variant=variant,
    )

    for i, record in enumerate(result.records):
        eid = str(record.get("id") or f"{entity_type}_synth_{i:04d}")
        record_with_id = dict(record)
        record_with_id["id"] = eid
        db.add(
            TestBankEntity(
                id=str(_uuid4()),
                test_bank_id=bank.id,
                entity_type=entity_type,
                entity_id=eid,
                data=record_with_id,
                is_golden=False,
                references={},
            )
        )
    await db.commit()

    return {
        "created": len(result.records),
        "used_fallback": result.used_fallback,
        "error": result.error,
        "examples": result.records[:3],
    }


@router.put("/{connection_id}/sandbox", response_model=ConnectionOut)
async def update_connection_sandbox(
    connection_id: str,
    payload: ConnectionSandboxIn,
    db: AsyncSession = Depends(get_db),
) -> ConnectionOut:
    """Set or clear the sandbox config on one connection.

    See `ConnectionSandboxIn` for body shape. Vendor secrets are
    encrypted on receipt with the same per-host key as production
    secrets; the resulting `(ciphertext, nonce)` pair lives base64-
    encoded inside `sandbox_config`. Synthetic mode initialises
    priming state to empty; the active probe (task #6) populates it.
    """
    import base64

    row = await db.get(Connection, connection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"connection {connection_id!r} not found",
        )

    if payload.mode == "none":
        row.sandbox_mode = "none"
        row.sandbox_config = {}
    elif payload.mode == "vendor":
        # Encrypt the vendor sandbox secrets with the same scheme as
        # the prod creds. Stored alongside the prod ciphertext (on the
        # same row) but in a separate JSONB-friendly base64 envelope.
        ciphertext, nonce = connection_crypto.encrypt(payload.vendor_secrets or {})
        row.sandbox_mode = "vendor"
        row.sandbox_config = {
            "base_url": payload.vendor_base_url,
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
            "nonce": base64.b64encode(nonce).decode("ascii"),
        }
    else:  # 'synthetic'
        # Preserve any existing priming state (endpoints, last_primed_at)
        # so flipping kb_opt_in doesn't blow away discovered shapes.
        prior = row.sandbox_config if row.sandbox_mode == "synthetic" else {}
        row.sandbox_mode = "synthetic"
        row.sandbox_config = {
            **prior,
            "kb_opt_in": (
                payload.kb_opt_in
                if payload.kb_opt_in is not None
                else prior.get("kb_opt_in", True)
            ),
            "last_primed_at": prior.get("last_primed_at"),
            "endpoints": prior.get("endpoints", {}),
        }

    await db.commit()
    await db.refresh(row)
    return _to_out(row)
