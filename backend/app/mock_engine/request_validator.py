"""
Request validation against a mock spec's `request_validators` block.

v1 supports a small set of validators referenced by name from each route
entry. Each validator is a deterministic check; a failure produces a
`ValidationFailure` carrying enough metadata for the router to assemble a
real-shaped response (status code + body) without the validator itself
needing to know connector-specific shapes.

Supported validators (v1):
- `auth_bearer`     — request must have `Authorization: Bearer <token>`.
                      Token *value* is not checked here (credentials live
                      in our store, not the mock spec).
- `json_body`       — POST / PUT / PATCH body must parse as JSON object.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional


@dataclass
class ValidationFailure:
    status: int
    error_id: str
    message: str
    field: Optional[str] = None


def validate(
    *,
    validators: Iterable[str],
    method: str,
    headers: Mapping[str, str],
    body: Optional[Mapping[str, Any]],
) -> Optional[ValidationFailure]:
    """Run each named validator. Returns the first failure or None on pass."""
    for name in validators or ():
        fail = _RUNNERS.get(name)
        if fail is None:
            # Unknown validators are conservatively accepted — the spec is
            # the source of truth, but we don't want a typo to brick a
            # whole route. Logged at the router level if we want noise.
            continue
        result = fail(method=method, headers=headers, body=body)
        if result is not None:
            return result
    return None


def _auth_bearer(
    *, method: str, headers: Mapping[str, str], body: Optional[Mapping[str, Any]]
) -> Optional[ValidationFailure]:
    auth = _ci_get(headers, "authorization") or ""
    if not auth.lower().startswith("bearer "):
        return ValidationFailure(
            status=401,
            error_id="zip.auth.invalid_bearer",
            message="Missing or invalid bearer token",
        )
    token = auth.split(None, 1)[1].strip()
    if not token:
        return ValidationFailure(
            status=401,
            error_id="zip.auth.invalid_bearer",
            message="Missing or invalid bearer token",
        )
    return None


def _json_body(
    *, method: str, headers: Mapping[str, str], body: Optional[Mapping[str, Any]]
) -> Optional[ValidationFailure]:
    if method.upper() not in ("POST", "PUT", "PATCH"):
        return None
    if not isinstance(body, dict):
        return ValidationFailure(
            status=400,
            error_id="zip.body.malformed",
            message="Request body must be a JSON object",
        )
    return None


def _ci_get(headers: Mapping[str, str], key: str) -> Optional[str]:
    """Headers are case-insensitive; the underlying mapping might not be."""
    target = key.lower()
    for k, v in headers.items():
        if k.lower() == target:
            return v
    return None


_RUNNERS = {
    "auth_bearer": _auth_bearer,
    "json_body": _json_body,
}
