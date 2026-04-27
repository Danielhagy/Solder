"""
Phase 2 — Synthesis (FullSpec.md § 7.2).

NO LLM in this phase. Pure deterministic generation from the discovery
output's classifications.

Generation rules (§ 7.2):
  pii_name      → Faker.name()
  pii_email     → Faker.email() with deterministic seed per entity_id
  pii_phone     → Faker.phone_number() in observed locale
  pii_ssn       → pattern match, never a real SSN
  pii_address   → Faker.address()
  pii_id        → ULID with optional observed prefix
  enum          → weighted pick from observed value set
  freetext      → Faker.paragraph() with observed length distribution
  numeric       → sampled from observed (mean, std, min, max)
  timestamp     → random in observed range, ISO 8601
  boolean       → weighted by observed frequency
  reference     → synthesized id pointing at a real entity in the bank
  object/array  → recursive

Reference resolution: parents first, children with FKs already resolved.
Cycles broken with placeholder ids resolved in a second pass.

Golden record: the most field-populated record observed during sampling
is preserved (with PII synthesized) as the default test input for the
per-node test dialog (§ 8.3).
"""

from __future__ import annotations


async def synthesize(*args, **kwargs):
    raise NotImplementedError("Slice 3")
