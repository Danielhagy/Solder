"""
Connector + connection models.

A `Connector` is a static description of one supported third-party API
(name, auth scheme, base URL pattern). The set of supported connectors is
intentionally small and curated — adding one requires the structured
artefacts described in spec § 9.3 (definition, error corpus, optional
business rules, fixtures).

A `Connection` is one user-supplied set of secrets bound to a connector. v1
is single-user local; secrets are encrypted at rest with a per-host key
(spec § 12 Q1). The actual encrypt/decrypt path lives in
`services/connection_crypto.py`; this model just stores the ciphertext +
a non-secret label.

Naming history: this concept was called `Credential` through Slice 2. The
Slice-2.5 refactor renamed it to `Connection` to match the user-facing
mental model — a "connection" is the bound (connector, credentials, label)
triple that an integration can attach to and re-use.
"""

from typing import Optional
from uuid import uuid4

from sqlalchemy import ForeignKey, LargeBinary, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Connector(Base, TimestampMixin):
    """One supported third-party API (Zip, HubSpot, …)."""

    __tablename__ = "connectors"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    # Stable identifier used in routes + corpus filenames. e.g. "zip", "hubspot".
    name: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # `bearer`, `oauth2`, `api_key_header`, `basic`. Discriminator for credential shape.
    auth_scheme: Mapped[str] = mapped_column(String(32), nullable=False)
    # Production base URL (the URL the integration *thinks* it is calling). The
    # mock-engine swaps this at runtime when environment=sandbox.
    base_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    # Brandfetch CDN domain (e.g. "zip.co"). Used by the frontend to render
    # `https://cdn.brandfetch.io/<brand_domain>` for connection chips and the
    # Connections atelier wall. Nullable so a connector without a public brand
    # (internal APIs) can register without forcing a placeholder.
    brand_domain: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # Free-form JSON for connector-specific config (rate limits, default headers,
    # pagination defaults). Not used in v1 logic, scaffolded for future enrichment.
    metadata_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    connections: Mapped[list["Connection"]] = relationship(back_populates="connector")


class Connection(Base, TimestampMixin):
    """User-authored credential bundle.

    Two flavours share the table:

    1. **Built-in connection** (`connector_id` set) — bound to a
       registered `Connector` row (Zip, HubSpot, …). The connector
       defines `auth_scheme` and `base_url`; the user picks one of
       the connector's curated catalog entries when adding a node.

    2. **Custom connection** (`connector_id` null) — the user picked
       one of the five primitive connection types (bearer, api_key_*,
       basic, oauth2_cc) directly. `auth_scheme`, `base_url`, and
       `name` are all user-supplied. The connection is usable from
       any generic HTTP node by alias-style reference; there's no
       palette catalog entry for it (custom services don't have
       hand-curated mock specs).
    """

    __tablename__ = "connections"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    # Nullable: custom connections aren't bound to a registered connector.
    connector_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("connectors.id"), nullable=True, index=True
    )
    # Human-readable label, e.g. "Zip — sandbox tenant", "Acme CRM".
    # Unique per host so the picker shows distinct names.
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    # Discriminator on the auth scheme: 'bearer' | 'api_key_header' |
    # 'api_key_query' | 'basic' | 'oauth2_cc'. For built-in connections
    # this mirrors `connector.auth_scheme`; for customs the user picks.
    auth_scheme: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="bearer"
    )
    # Custom connections need their own base URL; built-in ones can leave
    # this null (the connector's base_url wins at request time).
    base_url: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    # Non-secret per-scheme config — header names, query param names,
    # OAuth token URL, OAuth scope, etc. Always a JSON object; keys
    # are scheme-defined (see `auth_schemes.SCHEMES_BY_ID[<id>].fields`).
    config_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # Encrypted secrets blob. Plaintext shape depends on `auth_scheme`'s
    # secret fields (`scheme.secret_keys()`).
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Nonce / IV for the AEAD cipher. Stored alongside ciphertext.
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

    connector: Mapped[Optional["Connector"]] = relationship(
        back_populates="connections"
    )
