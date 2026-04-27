"""
Pydantic schemas for the read-only `/api/connectors` API.

The DB row carries provenance; the API surface is the registry-derived
shape (display_name, auth_scheme, base_url, list of discoverable endpoints
for UI hinting). The DB id + the registry name are both returned so the
client can use either as a foreign key when creating a credential.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class DiscoverableEndpoint(BaseModel):
    path: str
    method: str
    entity_type: str


class ConnectorOut(BaseModel):
    """One supported third-party API."""

    id: str
    name: str
    display_name: str
    auth_scheme: str
    base_url: str
    # Brandfetch CDN domain — frontend renders
    # `https://cdn.brandfetch.io/<brand_domain>` for the logo.
    brand_domain: str | None = None
    description: str | None = None
    discoverable_endpoints: list[DiscoverableEndpoint] = []
    metadata_json: dict[str, Any] = {}
