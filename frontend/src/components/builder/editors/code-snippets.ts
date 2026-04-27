/**
 * Starter snippets for `code.python`. Shown as cards when the editor
 * source is empty — picking one prefills the editor with a working
 * example using `data` and `result`. Patterns chosen from common
 * integration tasks: shape transforms, filtering, formatting,
 * aggregation. Each snippet must run cleanly against any plain-shape
 * `data` so users can hit Test immediately and see something work.
 */

export interface PythonSnippet {
  /** Stable id, used as the card key + data-testid suffix. */
  id: string;
  /** Card title in the picker. Verbs preferred. */
  title: string;
  /** One-line caption rendered under the title. */
  description: string;
  /** Full Python source — must include `result =` and assume `data`
   *  is the upstream value. Tab-stops not supported in v1; users
   *  edit the literal source after insertion. */
  source: string;
}

export const PYTHON_SNIPPETS: PythonSnippet[] = [
  {
    id: 'passthrough',
    title: 'Passthrough',
    description: 'Emit the upstream output unchanged. Starting point for tweaks.',
    source: `# Pass the upstream output through untouched.
result = data
`,
  },
  {
    id: 'pick-fields',
    title: 'Pick fields',
    description: 'Keep just a few keys from a dict. Drops everything else.',
    source: `# Keep only the fields you care about; everything else is dropped.
keep = ["id", "name", "email"]
result = {k: data[k] for k in keep if k in data}
`,
  },
  {
    id: 'rename-fields',
    title: 'Rename fields',
    description: 'Map old keys to new ones (e.g. snake_case → camelCase).',
    source: `# Rename keys; unmapped keys pass through unchanged.
mapping = {
    "user_id": "userId",
    "first_name": "firstName",
    "created_at": "createdAt",
}
result = {mapping.get(k, k): v for k, v in data.items()}
`,
  },
  {
    id: 'filter-list',
    title: 'Filter a list',
    description: 'Keep items matching a predicate — e.g. status=="active".',
    source: `# Filter a list of dicts by a field's value.
items = data.get("items", []) if isinstance(data, dict) else data
result = [it for it in items if it.get("status") == "active"]
`,
  },
  {
    id: 'aggregate-sum',
    title: 'Sum + count',
    description: 'Compute a total and count over a list. Common for billing.',
    source: `# Aggregate a list of {amount, …} dicts.
items = data.get("items", []) if isinstance(data, dict) else data
total = sum(float(it.get("amount", 0)) for it in items)
result = {
    "count": len(items),
    "total": round(total, 2),
}
`,
  },
  {
    id: 'group-by',
    title: 'Group by key',
    description: 'Bucket a list of dicts by one field. Each bucket is a list.',
    source: `# Group a list by a field — returns {key: [items]}.
from collections import defaultdict

items = data.get("items", []) if isinstance(data, dict) else data
groups = defaultdict(list)
for it in items:
    key = it.get("category", "unknown")
    groups[key].append(it)

result = dict(groups)
`,
  },
  {
    id: 'format-date',
    title: 'Format dates',
    description: 'Parse ISO timestamps and reformat them. Handles tz.',
    source: `# Parse an ISO datetime, reformat as a friendly string.
from datetime import datetime

raw = data.get("created_at") if isinstance(data, dict) else str(data)
if raw:
    dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    result = {
        "iso": dt.isoformat(),
        "human": dt.strftime("%b %d, %Y at %I:%M %p"),
        "epoch": int(dt.timestamp()),
    }
else:
    result = None
`,
  },
  {
    id: 'flatten',
    title: 'Flatten nested object',
    description: 'Collapse {"a": {"b": 1}} to {"a.b": 1}. Useful for CSV.',
    source: `# Flatten an arbitrarily-nested dict to a single level.
def flatten(obj, prefix=""):
    flat = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            flat.update(flatten(v, key))
        else:
            flat[key] = v
    return flat

result = flatten(data) if isinstance(data, dict) else {"value": data}
`,
  },
];
