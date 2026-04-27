"""
Loads a `MockSpec` for the (integration, connector_name) under request.

Hot path — every mock request hits this. v1 keeps it simple: one DB query
per request, ordered by version DESC. Caching is a future optimisation
that should sit *here*, with explicit invalidation when a spec is written.

Slice 2.5: pre-2.5 keyed off `side`; mid-2.5 keyed off
`integration_connection_id`; the simplified model keys off `api_name`
(= the connector's stable name, e.g. "zip"). Multiple connections to
the same connector share one spec.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MockSpec


async def load_spec(
    db: AsyncSession,
    integration_id: str,
    connector_name: str,
) -> Optional[MockSpec]:
    """Return the latest mock spec for (integration, connector), or None.

    Additive layering (FullSpec § 11): when more than one spec version
    exists for a given binding, the highest version wins — later layers
    always supersede earlier ones for matching routes, but earlier
    layers' provenance is preserved on disk.
    """
    stmt = (
        select(MockSpec)
        .where(
            MockSpec.integration_id == integration_id,
            MockSpec.api_name == connector_name,
        )
        .order_by(MockSpec.version.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


def find_route(spec: MockSpec, method: str, path: str) -> Optional[dict]:
    """Match `method`/`path` against the spec's `routes` array.

    Path templates support `{name}` placeholders (e.g.
    `/v1/purchase_orders/{id}`). Captured values aren't returned here —
    the request_validator + response_generator each re-parse from the
    request path because they need different captures (validators want
    body fields; responders want route params).
    """
    routes = spec.routes.get("routes", []) if isinstance(spec.routes, dict) else []
    for route in routes:
        if route.get("method", "").upper() != method.upper():
            continue
        if _path_matches(route.get("path", ""), path):
            return route
    return None


def extract_path_params(template: str, path: str) -> dict[str, str]:
    """For a matching template + path, return a `{param: value}` map."""
    t_parts = template.strip("/").split("/")
    p_parts = path.strip("/").split("/")
    if len(t_parts) != len(p_parts):
        return {}
    out: dict[str, str] = {}
    for tp, pp in zip(t_parts, p_parts):
        if tp.startswith("{") and tp.endswith("}"):
            out[tp[1:-1]] = pp
    return out


def _path_matches(template: str, path: str) -> bool:
    t_parts = template.strip("/").split("/")
    p_parts = path.strip("/").split("/")
    if len(t_parts) != len(p_parts):
        return False
    for tp, pp in zip(t_parts, p_parts):
        if tp.startswith("{") and tp.endswith("}"):
            continue
        if tp != pp:
            return False
    return True
