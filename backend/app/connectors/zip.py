"""
Zip — procurement / accounts-payable platform. v1's primary demo connector.

The mock-engine ships with a hand-authored Zip mock spec (see
`backend/app/services/seed_demo.py`) so this connector is fully exercisable
in sandbox today. Production credentials use a Bearer token issued from
the Zip API console.
"""

from __future__ import annotations

from typing import Any

from .base import BaseConnector


class ZipConnector(BaseConnector):
    name = "zip"
    display_name = "Zip"
    auth_scheme = "bearer"
    base_url = "https://api.zip.co"
    brand_domain = "zip.co"

    def auth_headers(self, connection_secret: dict[str, Any]) -> dict[str, str]:
        token = str(connection_secret.get("token") or "")
        if not token:
            raise ValueError("zip connection missing 'token' field")
        return {"Authorization": f"Bearer {token}"}

    def discoverable_endpoints(self) -> list[dict[str, Any]]:
        # Discovery (FullSpec § 7.1) GET-samples each of these to learn the
        # field shapes; POST/PUT/DELETE routes are inferred or hand-added.
        return [
            {"path": "/v1/vendors", "method": "GET", "entity_type": "vendor"},
            {"path": "/v1/purchase_orders", "method": "GET", "entity_type": "purchase_order"},
            {"path": "/v1/users", "method": "GET", "entity_type": "user"},
        ]
