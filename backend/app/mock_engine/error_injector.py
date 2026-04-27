"""
Decides whether a request should be answered with an error from the
connector's static error corpus (FullSpec.md § 5.4).

Trigger types (v1):
- `field_value`      — error fires when a request body field's value
                       satisfies a predicate (e.g. `vendor_id` is
                       `not_in_test_bank`).
- `request_shape`    — error fires when the request body is malformed
                       (missing required field).
- `random`           — error fires randomly when chaos mode is on, weighted
                       by the entry's `chaos_weight`.
- `manual`           — error only fires when the test UI explicitly asks
                       for it via a request header (`X-Solder-Force-Error`).

The injector is purely deterministic except in `random` mode. Chaos seed
defaults to a fixed value so test runs are reproducible.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

CORPORA_DIR = Path(__file__).resolve().parent / "error_corpora"
_corpus_cache: dict[str, dict] = {}

# Module-level chaos RNG. Reseeding per request with a constant `chaos_seed`
# (the previous behavior) made every request produce the same `random.random()`
# value, so weights below ~0.85 never fired. The mock-engine wants chaos to
# *vary* across requests; we want determinism only across a *test run*. So
# the seed defaults to system entropy and the RNG is shared. Tests that
# require reproducibility can call `_reseed_chaos(seed)`.
_chaos_rng: random.Random = random.Random()


def _reseed_chaos(seed: Optional[int]) -> None:
    """Test hook: reseed the module-level RNG. Production callers shouldn't
    need this; chaos mode is opt-in via the `X-Solder-Chaos` header."""
    global _chaos_rng
    _chaos_rng = random.Random(seed)


@dataclass
class InjectedError:
    error_id: str
    status: int
    body: dict[str, Any]
    headers: dict[str, str]


def load_corpus(api_name: str) -> Optional[dict]:
    """Read + memoise an api's error corpus JSON. Returns None when absent."""
    if api_name in _corpus_cache:
        return _corpus_cache[api_name]
    path = CORPORA_DIR / f"{api_name}.json"
    if not path.is_file():
        return None
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    _corpus_cache[api_name] = data
    return data


def maybe_inject(
    *,
    api_name: str,
    method: str,
    path_template: str,
    body: Optional[Mapping[str, Any]],
    headers: Mapping[str, str],
    bank_entity_ids: Mapping[str, set[str]],
    chaos_mode: bool = False,
) -> Optional[InjectedError]:
    """Walk the corpus; return the first error whose trigger fires.

    `bank_entity_ids` maps `entity_type -> set[entity_id]` so `field_value`
    triggers can resolve `not_in_test_bank` without re-querying the DB on
    every request — the router pre-builds this from the active spec.
    Chaos mode shares the module-level `_chaos_rng` so successive requests
    actually produce different probabilities; tests can reseed via
    `_reseed_chaos`.
    """
    corpus = load_corpus(api_name)
    if corpus is None:
        return None

    rng = _chaos_rng if chaos_mode else None
    routekey = f"{method.upper()} {path_template}"

    for entry in corpus.get("errors", []):
        if not _route_applies(entry, routekey):
            continue
        trigger = entry.get("trigger", {})
        ttype = trigger.get("type")

        if ttype == "field_value":
            if not _field_value_matches(trigger, body, bank_entity_ids):
                continue
        elif ttype == "request_shape":
            if not _request_shape_matches(trigger, body):
                continue
        elif ttype == "random":
            if rng is None:
                continue
            weight = float(entry.get("frequency", {}).get("chaos_weight", 0.0))
            if weight <= 0.0 or rng.random() >= weight:
                continue
        elif ttype == "manual":
            forced = _ci_get(headers, "x-solder-force-error")
            if forced != entry.get("id"):
                continue
        else:
            continue

        return _build_injected(entry, body)
    return None


def _route_applies(entry: dict, routekey: str) -> bool:
    targets = entry.get("applies_to_routes") or []
    if "*" in targets:
        return True
    return routekey in targets


def _field_value_matches(
    trigger: dict,
    body: Optional[Mapping[str, Any]],
    bank_entity_ids: Mapping[str, set[str]],
) -> bool:
    field = trigger.get("field")
    cond = trigger.get("condition")
    if not isinstance(body, Mapping) or field is None:
        return False
    val = body.get(field)
    if cond == "not_in_test_bank":
        # Convention: a field named `<entity>_id` is a reference to that
        # entity_type. Empty / missing values are flagged as not-in-bank
        # so callers can't bypass by omitting the field.
        if not isinstance(val, str) or not val:
            return True
        entity_type = field[:-3] if field.endswith("_id") else field
        ids = bank_entity_ids.get(entity_type, set())
        return val not in ids
    if cond == "equals":
        return val == trigger.get("value")
    return False


def _request_shape_matches(
    trigger: dict, body: Optional[Mapping[str, Any]]
) -> bool:
    rule = trigger.get("rule")
    if rule == "required_field_missing":
        for field in trigger.get("fields", []):
            if not isinstance(body, Mapping) or field not in body or body[field] in (
                None,
                "",
                [],
            ):
                return True
        return False
    if rule == "missing_or_malformed_auth_header":
        # Already covered by request_validator's `auth_bearer`; corpus
        # entries using this rule are essentially aliases of the validator.
        # Returning False here lets the validator path own the response.
        return False
    return False


def _build_injected(entry: dict, body: Optional[Mapping[str, Any]]) -> InjectedError:
    response = entry.get("response", {})
    status = int(response.get("status", 400))
    body_template = response.get("body", {}) or {}
    headers = dict(response.get("headers") or {})
    rendered_body = _render_template(body_template, body or {})
    return InjectedError(
        error_id=entry.get("id", "unknown"),
        status=status,
        body=rendered_body,
        headers=headers,
    )


def _render_template(template: Any, ctx: Mapping[str, Any]) -> Any:
    """Substitute `{field}` placeholders in string values from request body.

    Conservative: only top-level body fields, only inside string leaves.
    Anything else passes through unchanged. We add `missing_field` from
    request_shape's required-fields rule too — convenient for messages.
    """
    if isinstance(template, str):
        return _format_string(template, ctx)
    if isinstance(template, list):
        return [_render_template(v, ctx) for v in template]
    if isinstance(template, dict):
        return {k: _render_template(v, ctx) for k, v in template.items()}
    return template


def _format_string(s: str, ctx: Mapping[str, Any]) -> str:
    out = s
    for k, v in ctx.items():
        out = out.replace("{" + k + "}", str(v))
    # request_shape's `{missing_field}` placeholder isn't in the body; we
    # don't try to compute it here because the validator path handles
    # required-field misses now. Leave the literal token in if present.
    return out


def _ci_get(headers: Mapping[str, str], key: str) -> Optional[str]:
    target = key.lower()
    for k, v in headers.items():
        if k.lower() == target:
            return v
    return None
