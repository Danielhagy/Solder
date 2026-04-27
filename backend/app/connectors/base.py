"""
Base connector contract — what every supported API definition must provide.

Lightweight ABC; the bulk of behaviour lives in declarative data (the mock
spec, the error corpus, the connection's auth_scheme). Connector classes
exist mainly to:
  - Adapt connection secrets → outgoing HTTP auth headers
  - Document the connector's pagination conventions (cursor names, page
    parameters, list envelope shape)
  - Provide schema discovery hints (which endpoints are safe to GET-sample,
    which entity types the API exposes)
  - Carry the brand identity (`brand_domain`) used by the frontend to
    fetch a logo from Brandfetch's CDN.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional


class BaseConnector(ABC):
    """One supported third-party API."""

    name: str  # 'zip', 'hubspot'
    display_name: str
    auth_scheme: str  # 'bearer' | 'oauth2' | 'api_key_header' | 'basic'
    base_url: str
    # Public registered domain used by `https://cdn.brandfetch.io/<brand_domain>`
    # to render the connector's logo. None for connectors with no public
    # brand (the frontend falls back to a typographic mark).
    brand_domain: Optional[str] = None

    @abstractmethod
    def auth_headers(self, connection_secret: dict[str, Any]) -> dict[str, str]:
        """Translate decrypted connection secrets → HTTP headers."""
        raise NotImplementedError

    @abstractmethod
    def discoverable_endpoints(self) -> list[dict[str, Any]]:
        """Endpoints safe to GET-sample during discovery."""
        raise NotImplementedError
