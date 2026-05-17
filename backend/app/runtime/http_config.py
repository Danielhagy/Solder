"""HTTP node v2 — shared pure helpers.

Used by both the workflow path (`app.temporal.workflows._execute_api_call`)
and the per-node test path (`app.services.node_test_executor._http_request`)
so the two paths interpret the v2 config (KvRow[] headers/params, HttpBody
discriminator, HttpAuth override) identically.

Everything here is pure: no I/O, no clock, no random, no DB. Determinism is
required because workflows.py imports this through
``workflow.unsafe.imports_passed_through``.
"""

from typing import Any, Optional


def flatten_kv_rows(raw: Any) -> dict[str, str]:
    """Collapse v2 KvRow[] OR legacy dict into the wire-shape dict.

    Per-row ``enabled=false`` and empty keys are filtered out. Duplicate
    keys take the last value (matches Postman/httpx behaviour).
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items() if k}
    if isinstance(raw, list):
        out: dict[str, str] = {}
        for row in raw:
            if not isinstance(row, dict):
                continue
            if row.get("enabled") is False:
                continue
            key = row.get("key")
            if not key:
                continue
            value = row.get("value")
            out[str(key)] = "" if value is None else str(value)
        return out
    return {}


def normalize_http_body(raw: Any) -> Any:
    """Map a v2 HttpBody dict to the legacy body shape consumed by
    ``app.runtime.interpolate.render_request_body`` (dict | str | None).

    Pass-through for legacy values so existing nodes keep working.
    """
    if raw is None:
        return None
    if isinstance(raw, (str, list)):
        return raw
    if isinstance(raw, dict) and "mode" in raw:
        mode = raw.get("mode")
        if mode == "none":
            return None
        if mode == "json":
            value = raw.get("json")
            return value if value is not None else None
        if mode in ("template", "raw"):
            text = raw.get("text") or ""
            return text or None
        if mode == "form":
            return flatten_kv_rows(raw.get("form"))
        if mode == "graphql":
            return {
                "query": raw.get("text") or "",
                "variables": raw.get("graphqlVariables") or {},
            }
        return None
    # Legacy dict (no `mode` key) — already the right shape.
    return raw


def legacy_auth_from_v2(auth_v2: Any) -> Optional[dict]:
    """Translate ``node.config.auth`` v2 shape into the legacy auth dict the
    ``_apply_auth`` activity helper understands.

    Returns ``None`` for 'inherit' (caller falls back to resolved-Connection
    auth) and 'none' (caller strips Authorization).
    """
    if not isinstance(auth_v2, dict):
        return auth_v2  # legacy passthrough
    mode = auth_v2.get("mode")
    if mode in (None, "inherit", "none"):
        return None
    if mode == "bearer":
        return {"type": "bearer", "token": auth_v2.get("bearerToken") or ""}
    if mode == "basic":
        return {
            "type": "basic",
            "username": auth_v2.get("basicUsername") or "",
            "password": auth_v2.get("basicPassword") or "",
        }
    if mode == "api_key_header":
        return {
            "type": "api_key",
            "in": "header",
            "name": auth_v2.get("apiKeyName") or "X-API-Key",
            "value": auth_v2.get("apiKeyValue") or "",
        }
    if mode == "api_key_query":
        return {
            "type": "api_key",
            "in": "query",
            "name": auth_v2.get("apiKeyName") or "api_key",
            "value": auth_v2.get("apiKeyValue") or "",
        }
    return None


def extract_path_for_resolver(url: str) -> str:
    """Pull the path component out of either a full URL or a bare path so
    a Connection resolver can join it onto the Connection's base_url."""
    if not url:
        return "/"
    if url.startswith(("http://", "https://")):
        rest = url.split("://", 1)[1]
        slash = rest.find("/")
        if slash < 0:
            return "/"
        return rest[slash:]
    return url if url.startswith("/") else "/" + url


def auth_mode_of(auth_v2: Any) -> Optional[str]:
    """Convenience accessor for ``auth.mode`` that handles missing/legacy."""
    if isinstance(auth_v2, dict):
        return auth_v2.get("mode")
    return None
