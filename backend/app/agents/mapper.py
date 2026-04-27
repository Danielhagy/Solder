"""
Phase 4 — Mapping (FullSpec.md § 7.4).

For each (source_field, target_field) pair, compute a similarity score
from: name semantic similarity, type compatibility, value-set overlap
(enums), format compatibility (ids, timestamps). Greedy match highest-
scoring pairs first. Flag unmatched-but-required target fields for user
attention.

Submit the candidate mapping to claude-opus-4-7 for review/refinement;
the model can swap pairs, suggest reasoning, raise low-confidence flags.

v1: only `transform: identity`. Concat / split / lookup / conditional are
v2 territory (spec § 10).
"""

from __future__ import annotations


async def propose(*args, **kwargs):
    raise NotImplementedError("Slice 6")
