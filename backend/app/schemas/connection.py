"""
Pydantic schemas for `/api/connections`.

A connection is a user-authored credential bundle. Two flavours:

  - **Built-in** — `connector_id` set; auth scheme + base URL inherited
    from the bound `Connector` row.
  - **Custom**   — `connector_id` null; user picks one of the five
    `auth_schemes.SCHEMES` directly, names the connection, optionally
    supplies a base URL. Usable from any generic HTTP node.

`ConnectionIn` carries plaintext secrets up the wire; the API layer
encrypts via `connection_crypto.encrypt` and persists `(ciphertext, nonce)`.
`ConnectionOut` never includes secrets — only label, scheme, base URL,
and the non-secret `config_json` (header names, token URLs, etc).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator


class ConnectionIn(BaseModel):
    label: str = Field(
        min_length=1,
        max_length=255,
        description="Human-readable label, e.g. 'Zip — sandbox tenant' or 'Acme CRM'.",
    )
    # Either `connector_id` (built-in) or `auth_scheme` (custom). Both
    # may be set when the user picks a built-in but overrides the scheme.
    connector_id: Optional[str] = Field(
        default=None,
        description="UUID of a registered Connector row. Null for custom connections.",
    )
    auth_scheme: Optional[str] = Field(
        default=None,
        description=(
            "One of: bearer, api_key_header, api_key_query, basic, oauth2_cc. "
            "Required when connector_id is null."
        ),
    )
    base_url: Optional[str] = Field(
        default=None,
        max_length=2048,
        description="Service base URL. Optional for built-in connections.",
    )
    # Per-scheme shape; the scheme's `fields` decide which keys are
    # required + which are secret. Non-secret values get persisted to
    # `config_json`; secret values to the encrypted `ciphertext` blob.
    secrets: dict[str, Any] = Field(
        default_factory=dict,
        description="Plaintext secret values — encrypted at rest immediately on receipt.",
    )
    config: dict[str, Any] = Field(
        default_factory=dict,
        description="Non-secret config values (header names, token URLs, etc).",
    )

    @model_validator(mode="after")
    def _check_one_of(self) -> "ConnectionIn":
        if self.connector_id is None and self.auth_scheme is None:
            raise ValueError(
                "either connector_id or auth_scheme is required"
            )
        return self


class ConnectionOut(BaseModel):
    """Read-shape — never includes ciphertext or plaintext secrets."""

    id: str
    connector_id: Optional[str]
    label: str
    auth_scheme: str
    base_url: Optional[str]
    config_json: dict[str, Any]
    created_at: datetime
    updated_at: datetime
