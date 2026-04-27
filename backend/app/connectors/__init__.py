"""
Connector definitions — one per supported third-party API (Zip, HubSpot, ...).

Adding a connector requires (FullSpec.md § 9.3):
  - A definition: name, type, auth scheme, base URL
  - An error corpus at backend/app/mock_engine/error_corpora/{name}.json
  - Optional: a hand-curated business_rules block in the mock spec
  - Test fixtures showing example requests/responses

The `REGISTRY` below is the runtime source of truth. New connectors are
added by importing the class and dropping it into the dict; the
`/api/connectors` endpoint reads off this map, so registering is the only
wiring step required for the front-end to see a new connector.
"""

from .base import BaseConnector
from .hubspot import HubSpotConnector
from .zip import ZipConnector

REGISTRY: dict[str, BaseConnector] = {
    "zip": ZipConnector(),
    "hubspot": HubSpotConnector(),
}


def get(name: str) -> BaseConnector | None:
    return REGISTRY.get(name)


__all__ = ["BaseConnector", "REGISTRY", "get", "ZipConnector", "HubSpotConnector"]
