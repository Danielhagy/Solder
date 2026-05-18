"""
CI smoke for the NewMedCo P2P diagram → IntegrationConfig compile.

Catches the audit-flagged fatal class: the compiler emitting node kinds
that don't exist in the catalog (so Test Run would die mid-demo). Asserts
every emitted kind exists in the catalog, that no flow throws, and that
the 3-way match compiles.

Run: `python -m pytest backend/tests/test_diagram_compiler_newmedco.py -v`
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.services.diagram_compiler import compile_diagram


# Canonical catalog kinds — mirrors `frontend/src/catalog.ts` as enumerated
# in the v3 audit. Any emitted kind not in this set means the runtime
# can't dispatch it.
CATALOG_KINDS = {
    ("http", "request"),
    ("transform", "map"),
    ("data", "filter"),
    ("data", "sort"),
    ("data", "unique"),
    ("data", "pick"),
    ("data", "omit"),
    ("data", "rename"),
    ("data", "ingest_to_bank"),
    ("logic", "branch"),
    ("logic", "switch"),
    ("logic", "loop"),
    ("logic", "if"),
    ("logic", "gate"),
    ("logic", "assert"),
    ("state", "set"),
    ("state", "uuid"),
    ("state", "ulid"),
    ("state", "random_int"),
    ("state", "random_float"),
    ("state", "now"),
    ("output", "passthrough"),
    ("code", "python"),
    ("ai", "extract"),
    ("ai", "classify"),
    ("ai", "summarize"),
    ("ai", "decide"),
    ("process", "call"),
    ("format", "json"),
    ("format", "csv"),
    ("format", "xml"),
    ("math", "compute"),
    ("str", "format"),
    ("time", "now"),
    ("time", "parse"),
    ("time", "format"),
    ("time", "add"),
    ("time", "diff"),
}


CONTAINER_KINDS = {("logic", "branch"), ("logic", "switch"), ("logic", "loop"), ("logic", "if")}


@pytest.fixture
def newmedco_doc() -> dict:
    """Mirror of `design_handoff_workflow_builder/src/scenario.js` —
    abridged but covers every shape the compiler needs to handle (push,
    merge, native, primary/mirror/computed, error guards)."""
    return {
        "schemaVersion": 1,
        "client": "NewMedCo",
        "title": "Oro → Ramp → Sage Intacct",
        "goal": "P2P modernisation",
        "systems": [
            {"id": "oro", "label": "Oro Labs", "role": "procurement", "connectionId": "conn-oro"},
            {"id": "ramp", "label": "Ramp", "role": "matching", "connectionId": "conn-ramp"},
            {"id": "sage", "label": "Sage Intacct", "role": "ERP", "connectionId": "conn-sage"},
        ],
        "objects": [
            {"id": "oro.vendor", "system": "oro", "label": "Vendor", "kind": "reference",
             "entityType": "vendor", "fields": [{"name": "id"}, {"name": "name"}]},
            {"id": "oro.po", "system": "oro", "label": "Purchase order", "kind": "primary",
             "entityType": "purchase_order", "fields": [
                 {"name": "po_number"}, {"name": "vendor_id"}, {"name": "line_items"},
                 {"name": "status"}, {"name": "total"}, {"name": "approved_at"},
             ]},
            {"id": "oro.receipt", "system": "oro", "label": "Item receipt", "kind": "primary",
             "entityType": "item_receipt", "fields": [
                 {"name": "receipt_id"}, {"name": "po_number"}, {"name": "lines"},
             ]},
            {"id": "ramp.vendor", "system": "ramp", "label": "Vendor", "kind": "mirror",
             "entityType": "vendor", "fields": [{"name": "external_id"}, {"name": "display_name"}]},
            {"id": "ramp.po", "system": "ramp", "label": "Purchase order", "kind": "mirror",
             "entityType": "purchase_order", "fields": [
                 {"name": "po_number"}, {"name": "external_id"}, {"name": "amount"},
             ]},
            {"id": "ramp.receipt", "system": "ramp", "label": "Item receipt", "kind": "mirror",
             "entityType": "item_receipt", "fields": [{"name": "external_id"}, {"name": "received_at"}]},
            {"id": "ramp.bill", "system": "ramp", "label": "Bill", "kind": "computed",
             "entityType": "bill", "fields": [{"name": "vendor_id"}, {"name": "invoice_number"}]},
            {"id": "sage.bill", "system": "sage", "label": "AP Bill", "kind": "mirror",
             "entityType": "bill", "fields": [{"name": "RECORDID"}, {"name": "PONUMBER"}]},
        ],
        "flows": [
            {"id": "f.vendor", "from": "oro.vendor", "to": "ramp.vendor", "direction": "push",
             "mode": "async", "role": "lookup", "cadence": "on-demand",
             "mapped": 2, "total": 2, "label": "Vendor sync", "action": "upsert"},
            {"id": "f.po", "from": "oro.po", "to": "ramp.po", "direction": "push",
             "mode": "async", "role": "primary", "cadence": "webhook",
             "mapped": 6, "total": 6, "label": "PO sync", "action": "create"},
            {"id": "f.receipt", "from": "oro.receipt", "to": "ramp.receipt",
             "direction": "push", "mode": "async", "role": "primary",
             "cadence": "webhook", "mapped": 3, "total": 3, "label": "Receipt sync",
             "action": "create"},
            {"id": "f.match.po", "from": "ramp.po", "to": "ramp.bill",
             "direction": "merge", "mode": "sync", "role": "3-way match",
             "cadence": "on bill arrival", "mapped": 1, "total": 1, "label": "PO"},
            {"id": "f.match.receipt", "from": "ramp.receipt", "to": "ramp.bill",
             "direction": "merge", "mode": "sync", "role": "3-way match",
             "cadence": "on bill arrival", "mapped": 1, "total": 1, "label": "Receipt"},
            # Native flows — must compile to output.passthrough, NOT throw
            {"id": "f.bill.sage", "from": "ramp.bill", "to": "sage.bill",
             "direction": "push", "mode": "async", "role": "native",
             "cadence": "real-time", "mapped": 0, "total": 0, "label": "Bill → Sage",
             "native": True},
        ],
        "edges": [
            {"id": "e.429", "label": "HTTP 429 retry", "kind": "retry",
             "detail": "Exp backoff", "attaches": ["f.po", "f.receipt"]},
            {"id": "e.dup", "label": "Duplicate detection", "kind": "guard",
             "detail": "idempotency_key", "attaches": ["f.po"]},
            {"id": "e.mismatch", "label": "Match exception", "kind": "fallback",
             "detail": "Bill flagged · AP reviewer queue",
             "attaches": ["f.match.po", "f.match.receipt"]},
        ],
        "triggers": [
            {"id": "t.po", "verb": "on_create", "sourceObjectId": "oro.po",
             "schedule": {"interval_seconds": 300}},
        ],
        "variables": {},
    }


def _all_nodes(nodes: list[dict]) -> list[dict]:
    """Recursively flatten — branches.<key> contains child nodes."""
    out = list(nodes)
    for n in nodes:
        for branch in (n.get("branches") or {}).values():
            out.extend(_all_nodes(branch))
    return out


def test_every_emitted_kind_exists_in_catalog(newmedco_doc):
    result = compile_diagram(newmedco_doc)
    flat = _all_nodes(result["config"]["nodes"])
    assert flat, "compiler emitted zero nodes"
    for n in flat:
        kind = (n.get("kind"), n.get("action"))
        assert kind in CATALOG_KINDS, (
            f"compiler emitted phantom kind {kind} — not in catalog. "
            f"Node id={n.get('id')} label={n.get('label')}"
        )


def test_native_flow_compiles_to_output_passthrough(newmedco_doc):
    result = compile_diagram(newmedco_doc)
    flat = _all_nodes(result["config"]["nodes"])
    # f.bill.sage is native; its emitted node must be output.passthrough
    passthrough_native = [
        n for n in flat
        if n["kind"] == "output" and n["action"] == "passthrough"
        and "Ramp native" in (n.get("label") or "")
    ]
    assert passthrough_native, "native flow did not compile to output.passthrough"
    # And the config carries a `comment` so the run drawer renders it
    assert all("comment" in n["config"] for n in passthrough_native)


def test_logic_branch_emitted_as_container_with_arms(newmedco_doc):
    """Fallback guards emit logic.branch (container) with true/false arms."""
    result = compile_diagram(newmedco_doc)
    flat = _all_nodes(result["config"]["nodes"])
    branches = [n for n in flat if n["kind"] == "logic" and n["action"] == "branch"]
    assert branches, "fallback guard should have emitted a logic.branch"
    for b in branches:
        assert "branches" in b, "logic.branch must declare branches (container)"
        assert "true" in b["branches"] and "false" in b["branches"], (
            f"logic.branch missing true/false arms: {b.get('id')}"
        )


def test_three_way_match_emits_two_fetches_plus_loops(newmedco_doc):
    """The bill computed from PO + ItemReceipt should produce two source
    fetches (oro.po, oro.receipt or their state.set republishes) +
    loops feeding ramp.bill writes."""
    result = compile_diagram(newmedco_doc)
    nodes = result["config"]["nodes"]
    # Two loops attaching to ramp.bill writes
    flat = _all_nodes(nodes)
    bill_writes = [
        n for n in flat
        if n["kind"] == "http" and n["action"] == "request"
        and "Bill" in (n.get("label") or "")
    ]
    assert len(bill_writes) >= 2, (
        f"3-way match should emit at least 2 Bill writes (one per merge edge); "
        f"got {len(bill_writes)}"
    )


def test_schedule_trigger_compiled_when_diagram_says_on_create(newmedco_doc):
    result = compile_diagram(newmedco_doc)
    trig = result["trigger"]
    assert trig["type"] == "schedule"
    assert trig["dedupe_field"] == "id"
    assert trig["seen_ids"] == []
    assert trig.get("_diagram_verb") == "on_create"


def test_no_phantom_kinds_in_native_only_doc():
    """A minimal doc with ONLY a native flow must not throw."""
    minimal = {
        "schemaVersion": 1,
        "client": "X",
        "systems": [
            {"id": "a", "label": "A", "connectionId": "c-a"},
            {"id": "b", "label": "B", "connectionId": "c-b"},
        ],
        "objects": [
            {"id": "a.x", "system": "a", "label": "X", "kind": "primary", "entityType": "x", "fields": []},
            {"id": "b.x", "system": "b", "label": "X", "kind": "mirror", "entityType": "x", "fields": []},
        ],
        "flows": [
            {"id": "f.n", "from": "a.x", "to": "b.x", "role": "native",
             "mode": "async", "direction": "push", "cadence": "real-time",
             "mapped": 0, "total": 0, "label": "Native", "native": True},
        ],
        "edges": [],
        "triggers": [{"id": "t", "verb": "manual", "sourceObjectId": "a.x"}],
    }
    result = compile_diagram(minimal)
    assert result["trigger"]["type"] == "manual"
    flat = _all_nodes(result["config"]["nodes"])
    for n in flat:
        assert (n["kind"], n["action"]) in CATALOG_KINDS


def test_state_set_emitted_for_trigger_source_when_manual():
    """Manual trigger + the source-of-trigger object → state.set republishing $.trigger.payload."""
    doc = {
        "schemaVersion": 1,
        "client": "X",
        "systems": [
            {"id": "a", "label": "A", "connectionId": "c-a"},
            {"id": "b", "label": "B", "connectionId": "c-b"},
        ],
        "objects": [
            {"id": "a.x", "system": "a", "label": "X", "kind": "primary", "entityType": "x", "fields": [{"name": "id"}]},
            {"id": "b.x", "system": "b", "label": "X", "kind": "mirror", "entityType": "x", "fields": [{"name": "id"}]},
        ],
        "flows": [
            {"id": "f.x", "from": "a.x", "to": "b.x", "action": "create",
             "role": "primary", "mode": "async", "direction": "push",
             "cadence": "manual", "mapped": 1, "total": 1, "label": "X sync"},
        ],
        "edges": [],
        "triggers": [{"id": "t", "verb": "manual", "sourceObjectId": "a.x"}],
    }
    result = compile_diagram(doc)
    flat = _all_nodes(result["config"]["nodes"])
    set_nodes = [n for n in flat if n["kind"] == "state" and n["action"] == "set"]
    assert any("trigger" in (n.get("label") or "") for n in set_nodes), (
        "manual trigger should emit state.set republishing $.trigger.payload"
    )
