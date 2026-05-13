"""
Ramp — spend management & procurement-to-pay platform.

Demo-able vertical for the NewMedCo P2P slice: Bills, Bill Payments
(nested under bills), Vendors, Purchase Orders, Item Receipts, and
Accounting Fields. The procurement subset of Ramp's Developer API is
bundled at `spec_assets/ramp-procurement.json` (regenerate with
`python -m app.connectors.spec_assets._build_ramp_spec` after pulling
a fresh upstream spec). The seed step on startup loads it into the
`openapi_specs` table so the wizard can attach it to a connection.

Auth: Ramp's real flow is OAuth2 client-credentials issuing a 10-day
bearer. The demo connector accepts `{token: "..."}` directly so
operators can paste the access token they already exchanged via
`POST /developer/v1/token`. Wiring full client-credentials handling
into the generic auth-scheme machinery is a follow-up.
"""

from __future__ import annotations

from typing import Any

from .base import BaseConnector


class RampConnector(BaseConnector):
    name = "ramp"
    display_name = "Ramp"
    auth_scheme = "bearer"
    # Default points at Ramp's published demo environment. Switch a
    # connection's `base_url` to `https://api.ramp.com` for production.
    base_url = "https://demo-api.ramp.com"
    brand_domain = "ramp.com"

    def auth_headers(self, connection_secret: dict[str, Any]) -> dict[str, str]:
        token = str(connection_secret.get("token") or "")
        if not token:
            raise ValueError("ramp connection missing 'token' field")
        return {"Authorization": f"Bearer {token}"}

    def discoverable_endpoints(self) -> list[dict[str, Any]]:
        # Read-side procurement collections — discovery (FullSpec § 7.1)
        # GET-samples each one to learn field shapes for the entity.
        # Item-receipts is read-only on Ramp's side, so it's safe here.
        return [
            {"path": "/developer/v1/bills", "method": "GET", "entity_type": "bill"},
            {"path": "/developer/v1/purchase-orders", "method": "GET", "entity_type": "purchase_order"},
            {"path": "/developer/v1/item-receipts", "method": "GET", "entity_type": "item_receipt"},
            {"path": "/developer/v1/vendors", "method": "GET", "entity_type": "vendor"},
            {"path": "/developer/v1/accounting/fields", "method": "GET", "entity_type": "accounting_field"},
            {"path": "/developer/v1/entities", "method": "GET", "entity_type": "entity"},
        ]
