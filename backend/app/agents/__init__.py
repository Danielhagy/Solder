"""
Agent package — five discrete phases per FullSpec.md § 7.

Each phase is a separate prompt with a tight contract. No big-loop
autonomous agent. No silent retries. Every phase produces structured
output that the user can inspect and override in the UI.

Models per § 7:
- `claude-opus-4-7` for reasoning-heavy phases (intent, mapping)
- `claude-sonnet-4-6` for high-volume / low-stakes (classification,
  test-output explanation)

All agent calls use tool use / structured output. Never `text.find('{')`.
"""

OPUS = "claude-opus-4-7"
SONNET = "claude-sonnet-4-6"
HAIKU = "claude-haiku-4-5-20251001"
