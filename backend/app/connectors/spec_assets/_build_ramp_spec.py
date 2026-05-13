"""
One-shot preprocessor: slim Ramp's full Developer API OpenAPI spec to the
procurement-only surface we expose in Solder, and add the sandbox server
entry. Run manually after pulling a fresh upstream spec:

    cd backend && python -m app.connectors.spec_assets._build_ramp_spec

Reads:  ramp-procurement-raw.json  (the upstream spec, fetched verbatim)
Writes: ramp-procurement.json      (procurement subset, demo server added)

We keep this as code rather than a hand-edited JSON so a future re-pull
of the upstream spec produces a deterministic, reviewable diff. The set
of allowed path prefixes below is the canonical list — change it here,
not in the bundled output.
"""

from __future__ import annotations

import json
from pathlib import Path

# Path prefixes that count as "procurement". An operation is included if
# its path starts with any of these. Keeping it as a prefix list (rather
# than an explicit endpoint enumeration) lets the wizard surface every
# procurement operation Ramp publishes — the user filters further with
# the checklist UI.
ALLOWED_PREFIXES = (
    "/developer/v1/bills",
    "/developer/v1/purchase-orders",
    "/developer/v1/item-receipts",
    "/developer/v1/vendors",
    "/developer/v1/accounting/fields",
    "/developer/v1/accounting/field-options",
    "/developer/v1/accounting/accounts",
    "/developer/v1/accounting/vendors",
    "/developer/v1/entities",
    "/developer/v1/bank-accounts",
)

HERE = Path(__file__).parent
SRC = HERE / "ramp-procurement-raw.json"
DST = HERE / "ramp-procurement.json"


def main() -> None:
    spec = json.loads(SRC.read_text(encoding="utf-8"))
    paths = spec.get("paths", {}) or {}
    kept = {p: ops for p, ops in paths.items() if p.startswith(ALLOWED_PREFIXES)}
    spec["paths"] = kept

    # Inject the sandbox server so users can pick demo-api at connection
    # time. Upstream only lists production; the demo URL is documented
    # separately in Ramp's getting-started guide.
    servers = spec.get("servers") or []
    has_demo = any(s.get("url") == "https://demo-api.ramp.com" for s in servers)
    if not has_demo:
        servers.append({"description": "Demo (sandbox)", "url": "https://demo-api.ramp.com"})
    spec["servers"] = servers

    # Trim title/description so the bundled file makes its scope obvious
    # to anyone who opens it in isolation.
    info = spec.get("info") or {}
    info["title"] = "Ramp Developer API — Procurement subset (Solder)"
    spec["info"] = info

    DST.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"wrote {DST.name}: {len(kept)} paths kept (from {len(paths)})")


if __name__ == "__main__":
    main()
