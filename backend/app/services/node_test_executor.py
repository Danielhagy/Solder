"""
Synchronous one-shot per-node executor.

Powers the right-rail "Test" button. Reuses the same Temporal activity
functions and `runtime/pure.py` dispatch table the workflow uses, but
calls them as plain async coroutines — no workflow execution, no
durability, no replay. Trades durability for latency: a test is a
single HTTP request that finishes in tens of milliseconds for pure ops,
or however long the upstream API takes for `http.request`.

Supported kinds (v1 of the test feature):
  - http.request         — calls `execute_api_call` directly
  - transform.map        — calls `execute_transform`
  - All `runtime/pure.py` PURE_DISPATCH entries (data.*, format.*,
                           math.*, str.*, time.parse/format/add/diff)
  - state.{ulid,uuid,random_int,random_float,now}  — calls each activity
  - logic.assert / logic.gate — pure predicate evaluation

Out of scope for v1 (return a clear "not testable in isolation" error):
  - logic.branch / logic.switch / logic.loop — container semantics depend
    on the surrounding graph (which branch wins, what's `over`, …).
  - process.call — needs the target subprocess loaded; not single-node.
  - code.python — runs in a subprocess sandbox; supported but slower.
  - ai.*  — needs a real Claude API call; gate behind future work.
"""

from __future__ import annotations

import time as _time
from typing import Any, Optional

from app.runtime.interpolate import (
    interpolate_value as _interpolate_canonical,
    render_request_body,
    TemplateBodyError,
)
from app.runtime.http_config import (
    auth_mode_of as _http_auth_mode_of,
    extract_path_for_resolver as _http_extract_path,
    flatten_kv_rows as _http_flatten_kv_rows,
    legacy_auth_from_v2 as _http_legacy_auth_from_v2,
    normalize_http_body as _http_normalize_body,
)
from app.runtime.path import get_at
from app.runtime.pure import PURE_DISPATCH
from app.temporal import activities


class NodeNotTestable(Exception):
    """Raised when the test feature can't run this node in isolation."""


# In test mode the run's `input_data` IS the trigger payload — passing
# it through as both `data` and `trigger_input` makes `$.trigger.<rest>`
# refs resolve against the same dict picker tokens point at, without
# the test runner tracking a separate trigger scope.


def _value_at_path(data: Any, path: str) -> Any:
    """Test-runner path resolution. ``$.trigger.<rest>`` aliases
    ``$.<rest>`` because both root at ``data`` here.
    """
    return get_at(data, path, trigger_input=data)


def _interpolate(value: Any, data: Any) -> Any:
    """Recursively interpolate `{{$.path}}` refs. See
    `app.runtime.interpolate.interpolate_value` for semantics.
    """
    return _interpolate_canonical(value, data, trigger_input=data)


async def execute_node(
    node: dict,
    input_data: Any,
    integration_id: Optional[str] = None,
) -> dict:
    """Run one node sync. Returns a step-record-shaped envelope:

        {
          "ok": bool,
          "kind": "<kind>.<action>",
          "duration_ms": int,
          "output": <any>      (on success)
          "error": str         (on failure)
          "error_kind": str    (on http failure, when classifier fired)
        }
    """
    started = _time.perf_counter()
    kind = (node.get("kind") or "").strip()
    action = (node.get("action") or "").strip()
    dispatch_key = f"{kind}.{action}"
    raw_cfg = node.get("config", {}) or {}

    # Resolve `{{$.path}}` refs in the config against `input_data`. Same
    # contract as the workflow's `_interpolate_dict`. `code.python.source`
    # is held back — the activity does its own source-level substitution
    # with `repr()`-encoded literals, and pre-interpolating would coerce
    # the tokens to plain strings.
    if isinstance(raw_cfg, dict):
        held_source = raw_cfg.get("source") if kind == "code" else None
        cfg = _interpolate(
            {k: v for k, v in raw_cfg.items() if not (kind == "code" and k == "source")},
            input_data,
        )
        if held_source is not None:
            cfg["source"] = held_source
    else:
        cfg = raw_cfg

    # Side-channel for kinds that produce extra envelope fields (stdout
    # from code.python's print() capture, etc.). _run writes here; we
    # merge into the success envelope. Kept separate from the return
    # value so the dispatch contract stays "value-or-raise".
    extras: dict[str, Any] = {}

    try:
        output = await _run(dispatch_key, cfg, input_data, extras, integration_id)
        return {
            "ok": True,
            "kind": dispatch_key,
            "duration_ms": int((_time.perf_counter() - started) * 1000),
            "output": output,
            **extras,
        }
    except NodeNotTestable as e:
        return {
            "ok": False,
            "kind": dispatch_key,
            "duration_ms": int((_time.perf_counter() - started) * 1000),
            "error": str(e),
            "error_kind": "not_testable",
        }
    except Exception as e:  # noqa: BLE001 — surface anything to the caller
        # Empty-message exceptions still need a usable string in the
        # response so the test-overlay's red-pip + alert have content
        # to render. The type-name fallback lets the user see at a
        # glance which exception class fired even when the message is
        # blank.
        out: dict[str, Any] = {
            "ok": False,
            "kind": dispatch_key,
            "duration_ms": int((_time.perf_counter() - started) * 1000),
            "error": str(e) or f"{type(e).__name__}: (no message)",
        }
        kind_attr = getattr(e, "error_kind", None)
        if isinstance(kind_attr, str):
            out["error_kind"] = kind_attr
        # If the failed branch (e.g. code.python) carried stdout up to
        # the crash, surface it so the user can see the print()s that
        # ran before the exception fired.
        stdout_attr = getattr(e, "stdout", None)
        if isinstance(stdout_attr, str) and stdout_attr:
            out["stdout"] = stdout_attr
        elif extras.get("stdout"):
            out["stdout"] = extras["stdout"]
        return out


# ── Dispatch ───────────────────────────────────────────────────────────


async def _run(
    dispatch_key: str,
    cfg: dict,
    data: Any,
    extras: dict[str, Any],
    integration_id: Optional[str] = None,
) -> Any:
    # Pure ops: stdlib-only, deterministic, fast.
    if dispatch_key in PURE_DISPATCH:
        return PURE_DISPATCH[dispatch_key](cfg, data)

    if dispatch_key == "http.request":
        return await _http_request(cfg, data, integration_id)

    if dispatch_key == "transform.map":
        out = await activities.execute_transform(
            activities.TransformInput(data=data, expression=str(cfg.get("expression", "$")))
        )
        if not out.success:
            raise Exception(out.error or "transform failed")
        return out.result

    # State + time non-deterministic ops — direct calls into the activity layer.
    if dispatch_key == "state.uuid":
        return await activities.gen_uuid_v4()
    if dispatch_key == "state.ulid":
        return await activities.gen_ulid(prefix=str(cfg.get("prefix") or ""))
    if dispatch_key == "state.random_int":
        return await activities.random_int_in_range(
            min_v=int(cfg.get("min", 0)),
            max_v=int(cfg.get("max", 100)),
            seed=str(cfg.get("seed") or ""),
        )
    if dispatch_key == "state.random_float":
        return await activities.random_float_in_range(
            min_v=float(cfg.get("min", 0.0)),
            max_v=float(cfg.get("max", 1.0)),
            seed=str(cfg.get("seed") or ""),
        )
    if dispatch_key == "time.now":
        return await activities.get_current_time(
            fmt=str(cfg.get("format") or "iso"),
            tz=str(cfg.get("tz") or "UTC"),
        )

    if dispatch_key == "code.python":
        # Subprocess sandbox — same path the workflow uses. The activity
        # does its own `{{$.path}}` substitution against `data`, so the
        # user can write references inline in the Python source and
        # they get spliced in as `repr()`-encoded literals before
        # compile. Stdout from `print()` calls is written into `extras`
        # so the caller's envelope can surface it for the editor's
        # output panel.
        # In test mode the run's `input_data` IS the trigger payload by
        # construction (the user picks a past run or pastes a sample), so
        # forward it as `trigger_input` too — `{{$.trigger.<path>}}` refs
        # resolve the same way as in a real run.
        env = await activities.execute_python_sandbox(
            source=str(cfg.get("source") or ""),
            data=data,
            timeout_ms=int(cfg.get("timeout_ms") or 30000),
            allow_imports=list(cfg.get("allow_imports") or []),
            trigger_input=data,
        )
        stdout = env.get("stdout") if isinstance(env, dict) else None
        has_stdout = isinstance(stdout, str) and bool(stdout)
        if has_stdout:
            extras["stdout"] = stdout
        if env.get("error"):
            err = Exception(str(env.get("error")))
            err_kind = env.get("error_kind")
            if isinstance(err_kind, str):
                setattr(err, "error_kind", err_kind)
            # Surface stdout on failure too — print() lines up to the
            # crash are exactly what the user wants to see.
            if has_stdout:
                setattr(err, "stdout", stdout)
            raise err
        return env.get("result")

    # Logic predicates that ARE testable in isolation (no graph context).
    if dispatch_key in ("logic.assert", "logic.gate"):
        passed = await activities.evaluate_condition(
            str(cfg.get("expression", "true")), data
        )
        if dispatch_key == "logic.assert":
            if not passed:
                raise Exception(str(cfg.get("message") or "assertion failed"))
            return data  # passthrough
        # gate
        if passed:
            return data
        on_false = str(cfg.get("on_false") or "skip")
        return {"gated": True, "on_false": on_false}

    # Containers + subprocess — out of scope for one-shot test.
    if dispatch_key in (
        "logic.branch",
        "logic.switch",
        "logic.loop",
        "logic.if",
        "process.call",
    ):
        raise NodeNotTestable(
            f"{dispatch_key} is a container — testing requires graph context. "
            "Test the leaf nodes inside it instead."
        )

    raise NodeNotTestable(
        f"{dispatch_key!r} isn't supported by the per-node test runner yet. "
        "Run the integration end-to-end to exercise it."
    )


async def _http_request(
    cfg: dict, data: Any, integration_id: Optional[str] = None
) -> Any:
    """Wrap ``execute_api_call`` for one-shot tests. Pagination disabled in
    the test runner — testing a single request is the point.

    Mirrors ``workflows._execute_api_call`` for the v2 config shape:
    flattens KvRow[] headers + params, normalises HttpBody, honours
    ``auth.mode`` override, and resolves the bound Connection (when
    ``integration_id`` is supplied) so test calls route through the same
    sandbox / production path real runs do. With no ``integration_id`` the
    Connection step is skipped — useful for ad-hoc public-API smoke tests.
    """
    method = str(cfg.get("method") or "GET").upper()
    url_raw = _interpolate(str(cfg.get("url") or ""), data)
    if not url_raw:
        raise Exception("http.request: missing 'url'")

    # --- Structured query params -> merge into URL ---
    params_dict = _http_flatten_kv_rows(cfg.get("params"))
    if params_dict:
        params_dict = {k: _interpolate(v, data) for k, v in params_dict.items()}
        url_raw = _merge_query(url_raw, params_dict)

    # --- Body — v2 HttpBody discriminator or legacy shape ---
    try:
        body = render_request_body(
            _http_normalize_body(cfg.get("body")), data, trigger_input=data
        )
    except TemplateBodyError as e:
        err = Exception(f"http.request: {e}")
        setattr(err, "error_kind", "permanent")
        raise err

    # --- Headers — KvRow[] or legacy dict ---
    user_headers = _http_flatten_kv_rows(cfg.get("headers"))
    user_headers = {k: _interpolate(v, data) for k, v in user_headers.items()}

    # --- Auth + Connection resolution ---
    raw_auth = cfg.get("auth")
    auth_override = _http_legacy_auth_from_v2(raw_auth)
    auth_mode = _http_auth_mode_of(raw_auth)
    connection_id = (
        cfg.get("connectionId")
        or cfg.get("credential_id")
        or cfg.get("connection_id")
        or None
    )

    resolved_url = url_raw
    resolved_headers: dict[str, str] = {}
    resolved_query: dict[str, str] = {}
    if connection_id and integration_id:
        resolved = await activities.resolve_connector_request(
            activities.ConnectorResolveInput(
                integration_id=integration_id,
                connector_name="",
                endpoint_path=_http_extract_path(url_raw),
                connection_id=connection_id,
            )
        )
        if not resolved.success:
            err = Exception(
                f"http.request: connection {connection_id}: {resolved.error}"
            )
            setattr(err, "error_kind", "permanent")
            raise err
        if not url_raw.startswith(("http://", "https://")):
            resolved_url = resolved.url
        resolved_headers = dict(resolved.headers or {})
        resolved_query = dict(resolved.query or {})

    final_url = (
        _merge_query(resolved_url, resolved_query) if resolved_query else resolved_url
    )

    if auth_mode == "none":
        resolved_headers.pop("Authorization", None)
        resolved_headers.pop("authorization", None)
    final_headers = {**resolved_headers, **user_headers}
    final_auth = auth_override if auth_mode not in (None, "inherit") else None

    # --- Settings ---
    settings = cfg.get("settings") if isinstance(cfg.get("settings"), dict) else {}
    timeout_s = int(settings.get("timeoutSeconds", cfg.get("timeout", 30)) or 30)
    follow_redirects = bool(settings.get("followRedirects", True))
    verify = bool(settings.get("rejectUnauthorized", True))

    # Reconstruct exactly what the activity will put on the wire so the
    # Response drawer's cURL sub-tab can render the real request, not the
    # response headers echoed back at us. Mask known-sensitive header
    # values; preview only — the user's clipboard never sees the raw token.
    wire_headers = activities._apply_auth(final_headers, final_auth)
    masked_request_headers = _mask_sensitive_headers(wire_headers)

    out = await activities.execute_api_call(
        activities.APICallInput(
            method=method,
            url=final_url,
            headers=final_headers,
            body=body if isinstance(body, (dict, list)) else None,
            auth=final_auth,
            timeout=timeout_s,
            pagination=None,
            follow_redirects=follow_redirects,
            verify=verify,
        )
    )
    if not out.success:
        err = Exception(out.error or f"HTTP {out.status_code}")
        if out.error_kind:
            setattr(err, "error_kind", out.error_kind)
        raise err
    return {
        "status_code": out.status_code,
        "headers": out.headers,
        "body": out.body,
        "request_url": final_url,
        "request_headers": masked_request_headers,
    }


# Bearer / Basic / API-key values get the middle replaced with `•••` so the
# user can confirm an Authorization header is being sent without exposing the
# raw secret in the cURL preview (still copyable, just masked).
_SENSITIVE_HEADER_KEYS = {"authorization", "proxy-authorization", "x-api-key"}


def _mask_sensitive_headers(
    headers: dict[str, str],
) -> list[tuple[str, str]]:
    """Return header pairs with secret values masked. Preserves order in
    insertion form so the cURL preview reads top-to-bottom the way the
    user typed them."""
    masked: list[tuple[str, str]] = []
    for k, v in headers.items():
        if k.lower() in _SENSITIVE_HEADER_KEYS and v:
            if " " in v:
                scheme, _, _ = v.partition(" ")
                masked.append((k, f"{scheme} •••"))
            else:
                masked.append((k, "•••"))
        else:
            masked.append((k, v))
    return masked


def _merge_query(url: str, extra: dict[str, str]) -> str:
    """Merge query params into a URL. Existing keys win on collision (the
    user-typed URL is the source of truth)."""
    if not extra:
        return url
    sep = "&" if "?" in url else "?"
    from urllib.parse import urlencode

    return f"{url}{sep}{urlencode(extra, doseq=True)}"


# ── Input derivation from a previous run ────────────────────────────────


def derive_node_input(run_steps: list, target_node_id: str, run_input: Any) -> Optional[Any]:
    """Reconstruct the input that would have been handed to `target_node_id`
    during a past run, from that run's persisted step records.

    Heuristic (matches the workflow's stage execution):
      - If the target step is at stage 0, input is the run's `input_data`.
      - Otherwise, input is the output of the latest successful step in the
        immediately-preceding stage. (Workflow's `_run_stages` threads the
        previous stage's output into the next stage; for parallel stages
        we take the last one's output, which is what the workflow does.)
      - If the previous stage produced no usable output (all skipped or
        failed), fall back to the run's input_data.

    Returns None when the target node didn't run in this past run (e.g.
    a conditional skipped its whole stage).
    """
    if not isinstance(run_steps, list):
        return None
    target = next(
        (s for s in run_steps if isinstance(s, dict) and s.get("node_id") == target_node_id),
        None,
    )
    if target is None:
        return None
    target_stage = target.get("stage")
    if not isinstance(target_stage, int) or target_stage <= 0:
        return run_input
    prev_outputs = [
        s.get("output")
        for s in run_steps
        if isinstance(s, dict)
        and s.get("stage") == target_stage - 1
        and s.get("status") == "success"
        and "output" in s
    ]
    if prev_outputs:
        return prev_outputs[-1]
    return run_input
