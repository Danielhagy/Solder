"""
HubSpot — CRM. v1's required second connector (FullSpec § 9.2).

Auth: a private-app access token, used as `Authorization: Bearer pat-…`.
HubSpot also supports OAuth and legacy hapikey, but the v1 demo path uses
private-app tokens because they're trivial to issue from the developer
sandbox without the OAuth roundtrip. Discovery focuses on CRM objects
(contacts, companies, deals) which pair with Zip's procurement domain
(vendors → companies, purchase orders → deals) for the mapping flow.

The HubSpot mock spec + corpus arrive in Slice 4; this file is just the
connector identity.
"""

from __future__ import annotations

from typing import Any

from .base import BaseConnector


class HubSpotConnector(BaseConnector):
    name = "hubspot"
    display_name = "HubSpot"
    auth_scheme = "bearer"
    base_url = "https://api.hubapi.com"
    brand_domain = "hubspot.com"

    def auth_headers(self, connection_secret: dict[str, Any]) -> dict[str, str]:
        token = str(connection_secret.get("access_token") or connection_secret.get("token") or "")
        if not token:
            raise ValueError("hubspot connection missing 'access_token'")
        return {"Authorization": f"Bearer {token}"}

    def discoverable_endpoints(self) -> list[dict[str, Any]]:
        return [
            {"path": "/crm/v3/objects/contacts", "method": "GET", "entity_type": "contact"},
            {"path": "/crm/v3/objects/companies", "method": "GET", "entity_type": "company"},
            {"path": "/crm/v3/objects/deals", "method": "GET", "entity_type": "deal"},
        ]
