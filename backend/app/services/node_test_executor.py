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

import re
import time as _time
from typing import Any, Optional

from app.runtime.pure import PURE_DISPATCH
from app.temporal import activities


class NodeNotTestable(Exception):
    """Raised when the test feature can't run this node in isolation."""


# ── Template resolution ────────────────────────────────────────────────
# Mirrors the workflow's `_interpolate` / `_interpolate_dict` /
# `_get_value_at_path` trio so configs that reference the input data
# (`{{$.user_id}}`, `{{$.body.email}}`) work in the test runner without
# the user having to bake concrete values into the editor first.

_TEMPLATE_RE = re.compile(r"\{\{([^}]+)\}\}")


def _value_at_path(data: Any, path: str) -> Any:
    """Dot-separated traversal: `$`, `$.foo`, `$.items.0.name`."""
    if not path or path == "$":
        return data
    path = path.lstrip("$.")
    current: Any = data
    for part in path.split("."):
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            idx = int(part)
            current = current[idx] if 0 <= idx < len(current) else None
        else:
            return None
    return current


def _interpolate_str(template: str, data: Any) -> str:
    def replace(m: "re.Match[str]") -> str:
        expr = m.group(1).strip()
        v = _value_at_path(data, expr)
        return "" if v is None else str(v)

    return _TEMPLATE_RE.sub(replace, template)


def _interpolate(value: Any, data: Any) -> Any:
    """Recursively interpolate `{{$.path}}` refs in nested dict/list/str.

    Bare strings whose entire content is a single `{{…}}` token resolve
    to the *typed* value at that path (so `{{$.id}}` yields the int, not
    `"42"`); strings with mixed content (`prefix-{{$.id}}`) coerce to
    string. Matches the workflow's behaviour.
    """
    if isinstance(value, str):
        m = _TEMPLATE_RE.fullmatch(value.strip())
        if m:
            return _value_at_path(data, m.group(1).strip())
        return _interpolate_str(value, data)
    if isinstance(value, dict):
        return {k: _interpolate(v, data) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v, data) for v in value]
    return value


async def execute_node(
    node: dict,
    input_data: Any,
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
        output = await _run(dispatch_key, cfg, input_data, extras)
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
    dispatch_key: str, cfg: dict, data: Any, extras: dict[str, Any]
) -> Any:
    # Pure ops: stdlib-only, deterministic, fast.
    if dispatch_key in PURE_DISPATCH:
        return PURE_DISPATCH[dispatch_key](cfg, data)

    if dispatch_key == "http.request":
        return await _http_request(cfg, data)

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
            tz=str(cfg.get("tz") or "UTC"),
            output=str(cfg.get("output") or "iso"),
        )

    if dispatch_key == "code.python":
        # Subprocess sandbox — same path the workflow uses. The activity
        # does its own `{{$.path}}` substitution against `data`, so the
        # user can write references inline in the Python source and
        # they get spliced in as `repr()`-encoded literals before
        # compile. Stdout from `print()` calls is written into `extras`
        # so the caller's envelope can surface it for the editor's
        # output panel.
        env = await activities.execute_python_sandbox(
            source=str(cfg.get("source") or ""),
            data=data,
            timeout_ms=int(cfg.get("timeout_ms") or 30000),
            allow_imports=list(cfg.get("allow_imports") or []),
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


async def _http_request(cfg: dict, data: Any) -> Any:
    """Wrap `execute_api_call` for one-shot tests. Pagination disabled in
    the test runner — testing a single request is the point.

    `data` isn't used to template the URL/body in v1 (the workflow does
    that via `_resolve_template`); for the test runner, the user is
    expected to fill in concrete values in the editor before clicking
    Test. A future pass can wire template resolution here too.
    """
    method = str(cfg.get("method") or "GET").upper()
    url = str(cfg.get("url") or "")
    if not url:
        raise Exception("http.request: missing 'url'")
    headers = cfg.get("headers") or {}
    body = cfg.get("body")
    auth = cfg.get("auth")
    timeout = int(cfg.get("timeout") or 30)

    out = await activities.execute_api_call(
        activities.APICallInput(
            method=method,
            url=url,
            headers=headers if isinstance(headers, dict) else {},
            body=body if isinstance(body, dict) else None,
            auth=auth if isinstance(auth, dict) else None,
            timeout=timeout,
            pagination=None,
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
    }


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
