"""
Idempotent demo seeder for the mock-engine MVP (FullSpec.md § 5.1).

Picks (or creates) an integration, attaches a Zip-flavoured `MockSpec` for
the source side, and seeds a `TestBank` with synthetic vendors +
purchase_orders (with referential integrity from POs to vendors). Safe to
run repeatedly — it overwrites the spec to the latest version and
truncates + re-inserts the bank.

Used by the `/api/dev/seed-mock-demo` endpoint to make `curl` smoke tests
of the mock-engine reproducible without running the full discovery +
synthesis pipeline (those land in slices 3 + 4).
"""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors import REGISTRY as CONNECTOR_REGISTRY
from app.models import (
    Connection,
    Connector,
    Integration,
    MockSession,
    MockSessionWrite,
    MockSpec,
    OpenAPISpec,
    TestBank,
    TestBankEntity,
)
from app.services import connection_crypto

# Bundled OpenAPI specs that ship with Solder. Each entry: (db row name,
# repo path relative to backend/, source URL for provenance). Loaded once
# on startup so the wizard ("+ Sandbox from Spec") has something to point
# at without an outbound fetch — keeps the demo deterministic offline.
import json
from pathlib import Path

_BUNDLED_SPECS = (
    {
        "name": "Ramp Developer API — Procurement",
        "path": Path(__file__).resolve().parents[1] / "connectors" / "spec_assets" / "ramp-procurement.json",
        "url": "https://docs.ramp.com/openapi/developer-api.json",
    },
)


DEMO_INTEGRATION_NAME = "Mock Engine Demo (Zip)"
DEMO_CONNECTION_LABEL = "Zip — demo tenant"
DEMO_CONNECTOR_NAME = "zip"


async def seed(db: AsyncSession) -> dict[str, object]:
    """Idempotent seed: connectors → demo integration → connection → spec → bank.

    Returns the ids the next agent or smoke test will need to drive the
    mock-engine. The demo connection is registered globally (per the
    simplified Slice 2.5 model) so any node bound to the Zip connector
    can pick it from the editor's connection list.
    """
    connector_ids = await _ensure_connectors(db)
    await _ensure_bundled_openapi_specs(db)
    integration = await _ensure_integration(db)
    demo_connection = await _ensure_demo_connection(db, connector_ids["zip"])
    bank = await _ensure_bank(db, integration.id)
    await _wipe_bank_entities(db, bank.id)
    await _seed_entities(db, bank.id)
    spec = await _ensure_spec(db, integration.id)
    await _wipe_scratch_session(db, integration.id)
    await db.commit()
    return {
        "integration_id": integration.id,
        "test_bank_id": bank.id,
        "mock_spec_id": spec.id,
        "connection_id": demo_connection.id,
        "connector_name": DEMO_CONNECTOR_NAME,
        "connectors": connector_ids,
    }


async def _ensure_connectors(db: AsyncSession) -> dict[str, str]:
    """Upsert one DB row per registered connector class. Returns the
    `{name: id}` map so callers can wire FKs without a follow-up query."""
    out: dict[str, str] = {}
    for name, conn in CONNECTOR_REGISTRY.items():
        stmt = select(Connector).where(Connector.name == name)
        row = (await db.execute(stmt)).scalar_one_or_none()
        if row is None:
            row = Connector(
                id=str(uuid4()),
                name=conn.name,
                display_name=conn.display_name,
                auth_scheme=conn.auth_scheme,
                base_url=conn.base_url,
                brand_domain=conn.brand_domain,
            )
            db.add(row)
            await db.flush()
        else:
            # Refresh non-secret fields in case the registry definition
            # changed (e.g. display_name, brand_domain). The id stays put
            # so connections bound to it don't dangle.
            row.display_name = conn.display_name
            row.auth_scheme = conn.auth_scheme
            row.base_url = conn.base_url
            row.brand_domain = conn.brand_domain
        out[name] = row.id
    return out


async def _ensure_bundled_openapi_specs(db: AsyncSession) -> None:
    """Load each bundled OpenAPI spec into the `openapi_specs` table.

    Idempotent on `name` — re-running rewrites `spec_json` so a fresh
    pull of an upstream spec gets picked up the next boot. Skips
    silently if the bundled file is missing (lets test envs that don't
    ship the spec bundle still boot).
    """
    for entry in _BUNDLED_SPECS:
        path: Path = entry["path"]  # type: ignore[assignment]
        if not path.exists():
            continue
        try:
            spec_json = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        version = str(spec_json.get("openapi") or spec_json.get("swagger") or "3.0.0")
        existing = (
            await db.execute(select(OpenAPISpec).where(OpenAPISpec.name == entry["name"]))
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                OpenAPISpec(
                    id=str(uuid4()),
                    name=entry["name"],
                    url=entry.get("url"),
                    version=version,
                    spec_json=spec_json,
                    parsed_markdown=None,
                )
            )
        else:
            existing.spec_json = spec_json
            existing.version = version
            existing.url = entry.get("url")
        await db.flush()


async def _ensure_integration(db: AsyncSession) -> Integration:
    stmt = select(Integration).where(Integration.name == DEMO_INTEGRATION_NAME)
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is not None:
        return row
    integ = Integration(
        id=str(uuid4()),
        name=DEMO_INTEGRATION_NAME,
        description="Seeded demo integration backing the mock-engine smoke tests.",
        config={"nodes": [], "variables": {}},
        status="draft",
        environment="sandbox",
        discovery_status="complete",
    )
    db.add(integ)
    await db.flush()
    return integ


async def _ensure_demo_connection(
    db: AsyncSession, connector_id: str
) -> Connection:
    """A placeholder Zip connection so the demo can exercise the new
    alias-keyed mock route. Real users author connections via the
    `/api/connections` POST; this is the seed-only shortcut.

    Idempotent: re-running keeps the same row id but rolls a fresh
    ciphertext (the AEAD nonce changes per encrypt call), which is fine
    because the encryption is deterministic in plaintext, not in
    ciphertext bytes.
    """
    stmt = select(Connection).where(Connection.label == DEMO_CONNECTION_LABEL)
    row = (await db.execute(stmt)).scalar_one_or_none()
    ciphertext, nonce = connection_crypto.encrypt({"token": "demo-zip-token"})
    if row is not None:
        row.connector_id = connector_id
        row.ciphertext = ciphertext
        row.nonce = nonce
        return row
    conn = Connection(
        id=str(uuid4()),
        connector_id=connector_id,
        label=DEMO_CONNECTION_LABEL,
        ciphertext=ciphertext,
        nonce=nonce,
    )
    db.add(conn)
    await db.flush()
    return conn


async def _ensure_bank(db: AsyncSession, integration_id: str) -> TestBank:
    """Idempotent on `(integration_id, api_name)`. One bank per
    (integration, connector) — connections to the same connector share it.
    """
    stmt = select(TestBank).where(
        TestBank.integration_id == integration_id,
        TestBank.api_name == DEMO_CONNECTOR_NAME,
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is not None:
        return row
    bank = TestBank(
        id=str(uuid4()),
        integration_id=integration_id,
        api_name=DEMO_CONNECTOR_NAME,
        schema_json={},
        value_sets={},
        pii_classifications={},
        source_sample_size=0,
    )
    db.add(bank)
    await db.flush()
    return bank


async def _wipe_bank_entities(db: AsyncSession, test_bank_id: str) -> None:
    await db.execute(
        delete(TestBankEntity).where(TestBankEntity.test_bank_id == test_bank_id)
    )


def _vendor(vid: str, name: str, status: str) -> dict:
    return {
        "id": vid,
        "name": name,
        "status": status,
        "contact_email": f"{vid.replace('v_', '')}@example.com",
    }


def _purchase_order(
    pid: str, vendor_id: str, status: str, total: float
) -> dict:
    return {
        "id": pid,
        "vendor_id": vendor_id,
        "status": status,
        "total": total,
        "line_items": [
            {"sku": "SKU-001", "qty": 1, "price": total},
        ],
    }


async def _seed_entities(db: AsyncSession, test_bank_id: str) -> None:
    vendors = [
        _vendor("v_acme", "Acme Co", "active"),
        _vendor("v_globex", "Globex Inc", "active"),
        _vendor("v_initech", "Initech LLC", "active"),
        _vendor("v_umbrella", "Umbrella Corp", "inactive"),
        _vendor("v_stark", "Stark Industries", "active"),
    ]
    pos = [
        _purchase_order("po_001", "v_acme", "approved", 1240.00),
        _purchase_order("po_002", "v_acme", "submitted", 320.50),
        _purchase_order("po_003", "v_globex", "approved", 7890.10),
        _purchase_order("po_004", "v_globex", "rejected", 100.00),
        _purchase_order("po_005", "v_initech", "draft", 450.00),
        _purchase_order("po_006", "v_initech", "approved", 2100.75),
        _purchase_order("po_007", "v_stark", "approved", 99000.00),
        _purchase_order("po_008", "v_stark", "submitted", 12500.00),
    ]
    for v in vendors:
        db.add(
            TestBankEntity(
                id=str(uuid4()),
                test_bank_id=test_bank_id,
                entity_type="vendor",
                entity_id=v["id"],
                data=v,
                is_golden=v["id"] == "v_acme",
                references={},
            )
        )
    for p in pos:
        db.add(
            TestBankEntity(
                id=str(uuid4()),
                test_bank_id=test_bank_id,
                entity_type="purchase_order",
                entity_id=p["id"],
                data=p,
                is_golden=p["id"] == "po_001",
                references={
                    "vendor_id": {
                        "entity_type": "vendor",
                        "entity_id": p["vendor_id"],
                    }
                },
            )
        )
    await db.flush()


async def _ensure_spec(db: AsyncSession, integration_id: str) -> MockSpec:
    """Always replace the spec — keeps the seed authoritative.

    Idempotent on `(integration_id, api_name)`."""
    await db.execute(
        delete(MockSpec).where(
            MockSpec.integration_id == integration_id,
            MockSpec.api_name == DEMO_CONNECTOR_NAME,
        )
    )
    spec = MockSpec(
        id=str(uuid4()),
        integration_id=integration_id,
        api_name=DEMO_CONNECTOR_NAME,
        version=1,
        routes=_routes_payload(),
        request_validators={},
        response_generators={},
        business_rules={},
        generated_by="hand_authored",
    )
    db.add(spec)
    await db.flush()
    return spec


async def _wipe_scratch_session(db: AsyncSession, integration_id: str) -> None:
    """Drop accumulated state from previous demo runs so seeding really
    is a reset. Run-scoped sessions tied to real runs are left alone."""
    stmt = select(MockSession).where(
        MockSession.integration_id == integration_id,
        MockSession.scope == "scratch",
    )
    sessions = list((await db.execute(stmt)).scalars().all())
    for s in sessions:
        await db.execute(
            delete(MockSessionWrite).where(MockSessionWrite.mock_session_id == s.id)
        )
        await db.delete(s)


def _routes_payload() -> dict:
    return {
        "routes": [
            {
                "path": "/v1/vendors",
                "method": "GET",
                "responder": {
                    "type": "list_entities",
                    "entity_type": "vendor",
                    "supports_pagination": True,
                    "page_size_default": 25,
                },
                "validators": ["auth_bearer"],
            },
            {
                "path": "/v1/vendors/{id}",
                "method": "GET",
                "responder": {
                    "type": "get_entity",
                    "entity_type": "vendor",
                },
                "validators": ["auth_bearer"],
            },
            {
                "path": "/v1/purchase_orders",
                "method": "GET",
                "responder": {
                    "type": "list_entities",
                    "entity_type": "purchase_order",
                    "supports_pagination": True,
                    "page_size_default": 25,
                },
                "validators": ["auth_bearer"],
            },
            {
                "path": "/v1/purchase_orders/{id}",
                "method": "GET",
                "responder": {
                    "type": "get_entity",
                    "entity_type": "purchase_order",
                },
                "validators": ["auth_bearer"],
            },
            {
                "path": "/v1/purchase_orders",
                "method": "POST",
                "responder": {
                    "type": "create_entity",
                    "entity_type": "purchase_order",
                    "required_fields": ["vendor_id", "line_items"],
                    "id_generator": "po_{ulid}",
                },
                "validators": ["auth_bearer", "json_body"],
            },
        ]
    }
