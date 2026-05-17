import json
import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from temporalio import activity

from app.runtime.interpolate import splice_path_refs_repr
from app.runtime.path import get_at as _runtime_get_at


@dataclass
class PaginationConfig:
    """Configuration for paginated API calls.

    mode: "none" | "page" | "cursor" | "link-header"
    items_path: JSONPath-ish expression pointing at the array of items in each response body.
    max_pages: hard upper bound on iterations (safety net).
    stop_on_empty: stop immediately when a page returns zero items.

    Mode-specific:
    - page: query-param pagination. page_param is the query key, page_start the
      first integer value, page_size_param/page_size optionally request a page size.
    - cursor: response body carries a next-page token at cursor_path; sent back as
      cursor_param on the next request. Stops when the cursor is missing/null.
    - link-header: follows RFC 5988 Link header with rel="next" verbatim.
    """

    mode: str = "none"
    # page mode
    page_param: str = "page"
    page_start: int = 1
    page_size_param: str = ""
    page_size: int = 0
    # cursor mode
    cursor_path: str = "$.next_cursor"
    cursor_param: str = "cursor"
    # shared
    items_path: str = "$"
    max_pages: int = 100
    stop_on_empty: bool = True


@dataclass
class APICallInput:
    """Input for API call activity.

    ``follow_redirects`` / ``verify`` were added with the HTTP node v2 editor
    so users can flip redirect-following and TLS verification per-request.
    Defaults preserve historical behaviour (follow on, verify on)."""

    method: str
    url: str
    headers: dict[str, str] = None
    body: Optional[dict] = None
    auth: Optional[dict] = None
    timeout: int = 30
    pagination: Optional[PaginationConfig] = None
    follow_redirects: bool = True
    verify: bool = True


@dataclass
class APICallOutput:
    """Output from API call activity.

    ``error_kind`` (RESILIENCE_PLAN.md §2.1) categorises every failure into
    one of four buckets so downstream consumers — Loop iteration tracking,
    the run drawer, future retry logic — can branch without re-parsing the
    error string. ``None`` on success.
    """

    status_code: int
    headers: dict[str, str]
    body: Any
    success: bool
    error: Optional[str] = None
    error_kind: Optional[str] = None  # 'transient' | 'permanent' | 'auth' | None


def _classify_http_error(
    status_code: int, exc: Optional[BaseException] = None
) -> Optional[str]:
    """Bucket an HTTP failure into transient / permanent / auth.

    Inputs are alternative — pass ``status_code`` for response-based errors,
    or ``exc`` for transport-level errors with no status. Returns ``None``
    when the call actually succeeded so the field stays falsy on success.

    Buckets:
      auth       — 401, 403 (credential problem; halt the run)
      transient  — 5xx, 429, 408, network timeouts, connection resets
      permanent  — 4xx semantic failures (validation, missing reference)
    """
    if exc is not None:
        # Network / timeout / connection-level errors are nearly always
        # worth a retry; the caller can decide whether to actually retry.
        if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
            return "transient"
        # Fall back to permanent for anything we don't recognise — surfaces
        # in the UI and prevents a runaway retry on a genuinely broken call.
        return "permanent"
    if status_code in (401, 403):
        return "auth"
    if status_code in (408, 429) or 500 <= status_code < 600:
        return "transient"
    if 400 <= status_code < 500:
        return "permanent"
    return None


@dataclass
class TransformInput:
    """Input for transform activity."""

    data: Any
    expression: str


@dataclass
class TransformOutput:
    """Output from transform activity."""

    result: Any
    success: bool
    error: Optional[str] = None


@activity.defn
async def execute_api_call(input: APICallInput) -> APICallOutput:
    """Execute an HTTP API call."""
    activity.logger.info(f"Executing API call: {input.method} {input.url}")

    try:
        async with httpx.AsyncClient(
            timeout=input.timeout,
            follow_redirects=input.follow_redirects,
            verify=input.verify,
        ) as client:
            # Auth handling lives in `_apply_auth` so this activity and
            # `execute_paginated_api_call` apply identical bearer/basic/api_key
            # rules — one place to update when a new scheme lands.
            headers = _apply_auth(input.headers or {}, input.auth)

            # Make the request
            response = await client.request(
                method=input.method,
                url=input.url,
                headers=headers,
                json=input.body if input.body else None,
            )

            # Parse response body
            try:
                body = response.json()
            except:
                body = response.text

            return APICallOutput(
                status_code=response.status_code,
                headers=dict(response.headers),
                body=body,
                success=response.is_success,
                error_kind=_classify_http_error(response.status_code)
                if not response.is_success
                else None,
            )

    except Exception as e:
        activity.logger.error(f"API call failed: {str(e)}")
        return APICallOutput(
            status_code=0,
            headers={},
            body=None,
            success=False,
            error=str(e),
            error_kind=_classify_http_error(0, exc=e),
        )


def _merge_query(url: str, extra: dict[str, str]) -> str:
    """Return ``url`` with ``extra`` query params merged in (existing keys overwritten)."""
    if not extra:
        return url
    parsed = urlparse(url)
    existing = dict(parse_qsl(parsed.query, keep_blank_values=True))
    existing.update({k: str(v) for k, v in extra.items()})
    return urlunparse(parsed._replace(query=urlencode(existing, doseq=True)))


def _parse_link_next(header: str) -> Optional[str]:
    """Extract the ``rel="next"`` URL from an RFC 5988 ``Link`` header, if present."""
    if not header:
        return None
    # Each entry looks like: <https://.../page=2>; rel="next"
    for part in header.split(","):
        match = re.match(r"\s*<([^>]+)>\s*;(.*)$", part)
        if not match:
            continue
        target, params = match.group(1), match.group(2)
        if re.search(r'rel\s*=\s*"?\s*next\s*"?', params, re.IGNORECASE):
            return target
    return None


def _path_get(obj: Any, path: str) -> Any:
    """Walk a JSONPath-ish expression like ``$.foo.bar``. ``$`` = whole object.

    Thin shim over `app.runtime.path.get_at` — retained because callers
    inside this module pass the result through their own None-handling.
    """
    if obj is None:
        return None
    return _runtime_get_at(obj, path)


def _apply_auth(headers: dict[str, str], auth: Optional[dict]) -> dict[str, str]:
    """Apply the same auth rules used by ``execute_api_call`` to a header dict."""
    out = dict(headers or {})
    if not auth:
        return out
    auth_type = auth.get("type", "")
    if auth_type == "bearer":
        out["Authorization"] = f"Bearer {auth.get('token', '')}"
    elif auth_type == "basic":
        import base64

        credentials = f"{auth.get('username', '')}:{auth.get('password', '')}"
        encoded = base64.b64encode(credentials.encode()).decode()
        out["Authorization"] = f"Basic {encoded}"
    elif auth_type == "api_key":
        key_name = auth.get("name", "X-API-Key")
        if auth.get("in", "header") == "header":
            out[key_name] = auth.get("value", "")
    return out


@activity.defn
async def execute_paginated_api_call(input: APICallInput) -> APICallOutput:
    """Execute an HTTP API call that follows pagination until exhausted.

    Concatenates every page's items (extracted via ``pagination.items_path``) into a
    single array and returns ``body = {"items": [...], "pages": N, "total_items": M}``.

    Supports three modes: ``page`` (query-param), ``cursor`` (body token), and
    ``link-header`` (RFC 5988 ``rel="next"``). ``max_pages`` caps iterations.
    """
    p = input.pagination
    if p is None or p.mode == "none":
        raise ValueError("execute_paginated_api_call requires pagination.mode != 'none'")

    activity.logger.info(
        f"Executing paginated API call [{p.mode}]: {input.method} {input.url}"
    )

    all_items: list[Any] = []
    url = input.url
    headers = _apply_auth(input.headers or {}, input.auth)
    query_override: dict[str, str] = {}
    pages = 0
    next_cursor: Any = None
    page_num = p.page_start
    last_status = 0

    try:
        async with httpx.AsyncClient(
            timeout=input.timeout,
            follow_redirects=input.follow_redirects,
            verify=input.verify,
        ) as client:
            while pages < p.max_pages:
                if p.mode == "page":
                    query_override = {p.page_param: str(page_num)}
                    if p.page_size_param and p.page_size:
                        query_override[p.page_size_param] = str(p.page_size)
                elif p.mode == "cursor":
                    # First iteration has no cursor — send none. Subsequent iterations
                    # send the extracted token under ``cursor_param``.
                    query_override = (
                        {p.cursor_param: str(next_cursor)}
                        if next_cursor is not None
                        else {}
                    )
                else:
                    # link-header: URL for page 2+ is the full next URL from the
                    # previous response; no extra params needed.
                    query_override = {}

                req_url = _merge_query(url, query_override) if query_override else url

                response = await client.request(
                    method=input.method,
                    url=req_url,
                    headers=headers,
                    json=(
                        input.body
                        if input.method in ("POST", "PUT", "PATCH") and input.body
                        else None
                    ),
                )
                last_status = response.status_code
                response.raise_for_status()

                try:
                    body = response.json()
                except Exception:
                    body = None

                items = _path_get(body, p.items_path)
                if items is None:
                    items = []
                if not isinstance(items, list):
                    items = [items]

                all_items.extend(items)
                pages += 1

                if p.stop_on_empty and len(items) == 0:
                    break

                # Compute next-page continuation signal per mode.
                if p.mode == "page":
                    # If the caller told us the page size and this page came back
                    # short, we're done.
                    if p.page_size and len(items) < p.page_size:
                        break
                    page_num += 1
                elif p.mode == "cursor":
                    next_cursor = _path_get(body, p.cursor_path)
                    if not next_cursor:
                        break
                elif p.mode == "link-header":
                    link = response.headers.get("link") or response.headers.get("Link") or ""
                    next_url = _parse_link_next(link)
                    if not next_url:
                        break
                    url = next_url
                else:
                    break

        return APICallOutput(
            status_code=last_status or 200,
            headers={},
            body={"items": all_items, "pages": pages, "total_items": len(all_items)},
            success=True,
        )

    except Exception as e:
        activity.logger.error(f"Paginated API call failed: {str(e)}")
        return APICallOutput(
            status_code=last_status,
            headers={},
            body={"items": all_items, "pages": pages, "total_items": len(all_items)},
            success=False,
            error=str(e),
            # Classify by status when we have one (last response was a non-2xx),
            # otherwise fall back to the exception-shape classifier.
            error_kind=_classify_http_error(last_status) if last_status else _classify_http_error(0, exc=e),
        )


@activity.defn
async def execute_transform(input: TransformInput) -> TransformOutput:
    """Execute a data transformation."""
    activity.logger.info(f"Executing transform: {input.expression}")

    try:
        # Simple JSONPath-like expression evaluation
        expression = input.expression.strip()

        if expression.startswith("$."):
            # JSONPath-style access
            result = input.data
            parts = expression[2:].split(".")
            for part in parts:
                if "[" in part:
                    # Handle array access like items[0]
                    key = part.split("[")[0]
                    index = int(part.split("[")[1].rstrip("]"))
                    result = result[key][index]
                else:
                    result = result[part]

            return TransformOutput(result=result, success=True)

        elif expression.startswith("{"):
            # JSON template with placeholders
            import re

            def replace_placeholder(match):
                path = match.group(1)
                value = input.data
                for part in path.split("."):
                    value = value[part]
                return json.dumps(value) if isinstance(value, (dict, list)) else str(value)

            result_str = re.sub(r"\{\{([^}]+)\}\}", replace_placeholder, expression)
            return TransformOutput(result=json.loads(result_str), success=True)

        else:
            # Pass through
            return TransformOutput(result=input.data, success=True)

    except Exception as e:
        activity.logger.error(f"Transform failed: {str(e)}")
        return TransformOutput(result=None, success=False, error=str(e))


@activity.defn
async def evaluate_condition(expression: str, data: Any) -> bool:
    """Evaluate a condition expression."""
    activity.logger.info(f"Evaluating condition: {expression}")

    try:
        # Simple expression evaluation
        # Supports: ==, !=, >, <, >=, <=, in, not in

        # Replace data references with actual values
        import re

        def get_value(path: str) -> Any:
            value = data
            for part in path.strip().split("."):
                if part.startswith("$"):
                    part = part[1:]
                if part:
                    value = value[part]
            return value

        def parse_literal(s: str) -> Any:
            """Parse an RHS literal: numbers, booleans, null, JSON, or bare string.

            Pre-fix this only handled quoted strings / arrays / objects, so
            `$.amount > 0` evaluated as `42 > "0"` and TypeErrored. JSON
            covers the numeric/boolean/null/double-quoted cases naturally;
            single-quoted strings (`'approved'` — common in JSONPath-ish
            DSLs) get a manual unwrap before falling back to bare string.
            """
            stripped = s.strip()
            # JSONPath-ish predicates often write strings with single quotes
            # (`$.status == 'approved'`). JSON proper requires double quotes
            # so json.loads would reject — handle this before the JSON pass
            # so we don't end up comparing `'approved'` to `approved`.
            if (
                len(stripped) >= 2
                and stripped[0] == "'"
                and stripped[-1] == "'"
            ):
                return stripped[1:-1]
            try:
                return json.loads(stripped)
            except (json.JSONDecodeError, ValueError):
                return s

        # Parse simple comparisons
        for op in ["==", "!=", ">=", "<=", ">", "<", " in ", " not in "]:
            if op in expression:
                parts = expression.split(op)
                if len(parts) == 2:
                    left = parts[0].strip()
                    right = parts[1].strip()

                    # Get left value
                    if left.startswith("$."):
                        left_val = get_value(left[1:])
                    else:
                        left_val = parse_literal(left)

                    # Get right value
                    if right.startswith("$."):
                        right_val = get_value(right[1:])
                    else:
                        right_val = parse_literal(right)

                    # Evaluate
                    if op == "==":
                        return left_val == right_val
                    elif op == "!=":
                        return left_val != right_val
                    elif op == ">":
                        return left_val > right_val
                    elif op == "<":
                        return left_val < right_val
                    elif op == ">=":
                        return left_val >= right_val
                    elif op == "<=":
                        return left_val <= right_val
                    elif op == " in ":
                        return left_val in right_val
                    elif op == " not in ":
                        return left_val not in right_val

        return bool(expression)

    except Exception as e:
        activity.logger.error(f"Condition evaluation failed: {str(e)}")
        return False


@activity.defn
async def record_learning(
    run_id: str,
    integration_id: str,
    pattern_type: str,
    context: dict,
    insight: str,
    success: bool,
) -> None:
    """Record a learning from workflow execution."""
    activity.logger.info(f"Recording learning: {pattern_type} - {insight}")
    # In a real implementation, this would save to the database
    # For now, just log it
    pass


@activity.defn
async def notify_completion(
    run_id: str,
    success: bool,
    result: Any,
    error: Optional[str] = None,
    steps: Optional[list] = None,
) -> None:
    """Finalize a Run row with terminal status, output, and error message.

    Writes the terminal state to the DB so the HTTP polling surface (and the
    Builder's Run toast) can reflect success / failure. Falls back to simple
    logging if the DB write fails.
    """
    from datetime import datetime
    from app.models.integration import Run, RunStatus
    from sqlalchemy import select

    activity.logger.info(f"Run {run_id} completed: success={success}")

    try:
        from app.database import async_session
        async with async_session() as session:
            res = await session.execute(select(Run).where(Run.id == run_id))
            run = res.scalar_one_or_none()
            if run is None:
                activity.logger.warning(f"notify_completion: run {run_id} not found")
                return
            run.status = RunStatus.SUCCESS if success else RunStatus.FAILED
            run.completed_at = datetime.utcnow()
            run.output_data = result if success else None
            run.error_message = error if not success else None
            if steps is not None:
                run.steps = steps
            await session.commit()
    except Exception as exc:
        activity.logger.exception("notify_completion failed to persist run %s: %s", run_id, exc)


@activity.defn
async def load_subprocess_config(subprocess_id: str) -> dict:
    """Fetch a reusable subprocess's integration config by id.

    Used by `process.call` nodes at runtime so the workflow can inline the
    subprocess's nodes. Returns the config dict or raises if not found /
    not a library subprocess.
    """
    from app.database import async_session
    from app.models.integration import Integration
    from sqlalchemy import select

    async with async_session() as session:
        result = await session.execute(
            select(Integration).where(Integration.id == subprocess_id)
        )
        integration = result.scalar_one_or_none()
        if integration is None:
            raise ValueError(f"Subprocess {subprocess_id} not found")
        if not integration.is_library:
            raise ValueError(
                f"Integration {subprocess_id} is not marked as a library subprocess"
            )
        return integration.config or {}


# ---------------------------------------------------------------------------
# Non-deterministic node activities (Wave B-3)
#
# Anything that depends on the wall clock, randomness, or freshly-generated
# identifiers must run as a Temporal activity, not inline in the workflow,
# so the result is recorded in workflow history and replays deterministically.
# These are the minimum-viable implementations; bigger ones live in pure.py
# alongside the rest of the catalog when their inputs are deterministic.
# ---------------------------------------------------------------------------


@activity.defn
async def gen_uuid_v4() -> str:
    """Fresh UUID v4 string. Used by the `state.uuid` node."""
    import uuid as _uuid

    return str(_uuid.uuid4())


@activity.defn
async def gen_ulid(prefix: str = "") -> str:
    """Generate a ULID, optionally prefixed.

    Crockford-base32 encoded; 48 bits of millisecond timestamp + 80 bits of
    cryptographic randomness. No external dep. Format: `<prefix>_<ulid>` if
    prefix is non-empty, otherwise the bare 26-char ULID.
    """
    import secrets
    import time as _time

    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    ms = int(_time.time() * 1000) & ((1 << 48) - 1)
    rand_bytes = secrets.token_bytes(10)  # 80 bits
    n = (ms << 80) | int.from_bytes(rand_bytes, "big")
    out = ""
    for _ in range(26):
        out = alphabet[n & 0x1F] + out
        n >>= 5
    return f"{prefix.strip()}_{out}" if prefix and prefix.strip() else out


@activity.defn
async def random_int_in_range(min_v: int, max_v: int, seed: str = "") -> int:
    """Random integer in `[min_v, max_v]` inclusive. Optional `seed` for determinism."""
    import random

    rng = random.Random(seed) if seed else random.Random()
    if max_v < min_v:
        min_v, max_v = max_v, min_v
    return rng.randint(int(min_v), int(max_v))


@activity.defn
async def random_float_in_range(min_v: float, max_v: float, seed: str = "") -> float:
    """Random float in `[min_v, max_v)`. Optional `seed` for determinism."""
    import random

    rng = random.Random(seed) if seed else random.Random()
    if max_v < min_v:
        min_v, max_v = max_v, min_v
    return rng.uniform(float(min_v), float(max_v))


@activity.defn
async def get_current_time(fmt: str = "iso", tz: str = "UTC") -> Any:
    """Wall-clock now, in one of three formats.

    `fmt` ∈ {`iso`, `unix`, `unix_ms`}; `tz` is an IANA name applied to the
    `iso` form. Falls back to UTC if the zone is unknown.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    fmt = (fmt or "iso").lower()
    if fmt == "unix":
        return int(now.timestamp())
    if fmt == "unix_ms":
        return int(now.timestamp() * 1000)
    # iso
    if tz and tz.upper() != "UTC":
        try:
            from zoneinfo import ZoneInfo

            return now.astimezone(ZoneInfo(tz)).isoformat()
        except Exception:  # noqa: BLE001
            # Unknown zone — fall through to UTC.
            pass
    return now.isoformat()


# ---------------------------------------------------------------------------
# Python sandbox (Wave B-7)
#
# Runs user-supplied scripts in a `python -I` subprocess with a JSON-piped
# bootstrap. The bootstrap filters `__import__` to a stdlib-safe set plus
# the user's optional `allow_imports`, strips dangerous builtins (open,
# exec, eval, compile, ...), and captures stdout. Returns a structured
# envelope so the workflow dispatcher can map errors to the
# `code.python` errorModes declared on the frontend catalog entry.
#
# This is a *dev-grade* sandbox: it stops accidental misuse, not a
# determined attacker. v2 multi-user wants OS-level isolation (firejail /
# Docker / gVisor); the seam is this activity — swap the subprocess
# invocation, keep the JSON contract.
# ---------------------------------------------------------------------------


_PYTHON_SANDBOX_BOOTSTRAP = r'''
import sys, json, builtins, io

# Save references the bootstrap itself needs *before* we strip builtins.
# After the strip, `exec`/`compile` etc. are unavailable in user code AND
# in any subsequent bootstrap line — so we capture what we need locally.
_real_exec = exec
_real_compile = compile
# `traceback` is needed by the error-formatting branches below; once
# the SAFE import filter installs, `import traceback` would fail. Bind
# the module here so the except-blocks can format full source-line
# traces for the editor's gutter.
import traceback as _real_traceback

payload = json.loads(sys.stdin.read())
src = payload.get("source") or ""
data = payload.get("data")
allow = set(payload.get("allow_imports") or [])

# Always-allowed stdlib safe set. These are pure-compute / data modules with
# no I/O, network, or process control. Adding to this list belongs in the
# repo, not in user config.
SAFE = {
    # Headline data / compute modules users will import explicitly.
    "json", "re", "math", "random", "datetime", "time",
    "collections", "itertools", "functools", "string",
    "base64", "hashlib", "hmac", "urllib.parse",
    "decimal", "statistics", "csv", "io", "textwrap",
    "calendar", "operator", "copy", "types",
    # Pure-compute stdlib internals that show up as transitive deps.
    # Adding these here lets `Counter.most_common` (uses heapq) and
    # similar idioms work without forcing the user to know about them.
    "heapq", "bisect", "numbers", "abc", "enum",
    "_collections_abc", "_weakrefset",
}
allow_set = SAFE | allow

# Pre-warm allowed modules with the *real* importer so their transitive
# private dependencies (e.g. `textwrap` → `re` → `_sre`, anything → `_io`)
# land in `sys.modules` before the filter is installed. After this, user
# `import X` for X in allow_set just hits the import cache and never
# re-enters the guard recursively.
_real_import = builtins.__import__
for _mod in list(allow_set):
    try:
        _real_import(_mod)
    except Exception:
        pass

# Public stdlib C-extensions that SAFE pure-compute modules depend on
# internally (base64 → binascii, hashlib → struct, urllib.parse →
# unicodedata, etc). They're kept wired into their parent module's
# namespace so `base64.b64encode` works, but the import filter below
# still blocks user-level `import binascii` since they're not in SAFE.
# Add here only modules that are pure-compute (no I/O / network).
_KEEP_HELPERS = {"binascii", "struct", "unicodedata"}

# Scrub module-typed attributes that point at blocked modules. Stdlib
# modules sometimes alias their internal `os` / `sys` deps as `_os` /
# `_sys` for their own use — stripping those external aliases prevents
# `random._os.system(...)` style escapes without breaking the module's
# own internal use of its imports (which goes through fresh lookups,
# not reflective attribute access).
#
# What we keep:
#  - modules in allow_set (the user-facing safe API)
#  - private C-extensions whose root starts with `_` (e.g. `_sre`,
#    `_hashlib`, `_csv`, `_blake2`) — the import guard blocks user-level
#    `import _sre` so these are unreachable via the user's API; we just
#    have to keep them wired internally so `re.match` etc still work.
#  - explicit public helpers in _KEEP_HELPERS.
#
# What we strip:
#  - public-named modules aliased privately into stdlib namespaces (the
#    `random._os` escape vector). `os` is public, not in allow_set, not
#    private → stripped.
import types as _types
def _scrub_blocked_refs(mod, allow, keep):
    for _name in list(vars(mod)):
        if _name.startswith("__") and _name.endswith("__"):
            continue
        try:
            _v = getattr(mod, _name, None)
        except Exception:
            continue
        if isinstance(_v, _types.ModuleType):
            _root = (_v.__name__ or "").split(".")[0]
            if not _root:
                continue
            if _root in allow or _root in keep or _root.startswith("_"):
                continue
            try:
                delattr(mod, _name)
            except Exception:
                pass
for _mod_name in list(sys.modules):
    _m = sys.modules.get(_mod_name)
    if _m is None:
        continue
    _root = _mod_name.split(".")[0]
    if _root in allow_set:
        _scrub_blocked_refs(_m, allow_set, _KEEP_HELPERS)

def guarded_import(name, *args, **kwargs):
    root = name.split(".")[0]
    if root not in allow_set and name not in allow_set:
        raise ImportError(f"import of {name!r} is not allowed in this sandbox")
    return _real_import(name, *args, **kwargs)
builtins.__import__ = guarded_import

# Strip dangerous builtins. After this, user code can't open files, eval
# arbitrary strings, compile new code, or exit out of the sandbox. The
# bootstrap holds private references above so it can still run user code.
for unsafe in ("open", "exec", "eval", "compile", "input", "breakpoint",
               "exit", "quit", "help"):
    if hasattr(builtins, unsafe):
        try:
            delattr(builtins, unsafe)
        except Exception:
            pass

# Redirect stdout to a buffer so the user's print() output is captured but
# doesn't pollute the JSON envelope we emit on the real stdout below.
_buf = io.StringIO()
sys.stdout = _buf

# Pre-bind the most useful stdlib modules into the user's namespace so
# everyday scripts don't need import boilerplate. This is a quality-of-
# life convenience, not a security boundary — the import filter above
# is what enforces what's allowed; this just spares the user from
# typing `import json` to use `json.dumps`. Anything not in this list
# is still reachable via `import X` (subject to the SAFE filter).
_AUTO_BIND = (
    "json", "math", "re", "datetime", "random",
    "collections", "itertools", "functools",
    "string", "base64", "hashlib",
    "decimal", "statistics", "textwrap", "csv",
    "operator", "copy",
)
ns = {"data": data, "result": None}
for _name in _AUTO_BIND:
    try:
        ns[_name] = _real_import(_name)
    except Exception:
        pass

err = None
err_kind = None
output = None
try:
    # `compile` first so a SyntaxError is reported with the right error_kind
    # (otherwise exec catches everything as RuntimeError-ish).
    _code = _real_compile(src, "<sandbox>", "exec")
    _real_exec(_code, ns)
    output = ns.get("result")
except SyntaxError as e:
    # SyntaxErrors carry their own line/offset metadata; preserve them
    # via the standard formatter so the editor can pin a `File
    # "<sandbox>", line N` marker at the right gutter.
    err = "".join(_real_traceback.format_exception_only(type(e), e)).rstrip()
    err_kind = "syntax"
except ImportError as e:
    err = str(e)
    err_kind = "import_blocked"
except Exception as e:
    # Capture the full traceback so error panels can extract `File
    # "<sandbox>", line N` and pin a CodeMirror gutter marker.
    # `format_exc()` includes the chain, the offending source frame,
    # and the typed exception name — strictly more useful than
    # `f"{type(e).__name__}: {e}"`.
    err = _real_traceback.format_exc().rstrip()
    err_kind = "runtime"

sys.stdout = sys.__stdout__

# JSON-serialise. `default=str` protects against datetime / Decimal / etc.
# slipping through; if the user's `result` truly isn't JSONable we get a
# string fallback rather than a crash.
print(json.dumps({
    "result": output,
    "stdout": _buf.getvalue(),
    "error": err,
    "error_kind": err_kind,
}, default=str))
'''


def _splice_path_refs(
    source: str,
    data: Any,
    trigger_input: Any = None,
) -> str:
    """Replace `{{$.path}}` tokens with the `repr()` of the resolved
    value. Thin shim over `app.runtime.interpolate.splice_path_refs_repr`.
    """
    return splice_path_refs_repr(source, data, trigger_input=trigger_input)


@activity.defn
async def execute_python_sandbox(
    source: str,
    data: Any,
    timeout_ms: int = 30000,
    allow_imports: Optional[list[str]] = None,
    trigger_input: Any = None,
) -> dict:
    """Run user-supplied Python in a subprocess sandbox.

    `source` may contain `{{$.path}}` tokens that resolve against `data`
    and are spliced in as Python literals (`repr()`-encoded) before the
    bootstrap compiles the script. So the editor can write inline:

        result = {"id_doubled": {{$.id}} * 2, "name": {{$.profile.name}}}

    and the bootstrap exec's:

        result = {"id_doubled": 21 * 2, "name": 'Alice'}

    No Variables UI, no namespace tricks — just template-substitution
    at the source-string level.

    Returns a structured envelope so the workflow dispatcher can re-raise
    with the appropriate `code.python` error_kind.

    Errors that escape this activity (subprocess spawn failure, JSON parse
    failure on the child's output) are turned into `runtime` envelopes too
    — every code-path produces a usable shape.
    """
    # Splice path refs BEFORE handing off to the subprocess — keeps the
    # bootstrap simple (no template engine in the sandboxed child) and
    # lets us reuse `data` reads in this same parent process. The
    # trigger_input arg lets `{{$.trigger.<path>}}` refs resolve against
    # the run's input payload regardless of how `data` has evolved
    # downstream.
    source = _splice_path_refs(source or "", data, trigger_input=trigger_input)
    import asyncio
    import sys as _sys

    proc = await asyncio.create_subprocess_exec(
        _sys.executable,
        "-I",
        "-c",
        _PYTHON_SANDBOX_BOOTSTRAP,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    payload = json.dumps(
        {
            "source": source or "",
            "data": data,
            "allow_imports": list(allow_imports or []),
        },
        default=str,
    ).encode("utf-8")

    seconds = max(0.1, float(timeout_ms or 30000) / 1000.0)
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(payload),
            timeout=seconds,
        )
    except asyncio.TimeoutError:
        proc.kill()
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass
        return {
            "result": None,
            "stdout": "",
            "error": f"script exceeded timeout of {timeout_ms}ms",
            "error_kind": "timeout",
        }

    if proc.returncode != 0:
        return {
            "result": None,
            "stdout": "",
            "error": (stderr or b"").decode("utf-8", errors="replace")
            or "subprocess exited non-zero",
            "error_kind": "runtime",
        }

    try:
        return json.loads(stdout.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {
            "result": None,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "error": f"sandbox output unparseable: {e}",
            "error_kind": "runtime",
        }


# ---------------------------------------------------------------------------
# Connector ops — resolve the (connection, endpoint) pair into a concrete
# HTTP request shape (URL + headers + query). The workflow's connector
# dispatch path delegates here so secret decryption + auth-scheme application
# stay out of the workflow sandbox.
#
# Sandbox runs route to the local mock-engine and don't decrypt secrets —
# the mock-engine doesn't validate credentials, only that *some* token is
# present. Production runs read the connection's encrypted secret, apply
# the auth scheme, and return the real headers/query.
# ---------------------------------------------------------------------------


@dataclass
class ConnectorResolveInput:
    """Inputs needed to materialise a connector op into a real HTTP request."""

    integration_id: str
    connector_name: str  # 'zip' | 'hubspot' — taken from node.kind
    endpoint_path: str  # '/v1/vendors'
    connection_id: Optional[str] = None  # required for production runs


@dataclass
class ConnectorResolveOutput:
    """Resolved HTTP shape, plus the environment so the workflow can log it."""

    success: bool
    url: str
    headers: dict[str, str]
    query: dict[str, str]
    environment: str  # 'sandbox' | 'production'
    error: Optional[str] = None


@activity.defn
async def resolve_connector_request(
    input: ConnectorResolveInput,
) -> ConnectorResolveOutput:
    """Resolve a connector op into a concrete HTTP request shape.

    Looks at the parent integration's `environment`:
      - 'sandbox': route through the mock-engine. Sandboxes v1 prefers
        the per-connection route `/api/mock/c/{connection_id}/{path}`
        when the node has a connection bound; falls back to the legacy
        `/api/mock/{integration_id}/{connector}/{path}` until cleanup.
        Either way secrets aren't decrypted — the mock-engine just
        checks that *some* bearer is present.
      - 'production': read the chosen connection, decrypt the secret, apply
        the auth scheme, and return the real headers/query.

    Failures (missing connection, unknown connector, decrypt error) are
    encoded into the output rather than raised so the workflow can attach
    them to the failed step record without an activity retry storm.
    """
    from app.config import settings
    from app.connectors import REGISTRY
    from app.connectors import auth_schemes
    from app.database import async_session
    from app.models import Connection, Integration
    from app.services.connection_crypto import decrypt
    from sqlalchemy import select

    path = input.endpoint_path or "/"
    if not path.startswith("/"):
        path = "/" + path

    async with async_session() as session:
        integration = await session.get(Integration, input.integration_id)
        if integration is None:
            return ConnectorResolveOutput(
                success=False,
                url="",
                headers={},
                query={},
                environment="sandbox",
                error=f"integration {input.integration_id} not found",
            )
        env = integration.environment or "sandbox"

        if env == "sandbox":
            # The mock-engine is mounted on the same backend host. We resolve
            # the base URL from the running config to keep dev (5173/8000) and
            # any future deploys (different ports) honest.
            api_base = (
                getattr(settings, "api_base_url", None)
                or "http://localhost:8000"
            ).rstrip("/")
            if input.connection_id:
                url = f"{api_base}/api/mock/c/{input.connection_id}{path}"
            else:
                url = (
                    f"{api_base}/api/mock/{input.integration_id}/"
                    f"{input.connector_name}{path}"
                )
            # Mock-engine just checks "some" bearer is present.
            return ConnectorResolveOutput(
                success=True,
                url=url,
                headers={"Authorization": "Bearer sandbox"},
                query={},
                environment="sandbox",
            )

        # Production path — connection + secrets are required.
        if not input.connection_id:
            return ConnectorResolveOutput(
                success=False,
                url="",
                headers={},
                query={},
                environment="production",
                error="no connection selected for production run",
            )

        result = await session.execute(
            select(Connection).where(Connection.id == input.connection_id)
        )
        conn = result.scalar_one_or_none()
        if conn is None:
            return ConnectorResolveOutput(
                success=False,
                url="",
                headers={},
                query={},
                environment="production",
                error=f"connection {input.connection_id} not found",
            )

        registered = REGISTRY.get(input.connector_name)
        base_url = conn.base_url or (registered.base_url if registered else None)
        if not base_url:
            return ConnectorResolveOutput(
                success=False,
                url="",
                headers={},
                query={},
                environment="production",
                error=f"no base_url for connector {input.connector_name!r}",
            )

        try:
            secrets = decrypt(conn.ciphertext, conn.nonce)
        except Exception as e:  # noqa: BLE001
            return ConnectorResolveOutput(
                success=False,
                url="",
                headers={},
                query={},
                environment="production",
                error=f"decrypt failed: {e}",
            )

        try:
            applied = auth_schemes.apply(
                conn.auth_scheme,
                secrets=secrets,
                config=conn.config_json or {},
            )
        except Exception as e:  # noqa: BLE001
            return ConnectorResolveOutput(
                success=False,
                url="",
                headers={},
                query={},
                environment="production",
                error=f"auth scheme {conn.auth_scheme!r}: {e}",
            )

        url = base_url.rstrip("/") + path
        return ConnectorResolveOutput(
            success=True,
            url=url,
            headers=applied.headers,
            query=applied.query,
            environment="production",
        )


# ---------------------------------------------------------------------------
# data.ingest_to_bank — persist a list of records into the integration's
# test bank so the mock-engine can serve them on subsequent sandbox runs.
#
# Typical pipeline shape: a connector op (live HubSpot pull) → optional
# transform → ingest_to_bank. The resulting bank rows then back the
# mock-engine when the same integration is flipped to environment='sandbox'.
#
# Idempotent: rows are upserted by `(test_bank_id, entity_type, entity_id)`
# (the unique index on `test_bank_entities`). Re-running an ingestion with
# the same data updates the existing row's `data` payload in place.
# ---------------------------------------------------------------------------


@dataclass
class IngestToBankInput:
    """Inputs for the data.ingest_to_bank activity."""

    integration_id: str
    # Required — the row's `entity_type` discriminator. Must match the
    # mock spec's entity_type so list endpoints can round-trip the data.
    entity_type: str
    # The item array. The activity walks each item, extracts the id via
    # `id_path`, and upserts. Non-list inputs are wrapped in a single-item
    # list so a node-level transform doesn't need to wrap explicitly.
    items: Any
    # JSONPath-ish into each item to pull the entity id (default '$.id').
    # When the path resolves to a non-string, str() is applied.
    id_path: str = "$.id"
    # Connector name the bank is keyed against. Falls back to the
    # integration's first non-default test_bank if absent.
    connector_name: Optional[str] = None
    # Truncate existing rows of this entity_type before inserting. Useful
    # for refresh-style pulls; default false (additive upsert).
    replace: bool = False


@dataclass
class IngestToBankOutput:
    """Result of an ingestion. Returned to the workflow as the node output."""

    success: bool
    inserted: int
    updated: int
    test_bank_id: Optional[str] = None
    error: Optional[str] = None


@activity.defn
async def ingest_to_bank(input: IngestToBankInput) -> IngestToBankOutput:
    """Upsert ``input.items`` into the integration's test bank.

    Bank resolution order:
      1. ``(integration_id, api_name=connector_name)`` if connector_name set.
      2. The first ``test_bank`` row for the integration, otherwise.
      3. Auto-create a bank with ``api_name = connector_name or 'custom'``.
    """
    from app.database import async_session
    from app.models import TestBank, TestBankEntity
    from sqlalchemy import delete as sa_delete, select

    # Normalise items to a list. Single-record callers (`data.transform`
    # outputs a dict) shouldn't have to wrap.
    if isinstance(input.items, list):
        items_list = input.items
    elif input.items is None:
        items_list = []
    else:
        items_list = [input.items]

    if not input.entity_type:
        return IngestToBankOutput(
            success=False, inserted=0, updated=0, error="entity_type is required"
        )

    async with async_session() as session:
        # 1) Resolve / create the bank row.
        bank: Optional[TestBank] = None
        if input.connector_name:
            res = await session.execute(
                select(TestBank).where(
                    TestBank.integration_id == input.integration_id,
                    TestBank.api_name == input.connector_name,
                )
            )
            bank = res.scalar_one_or_none()
        if bank is None:
            res = await session.execute(
                select(TestBank).where(
                    TestBank.integration_id == input.integration_id
                )
            )
            bank = res.scalars().first()
        if bank is None:
            bank = TestBank(
                integration_id=input.integration_id,
                api_name=input.connector_name or "custom",
            )
            session.add(bank)
            await session.flush()  # need bank.id for the entity rows

        # 2) Optional truncate.
        if input.replace:
            await session.execute(
                sa_delete(TestBankEntity).where(
                    TestBankEntity.test_bank_id == bank.id,
                    TestBankEntity.entity_type == input.entity_type,
                )
            )

        # 3) Upsert each item by (test_bank_id, entity_type, entity_id).
        inserted = 0
        updated = 0
        for raw in items_list:
            data = raw if isinstance(raw, dict) else {"value": raw}
            entity_id = _path_get(data, input.id_path)
            if entity_id is None:
                # Skip records with no id — they'd collide on the unique
                # index and aren't routable from the mock-engine anyway.
                continue
            entity_id_str = str(entity_id)
            res = await session.execute(
                select(TestBankEntity).where(
                    TestBankEntity.test_bank_id == bank.id,
                    TestBankEntity.entity_type == input.entity_type,
                    TestBankEntity.entity_id == entity_id_str,
                )
            )
            existing = res.scalar_one_or_none()
            if existing is None:
                session.add(
                    TestBankEntity(
                        test_bank_id=bank.id,
                        entity_type=input.entity_type,
                        entity_id=entity_id_str,
                        data=data,
                    )
                )
                inserted += 1
            else:
                existing.data = data
                updated += 1

        await session.commit()

        return IngestToBankOutput(
            success=True,
            inserted=inserted,
            updated=updated,
            test_bank_id=bank.id,
        )
