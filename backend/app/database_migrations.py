"""
v1 single-user-local schema migrations.

`Base.metadata.create_all()` only creates tables that don't exist; it
doesn't ALTER columns or drop tables when the model evolves. This module
runs a small bespoke migration on app startup *before* `create_all` so
the on-disk schema lines up with the live models.

Each migration is idempotent (`IF [NOT] EXISTS` everywhere). Once the
team adopts a real migration tool (Alembic — `alembic` is already in
the dep list, just not wired) these can fold into a real revision file.
For now this is the pragmatic v1 path: zero ceremony, runs on every
startup, no-op when already applied.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine

# Ordered list of `(label, sql)` pairs. Each statement runs in its own
# transaction so a partial failure doesn't strand the rest. Labels are
# logged on apply for grep-ability.
_MIGRATIONS: list[tuple[str, str]] = [
    # ── Slice 2.5 (initial): Credential → Connection rename ──
    # Drop the old `credentials` table outright. v1 single-user-local has
    # no real user-authored credentials (the seed re-creates the demo
    # row); we eat the data loss to keep the migration trivial.
    (
        "drop_legacy_credentials_table",
        "DROP TABLE IF EXISTS credentials CASCADE",
    ),
    # ── Slice 2.5 (initial): drop binary source/target framing on integrations ──
    (
        "drop_integration_source_connector_fk",
        "ALTER TABLE IF EXISTS integrations DROP COLUMN IF EXISTS source_connector_id",
    ),
    (
        "drop_integration_target_connector_fk",
        "ALTER TABLE IF EXISTS integrations DROP COLUMN IF EXISTS target_connector_id",
    ),
    (
        "drop_integration_source_credential_fk",
        "ALTER TABLE IF EXISTS integrations DROP COLUMN IF EXISTS source_credential_id",
    ),
    (
        "drop_integration_target_credential_fk",
        "ALTER TABLE IF EXISTS integrations DROP COLUMN IF EXISTS target_credential_id",
    ),
    (
        "drop_integration_source_test_bank_fk",
        "ALTER TABLE IF EXISTS integrations DROP COLUMN IF EXISTS source_test_bank_id",
    ),
    (
        "drop_integration_target_test_bank_fk",
        "ALTER TABLE IF EXISTS integrations DROP COLUMN IF EXISTS target_test_bank_id",
    ),
    # ── Slice 2.5 (initial): drop legacy `side` columns + index ──
    (
        "drop_legacy_msw_side_index",
        "DROP INDEX IF EXISTS ix_msw_session_side_type_id",
    ),
    (
        "drop_test_banks_side",
        "ALTER TABLE IF EXISTS test_banks DROP COLUMN IF EXISTS side",
    ),
    (
        "drop_mock_specs_side",
        "ALTER TABLE IF EXISTS mock_specs DROP COLUMN IF EXISTS side",
    ),
    (
        "drop_mock_session_writes_side",
        "ALTER TABLE IF EXISTS mock_session_writes DROP COLUMN IF EXISTS side",
    ),
    (
        "drop_run_audit_events_side",
        "ALTER TABLE IF EXISTS run_audit_events DROP COLUMN IF EXISTS side",
    ),
    # ── Slice 2.5 (simplified): drop the IntegrationConnection layer ──
    # The alias indirection turned out to be dead weight under the user's
    # simpler model (connections authored globally; connector is the key).
    # Drop the IC FK columns first (they reference the IC table); then
    # the IC table itself; then the legacy IC index on mock_session_writes.
    (
        "drop_legacy_msw_ic_index",
        "DROP INDEX IF EXISTS ix_msw_session_ic_type_id",
    ),
    (
        "drop_test_banks_ic_fk",
        "ALTER TABLE IF EXISTS test_banks DROP COLUMN IF EXISTS integration_connection_id",
    ),
    (
        "drop_mock_specs_ic_fk",
        "ALTER TABLE IF EXISTS mock_specs DROP COLUMN IF EXISTS integration_connection_id",
    ),
    (
        "drop_mock_session_writes_ic_fk",
        "ALTER TABLE IF EXISTS mock_session_writes DROP COLUMN IF EXISTS integration_connection_id",
    ),
    (
        "drop_run_audit_events_ic_fk",
        "ALTER TABLE IF EXISTS run_audit_events DROP COLUMN IF EXISTS integration_connection_id",
    ),
    (
        "drop_integration_connections_table",
        "DROP TABLE IF EXISTS integration_connections CASCADE",
    ),
    # ── Slice 2.5 (simplified): add `connector_name` columns ──
    # `test_banks` and `mock_specs` already have `api_name` which serves
    # the same purpose; only `mock_session_writes` and `run_audit_events`
    # gain a new column. Default to '' on backfill so existing rows stay
    # readable; new writes always populate it from the route.
    (
        "add_msw_connector_name",
        (
            "ALTER TABLE IF EXISTS mock_session_writes "
            "ADD COLUMN IF NOT EXISTS connector_name VARCHAR(64) NOT NULL DEFAULT ''"
        ),
    ),
    (
        "add_audit_connector_name",
        (
            "ALTER TABLE IF EXISTS run_audit_events "
            "ADD COLUMN IF NOT EXISTS connector_name VARCHAR(64) NOT NULL DEFAULT ''"
        ),
    ),
    # ── Slice 2.5: brand_domain on connectors ──
    (
        "add_connectors_brand_domain",
        "ALTER TABLE IF EXISTS connectors ADD COLUMN IF NOT EXISTS brand_domain VARCHAR(255)",
    ),
    # ── Slice 2.5 (custom connections): expand `connections` row shape ──
    # Custom connections (no built-in connector) need to carry their own
    # auth_scheme + base_url + non-secret config. `connector_id` becomes
    # nullable so customs don't need a placeholder connector row.
    (
        "connections_connector_id_nullable",
        "ALTER TABLE IF EXISTS connections ALTER COLUMN connector_id DROP NOT NULL",
    ),
    (
        "add_connections_auth_scheme",
        (
            "ALTER TABLE IF EXISTS connections "
            "ADD COLUMN IF NOT EXISTS auth_scheme VARCHAR(32) NOT NULL DEFAULT 'bearer'"
        ),
    ),
    (
        "add_connections_base_url",
        "ALTER TABLE IF EXISTS connections ADD COLUMN IF NOT EXISTS base_url VARCHAR(2048)",
    ),
    (
        "add_connections_config_json",
        (
            "ALTER TABLE IF EXISTS connections "
            "ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb"
        ),
    ),
    # Backfill `auth_scheme` from each connection's connector for rows
    # authored before this migration (the column came in with a default
    # of 'bearer' which is correct for both Zip and HubSpot, but for
    # future connectors with non-bearer schemes this guarantees the
    # right value lands).
    (
        "backfill_connections_auth_scheme",
        (
            "UPDATE connections c SET auth_scheme = co.auth_scheme "
            "FROM connectors co WHERE c.connector_id = co.id "
            "AND c.auth_scheme = 'bearer'"
        ),
    ),
    # ── Slice 2.5 (simplified): dedupe test_banks / mock_specs that piled up
    #    during the IC era (one per IC binding instead of one per
    #    connector). Keeps the oldest row per (integration_id, api_name).
    #    `test_bank_entities` doesn't have ON DELETE CASCADE so we drop
    #    its rows for the about-to-be-deleted banks first.
    (
        "dedupe_test_bank_entities_pre",
        (
            "DELETE FROM test_bank_entities WHERE test_bank_id IN ("
            "  SELECT t.id FROM test_banks t WHERE EXISTS ("
            "    SELECT 1 FROM test_banks t2 "
            "    WHERE t2.integration_id = t.integration_id "
            "    AND t2.api_name = t.api_name "
            "    AND t2.created_at < t.created_at"
            "  )"
            ")"
        ),
    ),
    (
        "dedupe_test_banks",
        (
            "DELETE FROM test_banks t USING test_banks t2 "
            "WHERE t.integration_id = t2.integration_id "
            "AND t.api_name = t2.api_name "
            "AND t.created_at > t2.created_at"
        ),
    ),
    (
        "dedupe_mock_specs",
        (
            "DELETE FROM mock_specs m USING mock_specs m2 "
            "WHERE m.integration_id = m2.integration_id "
            "AND m.api_name = m2.api_name "
            "AND m.version = m2.version "
            "AND m.created_at > m2.created_at"
        ),
    ),
    # ── Soft-delete tracking on integrations ──
    # `deleted_at` records WHEN the soft-delete happened so the frontend
    # can render "deleted X ago" and the purge cron can hard-delete rows
    # past the 30-day TTL. Idempotent: IF NOT EXISTS keeps multi-restart
    # boots clean.
    (
        "add_integrations_deleted_at",
        "ALTER TABLE integrations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ",
    ),
    # ── Sandboxes v1: per-connection sandbox configuration ──
    # The integration→connector keying for mock-engine state is being
    # replaced by per-connection. v1 is additive: `connection_id` lands
    # nullable on `mock_specs` and `test_banks` alongside the existing
    # `integration_id`. Task #2 (route migration) flips reads/writes onto
    # `connection_id`; a later cleanup migration drops `integration_id`.
    #
    # `connections.sandbox_mode` discriminates how this connection is
    # served at sandbox-env time: 'none' (no sandbox configured),
    # 'vendor' (use vendor sandbox creds — base_url + secrets in
    # `sandbox_config` override prod), 'synthetic' (mock-engine serves
    # synthesised data, primed from OpenAPI + active probe + observed
    # traffic). `sandbox_config` carries the per-mode payload (vendor
    # sandbox base_url/credentials, KB opt-in flag, last-prime timestamp,
    # endpoint coverage stats).
    (
        "add_connections_sandbox_mode",
        (
            "ALTER TABLE IF EXISTS connections "
            "ADD COLUMN IF NOT EXISTS sandbox_mode VARCHAR(16) "
            "NOT NULL DEFAULT 'none'"
        ),
    ),
    (
        "add_connections_sandbox_config",
        (
            "ALTER TABLE IF EXISTS connections "
            "ADD COLUMN IF NOT EXISTS sandbox_config JSONB "
            "NOT NULL DEFAULT '{}'::jsonb"
        ),
    ),
    (
        "add_mock_specs_connection_id",
        (
            "ALTER TABLE IF EXISTS mock_specs "
            "ADD COLUMN IF NOT EXISTS connection_id UUID "
            "REFERENCES connections(id)"
        ),
    ),
    (
        "add_mock_specs_connection_id_index",
        (
            "CREATE INDEX IF NOT EXISTS ix_mock_specs_connection_id "
            "ON mock_specs(connection_id)"
        ),
    ),
    (
        "add_test_banks_connection_id",
        (
            "ALTER TABLE IF EXISTS test_banks "
            "ADD COLUMN IF NOT EXISTS connection_id UUID "
            "REFERENCES connections(id)"
        ),
    ),
    (
        "add_test_banks_connection_id_index",
        (
            "CREATE INDEX IF NOT EXISTS ix_test_banks_connection_id "
            "ON test_banks(connection_id)"
        ),
    ),
    # Drop NOT NULL on the legacy integration_id columns so new code
    # paths can persist with `connection_id` alone. Cleanup migration
    # will drop these columns entirely once all callers move.
    (
        "mock_specs_integration_id_nullable",
        "ALTER TABLE IF EXISTS mock_specs ALTER COLUMN integration_id DROP NOT NULL",
    ),
    (
        "test_banks_integration_id_nullable",
        "ALTER TABLE IF EXISTS test_banks ALTER COLUMN integration_id DROP NOT NULL",
    ),
    # ── Process Diagram editor (Phase 1) ──
    # Backfills the columns the new ProcessDiagram-aware code paths read.
    # `create_all` only adds missing TABLES, not missing COLUMNS, so these
    # ALTER statements are mandatory on any non-fresh DB.
    (
        "openapi_specs_entity_schemas",
        (
            "ALTER TABLE IF EXISTS openapi_specs "
            "ADD COLUMN IF NOT EXISTS entity_schemas JSONB NOT NULL DEFAULT '{}'::jsonb"
        ),
    ),
    (
        "connections_openapi_spec_id",
        (
            "ALTER TABLE IF EXISTS connections "
            "ADD COLUMN IF NOT EXISTS openapi_spec_id UUID REFERENCES openapi_specs(id)"
        ),
    ),
    (
        "connections_openapi_spec_id_index",
        (
            "CREATE INDEX IF NOT EXISTS ix_connections_openapi_spec_id "
            "ON connections(openapi_spec_id)"
        ),
    ),
    (
        "integrations_next_run_at",
        (
            "ALTER TABLE IF EXISTS integrations "
            "ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMP WITH TIME ZONE"
        ),
    ),
    (
        "integrations_next_run_at_index",
        (
            "CREATE INDEX IF NOT EXISTS ix_integrations_next_run_at "
            "ON integrations(next_run_at)"
        ),
    ),
]


async def run_dev_migrations(engine: AsyncEngine) -> list[str]:
    """Apply each statement **in its own transaction**; return the labels of
    those that ran without raising. Errors are swallowed so a single
    broken statement doesn't block boot — log the label and keep going.

    Per-statement transactions are critical: a failure in stmt N would
    otherwise poison the connection for stmts N+1..M with
    `current transaction is aborted, commands ignored`.
    """
    from sqlalchemy import text  # local import to avoid heavy module load on import

    applied: list[str] = []
    for label, sql in _MIGRATIONS:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
            applied.append(label)
        except Exception as e:  # pragma: no cover — startup-only path
            # Common case: target table doesn't exist yet. That's OK
            # (the migration becomes a no-op on first boot for fresh
            # DBs; `create_all` then makes the right tables).
            print(f"[dev-migration] {label} skipped: {e}")
    return applied
