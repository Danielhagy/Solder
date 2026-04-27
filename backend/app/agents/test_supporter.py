"""
Phase 5 — Test execution support (FullSpec.md § 7.5).

Not a single agent call — assistance that runs during testing.

When the user clicks "Test this node":
  1. If upstream nodes have run, use their last test outputs as input.
  2. Otherwise synthesize a plausible input by reading the node's
     expected input shape and pulling matching records from the test
     bank. Default: golden record. Optional: random samples.
  3. Node executes against the mock-engine.
  4. Output is captured and made available to downstream nodes.

When a test fails (mock returned a corpus error):
  - Surface the error with explanation pulled from the corpus entry's
     metadata + a small claude-sonnet-4-6 call that adds context-specific
     advice ("you sent vendor_id xyz which doesn't exist in the test bank
     — try ...").

This is the ONLY runtime LLM call in v1. Fires only on errors. Small
payload.
"""

from __future__ import annotations


async def explain_error(*args, **kwargs):
    raise NotImplementedError("Slice 1 (corpus loader) + Slice 4 (Claude wiring)")


async def synthesize_test_input(*args, **kwargs):
    raise NotImplementedError("Slice 3")
