import json
import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from temporalio import activity


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
    """Input for API call activity."""

    method: str
    url: str
    headers: dict[str, str] = None
    body: Optional[dict] = None
    auth: Optional[dict] = None
    timeout: int = 30
    pagination: Optional[PaginationConfig] = None


@dataclass
class APICallOutput:
    """Output from API call activity."""

    status_code: int
    headers: dict[str, str]
    body: Any
    success: bool
    error: Optional[str] = None


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
        async with httpx.AsyncClient(timeout=input.timeout) as client:
            # Prepare headers
            headers = input.headers or {}

            # Handle authentication
            if input.auth:
                auth_type = input.auth.get("type", "")
                if auth_type == "bearer":
                    headers["Authorization"] = f"Bearer {input.auth.get('token', '')}"
                elif auth_type == "basic":
                    import base64
                    credentials = f"{input.auth.get('username', '')}:{input.auth.get('password', '')}"
                    encoded = base64.b64encode(credentials.encode()).decode()
                    headers["Authorization"] = f"Basic {encoded}"
                elif auth_type == "api_key":
                    key_name = input.auth.get("name", "X-API-Key")
                    key_location = input.auth.get("in", "header")
                    if key_location == "header":
                        headers[key_name] = input.auth.get("value", "")

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
            )

    except Exception as e:
        activity.logger.error(f"API call failed: {str(e)}")
        return APICallOutput(
            status_code=0,
            headers={},
            body=None,
            success=False,
            error=str(e),
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
    """Walk a JSONPath-ish expression like ``$.foo.bar``. ``$`` = whole object."""
    if obj is None:
        return None
    if not path or path == "$":
        return obj
    trimmed = path.lstrip("$").lstrip(".")
    if not trimmed:
        return obj
    current: Any = obj
    for part in trimmed.split("."):
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            idx = int(part)
            current = current[idx] if 0 <= idx < len(current) else None
        else:
            return None
    return current


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
        async with httpx.AsyncClient(timeout=input.timeout) as client:
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
                        left_val = json.loads(left) if left.startswith(("[", "{", '"')) else left

                    # Get right value
                    if right.startswith("$."):
                        right_val = get_value(right[1:])
                    else:
                        right_val = json.loads(right) if right.startswith(("[", "{", '"')) else right

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
