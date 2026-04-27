"""
Mock-engine — the centerpiece of Solder's differentiation (FullSpec.md § 5.1).

One FastAPI service. Many mock specs (one per integration × side). Adding a
new connector means generating a new mock spec, never deploying a new
service.

The engine handles every request through this pipeline (§ 5.1):
  1. Resolve integration → load mock spec (`spec_loader`)
  2. Match route → 404 if absent
  3. Validate request → real-shaped 4xx if invalid (`request_validator`)
  4. Check error injection → return corpus error if triggered (`error_injector`)
  5. Resolve response → bank + session overlay (`response_generator`,
     `session_manager`)
  6. Audit → log to `run_audit_event` (handled by router)

Hot-path target: sub-50ms p95. No LLM calls in the request path. Reads are
plain Postgres queries against pre-generated rows.
"""
