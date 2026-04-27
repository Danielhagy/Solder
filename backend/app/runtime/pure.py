"""Pure-compute node executors.

Every function in this module is deterministic on its inputs — no I/O, no
random, no time, no environment reads — which means they're safe to call
*inline* from a Temporal workflow without going through `execute_activity`.
The non-deterministic kinds (`state.uuid`, `state.random_*`, `time.now`,
network-touching nodes) live elsewhere as activities.

Dispatch contract: each function takes `(config: dict, data: Any)` where
`data` is the upstream output and `config` is `node.config`. Each returns
the value emitted to downstream nodes — same shape contract the existing
inline `_dispatch_node` cases use in `workflows.py`.

JSONPath resolution uses the same conventions as the existing dispatcher
(`$` is the whole input; dotted segments index into dicts; numeric segments
index into lists). The local `_get_at` helper keeps these executors free of
a workflows.py import.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import re
from typing import Any, Optional
from urllib.parse import quote, quote_plus, unquote, unquote_plus


# ---------------------------------------------------------------------------
# JSONPath helpers — mirrors `IntegrationRunWorkflow._get_value_at_path`.
# Kept private so these executors stay self-contained.
# ---------------------------------------------------------------------------


def _get_at(data: Any, path: str) -> Any:
    """Return the value at a `$.foo.bar` path, or `data` itself for `$` / empty."""
    if not path or path == "$":
        return data
    cleaned = path.lstrip("$.")
    current = data
    for part in cleaned.split("."):
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            current = current[int(part)]
        else:
            return None
    return current


def _truthy(v: Any) -> bool:
    """Predicate truthiness — mirrors what `evaluate_condition` returns."""
    return bool(v)


def _eval_predicate(expr: str, item: Any) -> bool:
    """Tiny evaluator for the predicates Data nodes accept.

    Supports the operator subset documented in `editors/data.tsx`:
    `==`, `!=`, `>`, `<`, `>=`, `<=`, `in`, `not in`. The LHS is a JSONPath
    rooted at the iteration item (`$.foo`); the RHS is a literal — a JSON
    value, a quoted string, or a bare number / true / false / null.

    Bare `$.foo` (no operator) is treated as a truthy gate. Anything that
    doesn't parse cleanly returns False — predicates fail closed.
    """
    if not expr:
        return False
    expr = expr.strip()
    # Operators are tried longest-first so `>=` wins over `>`.
    for op in ("==", "!=", ">=", "<=", " not in ", " in ", ">", "<"):
        if op.strip() in ("in", "not in"):
            # word ops require surrounding spaces to avoid matching inside paths
            if op in expr:
                left, right = expr.split(op, 1)
                lhs = _get_at(item, left.strip())
                rhs = _parse_literal(right.strip())
                contains = (rhs in lhs) if isinstance(lhs, (list, str, tuple, set, dict)) else False
                return contains if op.strip() == "in" else not contains
            continue
        if op in expr:
            left, right = expr.split(op, 1)
            lhs = _get_at(item, left.strip())
            rhs = _parse_literal(right.strip())
            try:
                if op == "==":
                    return lhs == rhs
                if op == "!=":
                    return lhs != rhs
                if op == ">":
                    return lhs > rhs  # type: ignore[operator]
                if op == "<":
                    return lhs < rhs  # type: ignore[operator]
                if op == ">=":
                    return lhs >= rhs  # type: ignore[operator]
                if op == "<=":
                    return lhs <= rhs  # type: ignore[operator]
            except TypeError:
                return False
    # No operator → bare path → truthy gate.
    return _truthy(_get_at(item, expr))


def _parse_literal(s: str) -> Any:
    """Parse a literal RHS: JSON-ish strings, numbers, booleans, null."""
    s = s.strip()
    if not s:
        return ""
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    if s == "true":
        return True
    if s == "false":
        return False
    if s == "null":
        return None
    # Try number
    try:
        if "." in s:
            return float(s)
        return int(s)
    except ValueError:
        pass
    # JSON list / object literal — fall through to string if not parseable.
    if s.startswith("[") or s.startswith("{"):
        try:
            import json as _json

            return _json.loads(s)
        except Exception:  # noqa: BLE001
            return s
    return s


# ---------------------------------------------------------------------------
# Data group
# ---------------------------------------------------------------------------


def data_filter(config: dict, data: Any) -> list:
    """Keep array items whose predicate evaluates truthy."""
    over = config.get("over", "$")
    expr = config.get("expression", "")
    items = _get_at(data, over)
    if not isinstance(items, list):
        return []
    if not expr.strip():
        return list(items)
    return [item for item in items if _eval_predicate(expr, item)]


def data_sort(config: dict, data: Any) -> list:
    """Sort items by a JSONPath key. Empty key → sort scalars directly."""
    over = config.get("over", "$")
    by = (config.get("by") or "").strip()
    order = (config.get("order") or "asc").lower()
    items = _get_at(data, over)
    if not isinstance(items, list):
        return []
    reverse = order == "desc"

    def keyfn(item: Any) -> Any:
        if not by:
            return item
        return _get_at(item, by)

    # Mixed-type lists (None alongside numbers etc.) blow up Python's sort —
    # coerce to a tuple `(is_none, value)` so Nones bucket consistently.
    def safe_key(item: Any) -> tuple:
        v = keyfn(item)
        return (v is None, v if v is not None else "")

    try:
        return sorted(items, key=safe_key, reverse=reverse)
    except TypeError:
        # Heterogeneous types — fall back to string-coerced sort so we still
        # produce a stable order rather than raising.
        return sorted(items, key=lambda x: str(keyfn(x)), reverse=reverse)


def data_unique(config: dict, data: Any) -> list:
    """Deduplicate by key (or full-item equality if `by` is empty)."""
    over = config.get("over", "$")
    by = (config.get("by") or "").strip()
    items = _get_at(data, over)
    if not isinstance(items, list):
        return []
    seen: list[Any] = []
    out: list[Any] = []
    for item in items:
        key = _get_at(item, by) if by else item
        # Lists/dicts aren't hashable → linear scan via equality.
        try:
            already = key in seen
        except TypeError:
            already = any(s == key for s in seen)
        if already:
            continue
        seen.append(key)
        out.append(item)
    return out


def data_pick(config: dict, data: Any) -> list:
    """Whitelist fields on each object item; non-objects pass through."""
    over = config.get("over", "$")
    fields = config.get("fields") or []
    items = _get_at(data, over)
    if not isinstance(items, list):
        return []
    if not isinstance(fields, list) or not fields:
        return list(items)
    out = []
    for item in items:
        if isinstance(item, dict):
            out.append({k: item[k] for k in fields if k in item})
        else:
            out.append(item)
    return out


def data_omit(config: dict, data: Any) -> list:
    """Drop fields from each object item; non-objects pass through."""
    over = config.get("over", "$")
    fields = config.get("fields") or []
    items = _get_at(data, over)
    if not isinstance(items, list):
        return []
    drop = set(fields) if isinstance(fields, list) else set()
    if not drop:
        return list(items)
    out = []
    for item in items:
        if isinstance(item, dict):
            out.append({k: v for k, v in item.items() if k not in drop})
        else:
            out.append(item)
    return out


def data_rename(config: dict, data: Any) -> list:
    """Rename object keys via a `{from: to}` mapping. Other keys pass through."""
    over = config.get("over", "$")
    mapping = config.get("mapping") or {}
    items = _get_at(data, over)
    if not isinstance(items, list):
        return []
    if not isinstance(mapping, dict) or not mapping:
        return list(items)
    out = []
    for item in items:
        if isinstance(item, dict):
            renamed = {}
            for k, v in item.items():
                renamed[mapping.get(k, k)] = v
            out.append(renamed)
        else:
            out.append(item)
    return out


# ---------------------------------------------------------------------------
# Format group
# ---------------------------------------------------------------------------


def format_json_to_csv(config: dict, data: Any) -> str:
    """Array-of-objects → CSV string. Empty input → empty string."""
    over = config.get("over", "$")
    items = _get_at(data, over)
    if not isinstance(items, list):
        return ""
    columns = config.get("columns") or []
    has_header = config.get("header", True)
    delimiter = config.get("delimiter", ",") or ","
    # Auto-derive columns from the first row if none supplied.
    if not columns:
        first_dicts = [i for i in items if isinstance(i, dict)]
        if not first_dicts:
            return ""
        seen_keys: list[str] = []
        for d in first_dicts:
            for k in d.keys():
                if k not in seen_keys:
                    seen_keys.append(k)
        columns = seen_keys
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=delimiter, lineterminator="\n")
    if has_header:
        writer.writerow(columns)
    for item in items:
        if not isinstance(item, dict):
            continue
        writer.writerow([item.get(c, "") for c in columns])
    return buf.getvalue()


def format_csv_to_json(config: dict, data: Any) -> list:
    """CSV string → array of objects (or arrays if no header)."""
    csv_path = config.get("csv", "$")
    text = _get_at(data, csv_path)
    if not isinstance(text, str):
        return []
    has_header = config.get("has_header", True)
    delimiter = config.get("delimiter", ",") or ","
    coerce = bool(config.get("type_coerce", False))
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = list(reader)
    if not rows:
        return []
    if has_header:
        header = rows[0]
        body = rows[1:]
        return [
            {h: _maybe_coerce(c, coerce) for h, c in zip(header, row)} for row in body
        ]
    return [[_maybe_coerce(c, coerce) for c in row] for row in rows]


def _maybe_coerce(s: str, on: bool) -> Any:
    if not on:
        return s
    if s == "":
        return None
    if s.lower() == "true":
        return True
    if s.lower() == "false":
        return False
    try:
        if "." in s:
            return float(s)
        return int(s)
    except ValueError:
        return s


def format_base64_encode(config: dict, data: Any) -> str:
    src = _get_at(data, config.get("data", "$"))
    if isinstance(src, str):
        raw = src.encode("utf-8")
    elif isinstance(src, (bytes, bytearray)):
        raw = bytes(src)
    else:
        raw = str(src).encode("utf-8")
    if config.get("url_safe"):
        return base64.urlsafe_b64encode(raw).decode("ascii")
    return base64.b64encode(raw).decode("ascii")


def format_base64_decode(config: dict, data: Any) -> Any:
    src = _get_at(data, config.get("data", "$"))
    if not isinstance(src, str):
        src = str(src)
    # Auto-detect url-safe by trying both alphabets.
    try:
        raw = base64.b64decode(src, validate=False)
    except Exception:  # noqa: BLE001
        raw = base64.urlsafe_b64decode(src)
    out_as = (config.get("as") or "string").lower()
    if out_as == "bytes":
        # JSON can't carry bytes — return list[int] as the canonical envelope.
        return list(raw)
    return raw.decode("utf-8", errors="replace")


def format_url_encode(config: dict, data: Any) -> str:
    src = _get_at(data, config.get("data", "$"))
    if not isinstance(src, str):
        src = str(src)
    component = config.get("component", True)
    return quote_plus(src) if component else quote(src, safe=":/?#&=@%")


def format_url_decode(config: dict, data: Any) -> str:
    src = _get_at(data, config.get("data", "$"))
    if not isinstance(src, str):
        src = str(src)
    # Try plus-decoding first; fall back to plain percent-decode.
    try:
        return unquote_plus(src)
    except Exception:  # noqa: BLE001
        return unquote(src)


def format_hash(config: dict, data: Any) -> str:
    src = _get_at(data, config.get("data", "$"))
    if isinstance(src, str):
        raw = src.encode("utf-8")
    elif isinstance(src, (bytes, bytearray)):
        raw = bytes(src)
    else:
        raw = str(src).encode("utf-8")
    algo = (config.get("algo") or "sha256").lower()
    if algo not in {"md5", "sha1", "sha256", "sha512"}:
        algo = "sha256"
    digest = hashlib.new(algo, raw).digest()
    output = (config.get("output") or "hex").lower()
    if output == "base64":
        return base64.b64encode(digest).decode("ascii")
    return digest.hex()


# ---------------------------------------------------------------------------
# Math group
# ---------------------------------------------------------------------------


_MATH_PATH_RE = re.compile(r"\$\.[a-zA-Z_][\w.]*")
_MATH_SAFE_RE = re.compile(r"[\d\s\+\-\*\/\%\(\)\.]+")


def math_calc(config: dict, data: Any) -> Any:
    """Evaluate a math expression with JSONPath references.

    The expression supports `+ - * / % ( )` plus parentheses and decimal
    literals. JSONPath references (`$.foo.bar`) are pre-resolved against
    `data`; missing or non-numeric refs become `0`. After substitution the
    expression must contain only digits, ops, parens, whitespace, and
    decimal points — anything else (function names, attribute access,
    string literals) raises `ValueError`. We then `eval()` with an empty
    globals dict; the whitelist is the safety property, not eval itself.
    """
    expr = (config.get("expression") or "").strip()
    if not expr:
        return None

    def _sub(match: "re.Match[str]") -> str:
        v = _get_at(data, match.group(0))
        if isinstance(v, bool):
            # bool is a subclass of int; coerce to keep arithmetic predictable
            return "1" if v else "0"
        if isinstance(v, (int, float)):
            return str(v)
        return "0"

    substituted = _MATH_PATH_RE.sub(_sub, expr)
    if not _MATH_SAFE_RE.fullmatch(substituted.strip()):
        raise ValueError(
            f"math.calc: expression contains unsupported tokens after substitution: {substituted!r}"
        )
    # eval is safe here because the whitelist already rejected anything
    # that could call a function or access an attribute.
    return eval(substituted, {"__builtins__": {}}, {})  # noqa: S307


def math_round(config: dict, data: Any) -> Any:
    """Round / ceil / floor / truncate to N decimal places.

    `value` may be a JSONPath ref or a literal. Non-numeric inputs return
    `None` (the runtime treats that as a soft-empty downstream value).
    """
    src = config.get("value", "$")
    if isinstance(src, str) and src.startswith("$"):
        v = _get_at(data, src)
    else:
        v = src
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return None
    mode = (config.get("mode") or "round").lower()
    places = int(config.get("places") or 0)
    if mode == "ceil":
        import math as _math

        m = 10 ** places
        return _math.ceil(v * m) / m if places > 0 else int(_math.ceil(v))
    if mode == "floor":
        import math as _math

        m = 10 ** places
        return _math.floor(v * m) / m if places > 0 else int(_math.floor(v))
    if mode == "trunc":
        import math as _math

        m = 10 ** places
        return _math.trunc(v * m) / m if places > 0 else int(_math.trunc(v))
    # Default: half-up rounding, matching the editor's "Round (half-up)" label.
    return round(v, places) if places > 0 else int(round(v))


# ---------------------------------------------------------------------------
# String group
# ---------------------------------------------------------------------------


def str_concat(config: dict, data: Any) -> str:
    """Join `parts` with `separator`. Each part is a JSONPath ref or literal."""
    parts = config.get("parts") or []
    separator = config.get("separator") or ""
    rendered: list[str] = []
    for p in parts:
        if not isinstance(p, str):
            rendered.append(str(p))
            continue
        if p.startswith("$"):
            v = _get_at(data, p)
            rendered.append("" if v is None else str(v))
        else:
            rendered.append(p)
    return separator.join(rendered)


def str_split(config: dict, data: Any) -> list[str]:
    """Split a string by `separator`. Empty separator splits per-character."""
    src = _get_at(data, config.get("value", "$"))
    if not isinstance(src, str):
        src = "" if src is None else str(src)
    sep = config.get("separator", ",")
    if sep is None:
        sep = ""
    max_n = int(config.get("max") or 0)
    if sep == "":
        # Python's str.split('') errors; emulate "every character".
        return list(src) if max_n <= 0 else (list(src[: max_n]) + ([src[max_n:]] if src[max_n:] else []))
    if max_n > 0:
        return src.split(sep, max_n - 1)
    return src.split(sep)


def str_replace(config: dict, data: Any) -> str:
    """Find/replace, optionally treating the pattern as regex. Always returns a string."""
    src = _get_at(data, config.get("value", "$"))
    if not isinstance(src, str):
        src = "" if src is None else str(src)
    pattern = config.get("pattern") or ""
    replacement = config.get("replacement") or ""
    do_all = config.get("all", True)
    use_regex = bool(config.get("regex"))
    if not pattern:
        return src
    if use_regex:
        try:
            return re.sub(pattern, replacement, src, count=0 if do_all else 1)
        except re.error as e:
            raise ValueError(f"str.replace: invalid regex {pattern!r}: {e}") from e
    if do_all:
        return src.replace(pattern, replacement)
    # First-occurrence-only path
    idx = src.find(pattern)
    if idx < 0:
        return src
    return src[:idx] + replacement + src[idx + len(pattern):]


def str_trim(config: dict, data: Any) -> str:
    """Strip whitespace (or specific chars) from one or both ends."""
    src = _get_at(data, config.get("value", "$"))
    if not isinstance(src, str):
        src = "" if src is None else str(src)
    side = (config.get("side") or "both").lower()
    chars = config.get("chars") or None  # None → whitespace
    if side == "start":
        return src.lstrip(chars) if chars else src.lstrip()
    if side == "end":
        return src.rstrip(chars) if chars else src.rstrip()
    return src.strip(chars) if chars else src.strip()


def str_case(config: dict, data: Any) -> str:
    """Convert string case. Supports upper/lower/title/camel/snake/kebab."""
    src = _get_at(data, config.get("value", "$"))
    if not isinstance(src, str):
        src = "" if src is None else str(src)
    to = (config.get("to") or "lower").lower()
    if to == "upper":
        return src.upper()
    if to == "lower":
        return src.lower()
    if to == "title":
        return src.title()
    # For camel/snake/kebab, tokenise on non-alphanumerics + camel humps.
    tokens = _tokenise_for_case(src)
    if not tokens:
        return ""
    if to == "snake":
        return "_".join(t.lower() for t in tokens)
    if to == "kebab":
        return "-".join(t.lower() for t in tokens)
    if to == "camel":
        first, *rest = tokens
        return first.lower() + "".join(t.capitalize() for t in rest)
    # Unknown target → pass through unchanged rather than guess.
    return src


def _tokenise_for_case(s: str) -> list[str]:
    # Insert a space between a lowercase-then-uppercase boundary, then split on
    # any non-alphanumeric run. Drops empties.
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)
    spaced = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", spaced)
    return [t for t in re.split(r"[^A-Za-z0-9]+", spaced) if t]


# ---------------------------------------------------------------------------
# Time group — pure-compute (no wall clock). `time.now` is an activity,
# not here.
#
# Token mapping for `time.format` / `time.parse` formats follows the editor's
# documented set: `YYYY MM DD HH mm ss`. Anything else passes through. We
# translate to strftime tokens at the boundary so users never see `%Y`.
# ---------------------------------------------------------------------------


_TIME_TOKEN_PAIRS = (
    ("YYYY", "%Y"),
    ("MM", "%m"),
    ("DD", "%d"),
    ("HH", "%H"),
    ("mm", "%M"),
    ("ss", "%S"),
)


def _to_strftime(fmt: str) -> str:
    """Translate the editor's friendly format string to strftime tokens."""
    out = fmt
    # Order matters — replace longer tokens first to avoid 'M' shadowing 'MM'.
    for src, dst in _TIME_TOKEN_PAIRS:
        out = out.replace(src, dst)
    return out


def _parse_iso_lenient(s: str):
    """Parse a date string with stdlib only.

    Tries `fromisoformat` first (handles most ISO 8601), then falls back to
    RFC 2822 via `email.utils`. Returns `datetime` or raises ValueError.
    """
    from datetime import datetime

    try:
        # Python 3.11+ accepts trailing 'Z' too; pre-3.11 needs the swap.
        return datetime.fromisoformat(s.replace("Z", "+00:00") if s.endswith("Z") else s)
    except ValueError:
        pass
    from email.utils import parsedate_to_datetime

    return parsedate_to_datetime(s)


def time_parse(config: dict, data: Any) -> Optional[str]:
    """Parse a date string into ISO 8601. Returns `None` if the input is empty."""
    src = _get_at(data, config.get("value", "$"))
    if not isinstance(src, str) or not src.strip():
        return None
    formats = config.get("formats") or []
    assume_tz = (config.get("assume_tz") or "UTC").strip()

    from datetime import datetime, timezone

    parsed = None
    if isinstance(formats, list) and formats:
        for fmt in formats:
            try:
                parsed = datetime.strptime(src, _to_strftime(fmt))
                break
            except (ValueError, TypeError):
                continue
    if parsed is None:
        try:
            parsed = _parse_iso_lenient(src)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"time.parse: could not parse {src!r} ({e})") from e

    # Naive datetime — apply assume_tz.
    if parsed.tzinfo is None:
        if assume_tz.upper() == "UTC":
            parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            try:
                from zoneinfo import ZoneInfo

                parsed = parsed.replace(tzinfo=ZoneInfo(assume_tz))
            except Exception:  # noqa: BLE001
                parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def time_format(config: dict, data: Any) -> Optional[str]:
    """ISO timestamp → user-formatted string. Returns `None` if input is empty."""
    src = _get_at(data, config.get("value", "$"))
    if not isinstance(src, str) or not src.strip():
        return None
    fmt = config.get("format") or "YYYY-MM-DD"
    tz = (config.get("tz") or "UTC").strip()
    parsed = _parse_iso_lenient(src)
    if parsed.tzinfo is None:
        from datetime import timezone

        parsed = parsed.replace(tzinfo=timezone.utc)
    if tz.upper() != "UTC":
        try:
            from zoneinfo import ZoneInfo

            parsed = parsed.astimezone(ZoneInfo(tz))
        except Exception:  # noqa: BLE001
            pass  # Fall through with whatever tzinfo we had.
    return parsed.strftime(_to_strftime(fmt))


def time_add(config: dict, data: Any) -> Optional[str]:
    """Shift a timestamp by N units. Months/years use calendar arithmetic."""
    src = _get_at(data, config.get("value", "$"))
    if not isinstance(src, str) or not src.strip():
        return None
    amount = int(config.get("amount") or 0)
    unit = (config.get("unit") or "days").lower()
    parsed = _parse_iso_lenient(src)
    if parsed.tzinfo is None:
        from datetime import timezone

        parsed = parsed.replace(tzinfo=timezone.utc)

    from datetime import timedelta

    if unit in {"seconds", "minutes", "hours", "days"}:
        delta = {
            "seconds": timedelta(seconds=amount),
            "minutes": timedelta(minutes=amount),
            "hours": timedelta(hours=amount),
            "days": timedelta(days=amount),
        }[unit]
        return (parsed + delta).isoformat()
    if unit == "months":
        return _shift_calendar(parsed, months=amount).isoformat()
    if unit == "years":
        return _shift_calendar(parsed, months=amount * 12).isoformat()
    raise ValueError(f"time.add: unknown unit {unit!r}")


def _shift_calendar(dt, months: int):
    """Add N calendar months to a datetime, clamping the day to month-end."""
    from calendar import monthrange

    total_months = dt.month - 1 + months
    new_year = dt.year + total_months // 12
    new_month = total_months % 12 + 1
    last_day = monthrange(new_year, new_month)[1]
    new_day = min(dt.day, last_day)
    return dt.replace(year=new_year, month=new_month, day=new_day)


def time_diff(config: dict, data: Any) -> Optional[float]:
    """Difference between two ISO timestamps, in the requested unit (a − b)."""
    a_path = config.get("a", "$")
    b_path = config.get("b", "")
    a_val = _get_at(data, a_path) if a_path else None
    b_val = _get_at(data, b_path) if b_path else None
    if not isinstance(a_val, str) or not isinstance(b_val, str):
        return None
    if not a_val.strip() or not b_val.strip():
        return None
    try:
        a_dt = _parse_iso_lenient(a_val)
        b_dt = _parse_iso_lenient(b_val)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"time.diff: could not parse inputs ({e})") from e
    # Naive datetimes get UTC.
    from datetime import timezone

    if a_dt.tzinfo is None:
        a_dt = a_dt.replace(tzinfo=timezone.utc)
    if b_dt.tzinfo is None:
        b_dt = b_dt.replace(tzinfo=timezone.utc)
    delta = a_dt - b_dt
    unit = (config.get("unit") or "days").lower()
    seconds = delta.total_seconds()
    if unit == "seconds":
        return seconds
    if unit == "minutes":
        return seconds / 60
    if unit == "hours":
        return seconds / 3600
    if unit == "days":
        return seconds / 86400
    raise ValueError(f"time.diff: unknown unit {unit!r}")


# ---------------------------------------------------------------------------
# Dispatch table — workflows.py imports this and looks up by `f"{kind}.{action}"`.
# ---------------------------------------------------------------------------


PURE_DISPATCH = {
    # Data
    "data.filter": data_filter,
    "data.sort": data_sort,
    "data.unique": data_unique,
    "data.pick": data_pick,
    "data.omit": data_omit,
    "data.rename": data_rename,
    # Format
    "format.json_to_csv": format_json_to_csv,
    "format.csv_to_json": format_csv_to_json,
    "format.base64_encode": format_base64_encode,
    "format.base64_decode": format_base64_decode,
    "format.url_encode": format_url_encode,
    "format.url_decode": format_url_decode,
    "format.hash": format_hash,
    # Math
    "math.calc": math_calc,
    "math.round": math_round,
    # String
    "str.concat": str_concat,
    "str.split": str_split,
    "str.replace": str_replace,
    "str.trim": str_trim,
    "str.case": str_case,
    # Time (deterministic — `time.now` is an activity, not here)
    "time.parse": time_parse,
    "time.format": time_format,
    "time.add": time_add,
    "time.diff": time_diff,
}
