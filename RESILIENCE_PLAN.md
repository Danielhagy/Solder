# Solder — Resilience & Resume Plan

**Owner:** node-catalog agent (Opus 4.7 1M)
**Authored:** 2026-04-26
**Reference docs:** `FullSpec.md`, `HANDOFF.md`, `NODE_CATALOG_PLAN.md`, `backend/app/temporal/{workflows,activities}.py`

This plan addresses three intertwined concerns surfaced in product
discussion:

1. **Mass REST.** Process N items efficiently against a target API (Zip,
   HubSpot, …) — concurrency, rate-limit awareness, native bulk endpoints.
2. **Resume after failure.** When an integration partially completes (47 of
   100 items succeeded, 3 failed, 50 unattempted), the user should be able
   to retry only the failures + pending items, not replay the whole run.
3. **Per-iteration error policy.** Per-Loop control over what happens on
   failure: halt the run, continue and log, or checkpoint for resumability.
   Optionally branch by error kind (auth → halt, permanent → continue,
   transient → retry).

Everything here is opinionated. Where it says "build X," do X unless you
have a specific reason not to and can articulate it.

---

## 1. What Temporal already gives us

The runtime is `IntegrationRunWorkflow` on Temporal. We get for free:

- **Worker-crash resilience.** If a worker dies mid-run, the workflow
  resumes from history on a fresh worker. No human action.
- **Activity-level retries with exponential backoff** via
  `RetryPolicy`. Configurable per activity.
- **Durable activity results.** Once an activity returns, that result
  is in workflow history. Replay never re-issues the activity. So
  "don't repeat what already worked" is a Temporal primitive — we
  don't have to build it.
- **`run_audit_event` table.** Every mock-engine HTTP touch logs
  request/response/status/duration/`error_injected`. Already wired
  for runs that pass `X-Solder-Run-Id`.

That handles infra-level failures cleanly. **What's missing** is
iteration-level resume *inside* a Loop — which is the user-visible
case.

---

## 2. Architecture

### 2.1 Error classifier

In `execute_api_call` (and any future HTTP-touching activity), label every
failure into one of three kinds:

| Kind | Examples | Default policy |
|---|---|---|
| `transient` | `socket.timeout`, 5xx, 429 with `Retry-After`, `ECONNRESET` | Retry inside the activity (Temporal handles); if still failing, record |
| `permanent` | 4xx with semantic error (`INVALID_REFERENCE`, `VALIDATION_FAILED`, 422) | Record as failed; never retry |
| `auth` | 401, 403 | Halt the run; user must fix credentials before resume |

The classifier returns `APICallOutput.error_kind: 'transient' | 'permanent' | 'auth' | None`.
Mock-engine error corpus entries (`zip.po.invalid_vendor_ref` etc.) get
mapped to `permanent`.

### 2.2 Loop iteration tracking

Each `logic.loop` iteration produces a structured record:

```python
{
    "index": int,
    "status": "success" | "failed",
    "output": Any | None,         # successful body output
    "error": str | None,
    "error_kind": str | None,     # from classifier when applicable
    "duration_ms": int,
}
```

Stored on the Loop's step record as `iterations: list[...]`. The Run drawer
renders this as a per-item rollup.

### 2.3 Loop config additions

Three new fields on `logic.loop` config:

```jsonc
{
  "over": "$.items",              // existing
  "reduce": "collect",            // existing
  "on_failure": "continue",       // NEW — halt | continue | checkpoint
  "concurrency": 1,               // NEW — N iterations in flight at once
  "max_failed_pct": 50            // NEW — safety net (default 50)
}
```

| `on_failure` | Behavior | Run status |
|---|---|---|
| `halt` | First iteration error stops the loop; downstream nodes receive the error. **Back-compat default** — Loops without the field behave like today. | `failed` |
| `continue` | Record the per-iteration failure, keep iterating, never block downstream. **Recommended default for new Loop nodes.** | `partial` (new status — see §3) when any item failed, else `success` |
| `checkpoint` | Same as `continue`, plus persist a `run_checkpoint` row; surfaces "Retry failures" in Run drawer | `partial` |

`concurrency: N` runs N iterations in parallel via `asyncio.gather` of
activity calls. Default `1` (sequential) for back-compat. Workflow
determinism is preserved because Temporal sequences activity IDs.

`max_failed_pct: 50` is a **safety net**: when the running ratio of
failed-to-attempted exceeds 50%, the loop flips to halt mid-stream.
Prevents burning through API quota when something's catastrophically
wrong upstream. `100` disables the safety net.

### 2.4 Checkpoint table (R-3)

```sql
run_checkpoint (
  id              uuid primary key,
  run_id          uuid not null references runs(id) on delete cascade,
  loop_node_id    text not null,            -- node.id within the integration
  total_items     int not null,
  completed       jsonb not null,           -- list[int] of zero-based indices
  failed          jsonb not null,           -- list[{index, error, error_kind, attempts}]
  pending         jsonb not null,           -- list[int]
  frozen_input    jsonb not null,           -- snapshot of $.items at loop entry
  last_checkpoint_at timestamp with time zone not null default now(),
  unique (run_id, loop_node_id)
)
```

Written by the Loop executor. Flush cadence: every 10 iterations or 5
seconds, whichever first; always flushed on terminal status. Tunable via
env if it becomes a bottleneck.

### 2.5 Retry endpoint (R-4)

```
POST /api/runs/{run_id}/retry_failures
  → 200 { new_run_id: uuid, parent_run_id: run_id }
```

Reads the latest checkpoint for each Loop in the parent run. Creates a new
`Run` row with `parent_run_id = original`. Starts the workflow with a
special input flag `resume_from: parent_run_id`. The workflow's loop
executor, when it sees `resume_from`, fetches the checkpoint and skips
indices in `completed` — re-running only `failed + pending`.

The new run produces its own checkpoint. Chain another retry on top if
needed.

### 2.6 Per-error-kind override (R-7, deferred)

```jsonc
{
  "on_failure": "continue",
  "override": {
    "auth": "halt",
    "permanent": "continue",
    "transient": "continue"
  }
}
```

Don't ship the UI until the simple `on_failure` field has adoption
signal. Common case ("halt on auth, continue otherwise") is one extra
config line.

### 2.7 Bulk-endpoint connector ops (R-9)

For APIs with native batch endpoints (HubSpot's `/batch/create/contacts`
takes 100 records per call), add catalog entries like
`connector.hubspot.batch_create_contacts`. The runtime executor:

1. Reads `over: "$.items"` and slices into chunks of `chunk_size: 100`.
2. Submits each chunk as one HTTP call.
3. Parses the 207 Multi-Status response into per-item outcomes.
4. Surfaces per-item failures via the same `iterations: [...]` shape as
   the iterate-and-call path — the UX stays uniform.

Per-API. Prioritize Zip + HubSpot for v1.

---

## 3. New Run status: `partial`

Currently `RunStatus = pending | running | success | failed | timeout |
cancelled`. Add `partial`.

- A run with at least one failed Loop iteration but no halt errors is
  `partial`, not `success` or `failed`.
- The Runs page gets a `partial` chip (amber, between `success` and
  `failed`).
- The "Retry failures" button only appears when status is `partial` or
  `failed` AND there's at least one `run_checkpoint`.

Easier to filter the Runs page for "needs attention." Cleaner than
overloading `success` with a flag.

---

## 4. Run drawer UX

```
✗ "Sync vendors → contacts" — partial · 47 of 100 succeeded

  Stage 2 — Loop
    ✓ 47 succeeded   (avg 220ms)
    ✗ 3 failed
      └─ #48: 429 rate limit (Retry-After: 60s)         [transient]
      └─ #76: 400 INVALID_REFERENCE vendor_id="v_xyz"   [permanent]
      └─ #94: timeout after 30s                          [transient]
    · 50 pending (never attempted)

  [ Retry failures + pending ]   [ Replay full run ]   [ Discard ]
```

`Retry failures + pending` skips the 47 succeeded ones. `Replay full run`
is the existing path (no checkpoint awareness).

---

## 5. Try/catch interaction

`on_failure` is the **whole-loop** policy — what does the runtime do with
iteration N's error? `logic.try_catch` (planned Tier-2 container) is a
**per-iteration recovery path** — the body wraps a Try, the Catch arm sees
`$.error` and routes to compensation logic (push to a dead-letter queue,
log to Slack, retry against a different endpoint).

They compose. `try_catch` inside the loop body usually turns failures back
into successes — `on_failure` rarely fires. When it does, the user has a
bigger problem (the recovery path itself broke).

---

## 6. Implementation waves

Sized so each is independently shippable. R-1 + R-2 deliver the bulk of the
user-facing value before the durability layer (R-3+) lands.

- ✅ **R-1** — `on_failure: 'halt' | 'continue'` + per-iteration step records + reduce mode honored. Shipped 2026-04-26.
- ✅ **R-2** — Error classifier in `execute_api_call` + `execute_paginated_api_call`. Returns `error_kind: 'transient' | 'permanent' | 'auth'`. New `APICallError` exception carries it from activity → workflow → Loop iteration record. Shipped 2026-04-26.
- **R-3** — `run_checkpoint` table + `on_failure: 'checkpoint'` mode.
  Postgres migration; checkpoint flush from Loop executor.
- **R-4** — `POST /api/runs/{id}/retry_failures` + workflow `resume_from`
  mode. Skips completed indices using the checkpoint.
- **R-5** — Run drawer per-Loop progress block + per-iteration drill-down
  + Retry button. Frontend.
- **R-6** — `concurrency: N` on Loop. `asyncio.gather` of activity calls
  per batch. Rate-limit-aware backoff when the classifier flags 429.
- **R-7** — Per-error-kind override (`override: {auth: 'halt', …}`).
- **R-8** — `max_failed_pct` safety net.
- **R-9** — Bulk-endpoint connector ops. Per-API.
- **R-10 (optional)** — `process.call` in for-each mode gets the same
  `on_failure` / `concurrency` config as Loop. Mirror.

R-1, R-2 are independently useful even without resume. R-3 + R-4 + R-5 are
a single coherent wave — ship them together. R-6+ is incremental.

---

## 7. Schema migration (R-3)

```sql
-- New table
create table run_checkpoint (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  loop_node_id text not null,
  total_items int not null,
  completed jsonb not null default '[]'::jsonb,
  failed jsonb not null default '[]'::jsonb,
  pending jsonb not null default '[]'::jsonb,
  frozen_input jsonb not null,
  last_checkpoint_at timestamp with time zone not null default now(),
  unique (run_id, loop_node_id)
);
create index ix_run_checkpoint_run_id on run_checkpoint(run_id);

-- Existing runs table: add the link + the new status value
alter table runs add column parent_run_id uuid references runs(id);
alter table runs add column resume_from_run_id uuid references runs(id);
-- RunStatus enum gets 'partial'
alter type run_status add value if not exists 'partial';
```

`parent_run_id` is the linked retry-of relationship; `resume_from_run_id`
is the run whose checkpoint we're picking up from. Same value most of the
time but separable in principle (e.g. a retry of a retry).

---

## 8. Open questions

Decisions worth a product call before R-3 hardens.

1. **Default for new Loop nodes**. Recommend `continue`. Catches more bugs
   than the current `halt` only when bugs are infrastructure; loses to
   `halt` only when the user actually wants the run to stop on first
   failure. Reasonable default for "process N records, tell me which
   broke."

2. **Checkpoint flush cadence**. Every iteration is too chatty for
   100-iteration loops; never-flush loses on worker crash. Recommend "every
   10 iterations or 5 seconds, whichever first" with a runtime override.

3. **Retry depth cap**. How many times can a user retry-of-a-retry? Cap at
   5 per item before the iteration is "permanently failed" with no retry
   button. Prevents infinite retry loops on a genuinely broken target.

4. **Cross-loop semantics**. Nested loops with different policies — outer
   `halt`, inner `continue`. Recommend: each loop's policy applies only to
   its own iterations. Inner failures bubble up as iteration outputs of
   the outer loop, where the outer's policy decides. Document, don't
   over-engineer.

5. **`partial` vs `success` for runs with 0 actual failures**. If
   `on_failure: 'continue'` is set but every iteration succeeded, the
   status is `success` — `partial` only fires on at least one real failure.

6. **Concurrency interaction with Temporal's activity history**. With
   `concurrency: 100` and a 1000-item loop, that's 1000 activity
   invocations. Workflow history can grow large. Recommend chunking via
   continue-as-new every 10K activities — but defer until usage signals.

---

## 9. What lives where

| Artifact | File / surface |
|---|---|
| Loop iteration tracking | `backend/app/temporal/workflows.py:_dispatch_node` (logic.loop case) |
| Per-step extras side-channel | `IntegrationRunWorkflow.self._step_extras` |
| Error classifier | `backend/app/temporal/activities.py:execute_api_call` (post-response branch) |
| Checkpoint table | New SQLAlchemy model `RunCheckpoint` in `backend/app/models/run_checkpoint.py` + Alembic migration |
| Retry endpoint | New `backend/app/api/runs.py` route handler |
| Workflow resume mode | `IntegrationRunWorkflow.run()` reads `input.resume_from`, fetches checkpoint, applies skip-set in loop executor |
| Frontend `on_failure` editor | `frontend/src/components/builder/editors/logic.tsx` (LoopEditor) — small select |
| Run drawer per-Loop block | `frontend/src/components/builder/RunDrawer.tsx` |
| `partial` status | `backend/app/models/run.py` enum extension; frontend `chip-warn` rendering |

---

## 10. What this means for FullSpec

- **§5 Architecture** — no changes; this all lives in the runtime + a new
  table.
- **§8 UX** — wants a new sub-section §8.7 on resume controls.
- **§11 Conventions** — add an invariant: "Loop iterations are always
  tracked individually in `step.iterations`, regardless of `on_failure`.
  The user can see what happened per item even when the loop completed
  successfully."
