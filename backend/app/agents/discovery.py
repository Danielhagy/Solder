"""
Phase 1 — Discovery (FullSpec.md § 7.1).

For each in-scope endpoint:
  1. Pull batches of records via the user's credentials (GET-only — see
     spec § 12 Q3; POST/PUT/DELETE routes are inferred or hand-added).
  2. Compute coverage: field-coverage %, enum stability, golden-record
     candidacy. Stop when all three plateau, or 1000 records, or endpoint
     exhausted.
  3. Classify each field via Claude (sonnet-4-6) — structured output via
     tool use. Field name first, sample values second, sensitivity-masked
     before the LLM ever sees them.
  4. Extract value sets for `enum` fields.
  5. Identify `reference` fields by pattern-matching against IDs in other
     endpoints in the same side.

Output: schema + classifications + value sets, written to
`test_bank.schema_json`, `value_sets`, `pii_classifications`. The synthesis
phase (no LLM) reads from this and produces actual records.
"""

from __future__ import annotations


async def run(*args, **kwargs):
    raise NotImplementedError("Slice 4")
