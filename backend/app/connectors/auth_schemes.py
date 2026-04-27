"""
The five connection types Solder supports natively.

A "connection type" is a discrete authentication scheme an API can speak.
Built-in connectors (`Zip`, `HubSpot`) pin a single scheme each — they're
just curated wrappers on top of these primitives. **Custom connections**
(connections without a registered connector) let users pick a scheme
directly: name the service, choose its auth, paste the secrets.

Each scheme is described by:
  - `id`           — stable string used as the discriminator on
                      `Connection.auth_scheme`.
  - `label`        — display name in the picker.
  - `description`  — one-line copy shown under the picker.
  - `fields`       — ordered list of input fields the user fills in.
                      `secret=True` means the value goes into the
                      AES-GCM ciphertext blob; `secret=False` means
                      it lives in the row's plaintext config_json
                      (header names, token URLs, etc — non-sensitive
                      and useful for filtering / display).

`apply()` is the runtime contract: given a (scheme, secrets, config) and
an outgoing request shape (method/url/headers/params), return the
amended request shape with auth applied. Used by the workflow runtime
when a node references a connection.

This module has no DB or HTTP dependencies — it's pure data + pure
functions. The OAuth2 client-credentials flow is the one exception
(needs to fetch a token); we expose `oauth2_token_url(...)` separately
so callers can do the fetch in their own async context and cache.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Mapping, Optional


@dataclass(frozen=True)
class AuthField:
    """One input on a connection-type form."""

    key: str
    label: str
    secret: bool
    required: bool
    default: Optional[str] = None
    placeholder: Optional[str] = None
    help: Optional[str] = None


@dataclass(frozen=True)
class AuthScheme:
    id: str
    label: str
    description: str
    fields: tuple[AuthField, ...]

    def secret_keys(self) -> tuple[str, ...]:
        return tuple(f.key for f in self.fields if f.secret)

    def public_keys(self) -> tuple[str, ...]:
        return tuple(f.key for f in self.fields if not f.secret)

    def required_keys(self) -> tuple[str, ...]:
        return tuple(f.key for f in self.fields if f.required)


# ── The five built-in connection types ──────────────────────────────────

BEARER = AuthScheme(
    id="bearer",
    label="Bearer Token",
    description=(
        "Single token in `Authorization: Bearer <token>`. The lingua "
        "franca of modern APIs — OAuth 2 access tokens, GitHub PATs, "
        "Anthropic / OpenAI keys."
    ),
    fields=(
        AuthField(
            key="token",
            label="Token",
            secret=True,
            required=True,
            placeholder="pat-…",
            help="Pasted as-is into the Authorization header.",
        ),
    ),
)

API_KEY_HEADER = AuthScheme(
    id="api_key_header",
    label="API Key (Header)",
    description=(
        "Custom request header — `X-API-Key`, `Api-Key`, `Authorization`, "
        "anything the vendor specifies. Pick the header name and the key."
    ),
    fields=(
        AuthField(
            key="header_name",
            label="Header name",
            secret=False,
            required=True,
            default="X-API-Key",
            placeholder="X-API-Key",
        ),
        AuthField(
            key="key",
            label="API key",
            secret=True,
            required=True,
        ),
    ),
)

API_KEY_QUERY = AuthScheme(
    id="api_key_query",
    label="API Key (Query Parameter)",
    description=(
        "Token appended to every request URL as a query parameter. Less "
        "secure than headers (logged by intermediaries) — use only when "
        "the vendor requires it."
    ),
    fields=(
        AuthField(
            key="param_name",
            label="Parameter name",
            secret=False,
            required=True,
            default="api_key",
            placeholder="api_key",
        ),
        AuthField(
            key="key",
            label="API key",
            secret=True,
            required=True,
        ),
    ),
)

BASIC = AuthScheme(
    id="basic",
    label="Basic Auth",
    description=(
        "Username + password, base64-encoded into `Authorization: Basic`. "
        "Common for older REST APIs and the GitHub `username:token` style."
    ),
    fields=(
        AuthField(
            key="username",
            label="Username",
            secret=False,
            required=True,
        ),
        AuthField(
            key="password",
            label="Password",
            secret=True,
            required=True,
        ),
    ),
)

OAUTH2_CC = AuthScheme(
    id="oauth2_cc",
    label="OAuth 2.0 Client Credentials",
    description=(
        "Service-to-service flow. Exchanges `client_id` + `client_secret` "
        "at the vendor's token URL for a short-lived bearer token, "
        "then calls the API with that token. Solder caches the token "
        "until it expires."
    ),
    fields=(
        AuthField(
            key="client_id",
            label="Client ID",
            secret=False,
            required=True,
        ),
        AuthField(
            key="client_secret",
            label="Client secret",
            secret=True,
            required=True,
        ),
        AuthField(
            key="token_url",
            label="Token URL",
            secret=False,
            required=True,
            placeholder="https://auth.example.com/oauth/token",
            help="The vendor-published token endpoint that returns an access token.",
        ),
        AuthField(
            key="scope",
            label="Scope",
            secret=False,
            required=False,
            placeholder="read:users write:contacts",
            help="Optional — space-separated list of OAuth scopes.",
        ),
    ),
)


SCHEMES: tuple[AuthScheme, ...] = (
    BEARER,
    API_KEY_HEADER,
    API_KEY_QUERY,
    BASIC,
    OAUTH2_CC,
)
SCHEMES_BY_ID: Mapping[str, AuthScheme] = {s.id: s for s in SCHEMES}


def get_scheme(scheme_id: str) -> AuthScheme:
    """Return the scheme by id; raise `KeyError` if unknown."""
    if scheme_id not in SCHEMES_BY_ID:
        raise KeyError(f"unknown connection type {scheme_id!r}")
    return SCHEMES_BY_ID[scheme_id]


# ── Runtime: apply the scheme to an outgoing request ────────────────────


@dataclass
class AppliedAuth:
    """Result of applying an auth scheme to an outgoing request.

    The fields are *additive* — the caller merges them into whatever
    headers/params the node config already declared. We never mutate
    in place because some middlewares (Temporal activity replay) hash
    request shapes.
    """

    headers: dict[str, str]
    query: dict[str, str]


def apply(
    scheme_id: str,
    *,
    secrets: Mapping[str, Any],
    config: Mapping[str, Any],
    fetched_token: Optional[str] = None,
) -> AppliedAuth:
    """Build the auth headers/query for a given scheme + values.

    Parameters
    ----------
    scheme_id   : stable scheme id (e.g. "bearer").
    secrets     : decrypted secret keys for the scheme (e.g. `{"token": "..."}`).
    config      : non-secret config keys (e.g. `{"header_name": "X-API-Key"}`).
                  The two are unioned; if the same key appears in both the
                  secret value wins (defensive — secrets are authoritative).
    fetched_token : for `oauth2_cc`, the access token previously obtained
                  from `token_url` exchange. Required for that scheme; the
                  caller is responsible for the fetch + cache.
    """
    bag: dict[str, Any] = {**dict(config), **dict(secrets)}

    if scheme_id == "bearer":
        token = str(bag.get("token") or "")
        if not token:
            raise ValueError("bearer connection missing 'token'")
        return AppliedAuth(headers={"Authorization": f"Bearer {token}"}, query={})

    if scheme_id == "api_key_header":
        name = str(bag.get("header_name") or "X-API-Key")
        key = str(bag.get("key") or "")
        if not key:
            raise ValueError("api_key_header connection missing 'key'")
        return AppliedAuth(headers={name: key}, query={})

    if scheme_id == "api_key_query":
        name = str(bag.get("param_name") or "api_key")
        key = str(bag.get("key") or "")
        if not key:
            raise ValueError("api_key_query connection missing 'key'")
        return AppliedAuth(headers={}, query={name: key})

    if scheme_id == "basic":
        user = str(bag.get("username") or "")
        password = str(bag.get("password") or "")
        if not user or not password:
            raise ValueError("basic connection missing 'username' or 'password'")
        encoded = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
        return AppliedAuth(headers={"Authorization": f"Basic {encoded}"}, query={})

    if scheme_id == "oauth2_cc":
        if not fetched_token:
            raise ValueError(
                "oauth2_cc requires a fetched_token — call the token_url first"
            )
        return AppliedAuth(
            headers={"Authorization": f"Bearer {fetched_token}"}, query={}
        )

    raise KeyError(f"unknown connection type {scheme_id!r}")
