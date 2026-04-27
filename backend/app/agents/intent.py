"""
Phase 3 — Intent capture (FullSpec.md § 7.3).

Two-pass design — the riskiest UX in the product.

Pass 1 (silent): the agent reads source schema + target schema + the
user's free-text description, forms a hypothesis: in-scope endpoints,
direction, inferred filters, ambiguities. The user does NOT see this raw
output.

Pass 2 (visible): the agent presents the hypothesis as cards (editable
inline) and asks ONLY the questions whose answers it cannot infer from
the schemas. Banned: "what kind of data?" / "which fields?" / "anything
else?". Allowed: "I see two endpoints that could be source — /orders or
/purchase_orders. Which?".

Uses claude-opus-4-7 (reasoning-heavy). Tool use / structured output.
"""

from __future__ import annotations


async def hypothesize(*args, **kwargs):
    raise NotImplementedError("Slice 5")


async def interrogate(*args, **kwargs):
    raise NotImplementedError("Slice 5")
