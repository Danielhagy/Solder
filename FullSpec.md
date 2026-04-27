# Solder — Product & Engineering Spec (v1)

**Owner:** Dan
**Status:** Draft for Claude Code execution
**Last updated:** 2026-04-26

---

## 0. How to read this document

This spec is opinionated. Where it says "build X," do X unless you have a specific reason not to and can articulate it. Where it says "we considered Y and rejected it because Z," don't quietly reintroduce Y.

The doc is organized so you can read top-to-bottom for context or jump to a section when implementing. Section 4 (User Journey) is the product story. Section 5 (Architecture) is what you actually build. Section 7 (Agent System) is where the AI work lives. Sections 11–12 are the rules and the unresolved.

---

## 1. What Solder is

Solder is an integration platform where you build connections against a **local replica of the target system that knows how the real system breaks**. No sandbox tenant required. No production data leaves production. No ship-and-pray.

The differentiated workflow:

1. Point Solder at a source and a target API
2. Solder pulls a sample, classifies fields (PII, enums, references, free text), and generates a stateful synthetic test bank
3. Solder spins up mock servers that respond to real HTTP webservice calls — including realistic errors drawn from a curated error corpus
4. The user builds the integration in the canvas against those mocks, iterating fast
5. When ready, the user flips to live, and the integration runs identically against the real APIs

The bet is that the slow, risky, error-prone phases of integration work are *discovery* and *validation against production behavior*. Solder collapses both into a tight, safe loop.

## 2. Who it's for

Technical-but-not-developer users: integration consultants, solutions engineers, IT analysts, ops folks at companies running enterprise systems. Not non-technical end users — they have Zapier. Not senior engineers — they have code. The middle tier of capability that has to ship integrations under deadline pressure without the budget for a full eng team.

Persona detail: someone who can read JSON, understands what an API endpoint is, can write a JSONPath expression with effort, but does not want to write Python and does not have a Workday sandbox tenant available.

## 3. What this isn't

Pinning these down explicitly because the surrounding space is full of products that look similar:

- **Not Zapier.** Different user, different scale, different complexity ceiling.
- **Not n8n.** We are not optimizing for "self-host everything, code your own nodes." We are optimizing for "build it once, ship it confidently, against a replica that mimics prod."
- **Not Workato.** We are not selling enterprise governance, recipe marketplaces, or six-figure contracts.
- **Not Merge.dev / Nango.** We are not an embedded integration backend for SaaS companies. The user is the buyer; their integrations are theirs.
- **Not an autonomous AI integration agent.** AI proposes, user confirms, every step. Frame: scaffolding, not autopilot.

---

## 4. v1 scope

### In scope

- Connector setup with credentials (Zip on both sides for dev, second real connector required before v1 is shippable)
- AI-driven intent capture with two-pass interrogation (Section 7.3)
- Adaptive sampling discovery with PII / enum / reference / freetext field classification (Section 7.1)
- Stateful synthetic test bank generation per integration, with referential integrity preserved (Section 6.2)
- Mock-engine HTTP service serving per-integration mock specs (Section 5.1)
- Static hand-authored error corpus per API, injectable into mock responses (Section 5.4)
- AI-suggested source-to-destination field mappings, user confirmation required (Section 7.4)
- The existing canvas (StagesGraph, Builder.tsx) wired to the new mock infrastructure
- Per-node test execution pulling from upstream node outputs OR test bank values (Section 8.3)
- Environment selector: Sandbox / Production with per-node override and read-vs-write asymmetry (Section 8.2)
- Cutover from mock to live via config flag (no redeploy, no rebuild)

### Out of scope (v1)

These are not "we'll get to them" — they are deliberate cuts. Adding them shifts focus away from what makes Solder Solder.

- Web crawler / API docs ingestion pipeline (deferred to v2-v3, see Section 10)
- Webhook and schedule trigger types (cosmetic in current build per handoff doc; remove or hide in UI)
- Transformation logic in mappings beyond identity / direct mapping (v2)
- Workday SOAP as the v1 second connector (deferred — see Section 9.2)
- Multi-tenancy, user accounts, billing, auth beyond local dev
- Marketplace, templates, sharing
- Cross-user error sharing or learning loop (privacy implications, v3+)
- LLM-generated errors at request time (we use a static corpus; see Section 5.4)

### What changes from current build

The codebase per the handoff doc has the canvas, builder, run drawer, properties panel, integrations list, history, docs, and a stubbed Temporal-based execution layer. v1 keeps all of this and adds:

- The discovery → synthesis → mock-engine pipeline (new)
- The intent-capture conversation flow (new)
- The mapping confirmation UI (new)
- The environment selector and per-node mock/live toggle (new)
- Real mock HTTP endpoints for nodes to call (new)

The Temporal workflow stubs (`BuildIntegrationWorkflow`, `TestIntegrationWorkflow`) become real in v1. The `record_learning` activity stays a no-op for now.

---

## 5. Architecture

### 5.1 The mock-engine

The mock-engine is the centerpiece of Solder's differentiation. It is a single FastAPI service (extending the existing backend) that serves as a parameterized HTTP mock for every integration's source and target APIs.

**Design principle:** one engine, many mock specs. Adding a new client API to Solder is "generate a new mock spec," never "deploy a new service."

**Routing model:**

```
POST  http://localhost:8000/mock/{integration_id}/{side}/{path}
                            ──┬──   ──────┬──────  ─┬──  ─┬──
                              │           │         │     └─ matches the real API path
                              │           │         └─ "source" or "target"
                              │           └─ which integration this belongs to
                              └─ mock-engine route prefix
```

A user's integration node configured to call `https://api.zip.co/v1/purchase_orders` against the mock instead calls `http://localhost:8000/mock/{integration_id}/source/v1/purchase_orders`. The base URL is swapped at runtime based on the environment selector — the integration definition itself stores the *real* URL, not the mock URL.

**Request handling pipeline:**

1. **Resolve integration** — extract `integration_id` from path, load mock spec
2. **Match route** — find route definition in mock spec; 404 if not present
3. **Validate request** — apply request validators (auth, headers, body shape, query params); return real-shaped 4xx if invalid
4. **Check error injection** — consult error corpus rules for this route; if conditions met, return error response and stop
5. **Resolve response** — look up entities in stateful test bank, apply session-state overlay, generate response payload
6. **Audit** — log full request + response to the run's audit trail

**Statefulness:** see Section 6.3.

**Latency:** target sub-50ms p95 for mock responses. No LLM calls in the request path. Test bank reads are Postgres queries against pre-generated rows.

### 5.2 The test bank

Per integration, two test banks: `source_test_bank` and `target_test_bank`. Each is a synthetic mirror of the real API's data, generated from sampled production records during discovery.

A test bank is logically a set of typed entities with references between them. For the Zip-to-Zip case, this might include:

- `purchase_orders` — 100 records
- `vendors` — 50 records
- `users` — 30 records
- `line_items` — 400 records (referenced by purchase_orders)
- `approval_chains` — 25 records

References are preserved: a purchase_order's `vendor_id` always resolves to a real vendor in the test bank. PII fields are synthesized (Faker-generated). Enum fields use real observed value sets. Free-text fields are pattern-generated. Numeric fields preserve order-of-magnitude distribution from the sample.

**Storage:** Postgres JSONB. One row per entity instance. See Section 6.2 for schema.

### 5.3 Session state

A test bank is read-mostly, but mocks need to handle writes (POST creates a record; subsequent GET retrieves it). Naive solution: write directly to test bank. Wrong, because every test run pollutes the bank for the next run.

**Right solution:** session state. Each integration run gets a `mock_session` — a writable overlay over the test bank. POST/PUT/DELETE writes go to the session. Reads merge session state with test bank state (session wins on conflicts).

Sessions are explicitly scoped:

- **Run-scoped** (default): session lives for one integration run, deleted on completion
- **Persistent**: user can opt to persist a session across runs (useful for iterating on a multi-step flow without rebuilding state)
- **Reset action**: user can reset session state to test-bank baseline at any time

Session state UI lives in the run drawer alongside the run plan.

### 5.4 The error corpus

A static, hand-authored JSON file per supported API. Lives at `backend/app/mock_engine/error_corpora/{api_name}.json`. Contains the realistic error shapes that API returns.

**Format:**

```json
{
  "api_name": "zip",
  "version": "1.0",
  "errors": [
    {
      "id": "zip.po.invalid_vendor_ref",
      "applies_to_routes": ["POST /v1/purchase_orders", "PUT /v1/purchase_orders/{id}"],
      "trigger": {
        "type": "field_value",
        "field": "vendor_id",
        "condition": "not_in_test_bank"
      },
      "response": {
        "status": 400,
        "body": {
          "error": {
            "code": "INVALID_REFERENCE",
            "message": "Vendor with id '{vendor_id}' not found",
            "field": "vendor_id"
          }
        }
      },
      "frequency": {
        "deterministic": true,
        "chaos_weight": 0.0
      }
    }
  ]
}
```

**Trigger types** for v1:

- `field_value`: error fires based on a request field's value (validates against test bank)
- `request_shape`: error fires when request body is malformed (missing required field, wrong type)
- `random`: error fires randomly at configured frequency (chaos mode)
- `manual`: error only fires when user explicitly requests it via test UI

**Authoring scope for v1:** ~30 errors per supported API, hand-written. For Zip, Dan writes them — he knows them already. For the second connector, written from API docs. LLMs may be used at *authoring time* to draft error JSON from docs, but no LLM runs in the request path.

**Chaos mode:** a per-test-run toggle. When enabled, errors with `chaos_weight > 0` may fire randomly during normal request handling. Useful for resilience testing.

### 5.5 Process flow

The pipeline from "user creates integration" to "user runs mock-backed test":

```
Setup
  └─ User connects credentials for source + target APIs (settings)

Intent capture (agent phase 1, Section 7.3)
  ├─ User describes integration in natural language
  ├─ AI fetches source + target API schemas in background
  ├─ AI presents hypothesis with targeted questions
  └─ User confirms scope + endpoints in scope

Discovery (agent phase 2, Section 7.1)
  ├─ Mock-engine pulls sample from each in-scope endpoint
  ├─ Adaptive sampling until coverage thresholds met
  ├─ Field classification per response field
  └─ Output: schema + classification + value sets

Synthesis (agent phase 3, Section 7.2)
  ├─ Generate synthetic records preserving distributions, enums, references
  ├─ Write to source_test_bank and target_test_bank
  └─ Generate mock spec (routes + validators + responders)

Mapping (agent phase 4, Section 7.4)
  ├─ AI proposes source-to-destination field mappings
  ├─ Confidence scores per mapping
  └─ User confirms / overrides in mapping UI

Build
  └─ User constructs integration in canvas (existing builder)

Test (agent phase 5 if needed, Section 7.5)
  ├─ User runs full integration or single node
  ├─ Nodes hit mock-engine endpoints
  ├─ Errors injected per corpus
  └─ Run drawer shows results

Cutover
  └─ User flips environment selector to Production
     → integration runs identically against real APIs
```

---

## 6. Data models

### 6.1 Integration

Already exists in current schema. Adds the following fields:

```
integration:
  id: uuid
  name: string
  source_connector_id: fk → connector
  target_connector_id: fk → connector
  source_credentials_id: fk → credential
  target_credentials_id: fk → credential
  environment: enum(sandbox, production)        # NEW
  intent_summary: text                          # NEW — captured during intent phase
  discovery_status: enum(pending, running, complete, failed)  # NEW
  mock_spec_id: fk → mock_spec                  # NEW
  source_test_bank_id: fk → test_bank           # NEW
  target_test_bank_id: fk → test_bank           # NEW
  // existing fields preserved
```

### 6.2 Test bank

```
test_bank:
  id: uuid
  integration_id: fk → integration
  side: enum(source, target)
  api_name: string                              # e.g. "zip"
  schema: jsonb                                 # field classifications
  value_sets: jsonb                             # enum values per field
  pii_classifications: jsonb                    # field → pii_type mapping
  refreshed_at: timestamp
  source_sample_size: int                       # how many real records pulled

test_bank_entity:
  id: uuid
  test_bank_id: fk → test_bank
  entity_type: string                           # e.g. "purchase_order"
  entity_id: string                             # synthesized id, stable across regenerations
  data: jsonb                                   # the synthetic record
  is_golden: bool                               # the record with most fields populated
  references: jsonb                             # outbound references to other entities

  index on (test_bank_id, entity_type)
  index on (test_bank_id, entity_type, entity_id)
```

The `references` field is a structured map like `{"vendor_id": {"entity_type": "vendor", "entity_id": "v_abc123"}}`. The synthesizer populates this so the mock-engine can resolve relationships without re-parsing every request.

### 6.3 Mock session

```
mock_session:
  id: uuid
  integration_id: fk → integration
  run_id: fk → run, nullable                    # null if persistent, set if run-scoped
  scope: enum(run, persistent)
  created_at: timestamp
  reset_at: timestamp                           # last time session was reset

mock_session_write:
  id: uuid
  mock_session_id: fk → mock_session
  side: enum(source, target)
  entity_type: string
  entity_id: string
  operation: enum(create, update, delete)
  data: jsonb
  created_at: timestamp

  index on (mock_session_id, side, entity_type, entity_id)
```

When the mock-engine resolves a GET request, it reads from `test_bank_entity` and overlays any matching `mock_session_write` rows (latest wins). Deletes are tombstones.

### 6.4 Mock spec

```
mock_spec:
  id: uuid
  integration_id: fk → integration
  side: enum(source, target)
  api_name: string
  version: int
  routes: jsonb                                 # see structure below
  request_validators: jsonb
  response_generators: jsonb
  business_rules: jsonb                         # empty in v1, scaffolded for future agent enrichment
  generated_by: enum(discovery, agent_curated, hand_authored)
  created_at: timestamp
```

The `routes` JSON is shaped like:

```json
{
  "routes": [
    {
      "path": "/v1/purchase_orders",
      "method": "GET",
      "responder": {
        "type": "list_entities",
        "entity_type": "purchase_order",
        "supports_pagination": true,
        "page_size_default": 25
      },
      "validators": ["auth_bearer"]
    },
    {
      "path": "/v1/purchase_orders/{id}",
      "method": "GET",
      "responder": {
        "type": "get_entity",
        "entity_type": "purchase_order"
      },
      "validators": ["auth_bearer"]
    },
    {
      "path": "/v1/purchase_orders",
      "method": "POST",
      "responder": {
        "type": "create_entity",
        "entity_type": "purchase_order",
        "required_fields": ["vendor_id", "line_items"],
        "id_generator": "po_{ulid}"
      },
      "validators": ["auth_bearer", "json_body"]
    }
  ]
}
```

### 6.5 Run audit

Every mock request and response gets logged for debugging. Existing `run` table extended:

```
run_audit_event:
  id: uuid
  run_id: fk → run
  node_id: string                               # which canvas node made the call
  timestamp: timestamp
  direction: enum(request, response)
  side: enum(source, target)
  method: string
  path: string
  headers: jsonb
  body: jsonb
  status: int (nullable, only on response)
  error_injected: string (nullable)             # corpus error id if one fired
  duration_ms: int
```

This becomes the data source for the run drawer's detailed view and is the user's primary debugging surface when integrations misbehave.

---

## 7. Agent system

Five discrete agent phases. Each is a separate prompt with a tight contract. No big-loop autonomous agent. No silent retries. Every phase produces structured output the user can inspect and override.

All agent calls use `claude-opus-4-7` for reasoning-heavy phases (intent, mapping) and `claude-sonnet-4-6` for high-volume / low-stakes phases (field classification, synthesis). Update `services/agent.py` — current pinned `claude-sonnet-4-20250514` is stale.

All agent calls use **tool use / structured output**, not text parsing. The current `text.find("{")` JSON extraction in `IntegrationAgent` is replaced.

### 7.1 Phase 1 — Discovery

**Input:** integration_id, side, list of in-scope endpoints (from intent capture)
**Output:** schema + field classifications + value sets per endpoint, written to test_bank.schema

**Algorithm:**

1. For each in-scope endpoint:
   - Pull batch of 50 records using user's credentials
   - Compute coverage metrics:
     - Field coverage: % of unioned fields with at least one non-null observation
     - Enum stability: for fields with <20 distinct values, have we seen no new values in 2 batches?
     - Golden record candidate: any record with >80% field population?
   - Stop when all three metrics plateau, OR 1000 records, OR endpoint exhausted
2. Classify each field via Claude (sonnet-4-6):
   - Input: field name, sample of 20 values (with values masked if obviously sensitive on field name alone)
   - Output: `{field_path, classification, confidence, reasoning}`
   - Classifications: `pii_name | pii_email | pii_phone | pii_ssn | pii_address | pii_id | enum | freetext | numeric | timestamp | boolean | reference | object | array`
3. Extract value sets for fields classified as `enum` (full distinct list)
4. Identify references: fields whose values match patterns of IDs in other endpoints

**Critical:** PII-classified fields must have their sample values redacted before being sent to Claude in any subsequent phase. The discovery sample is the *only* place real values touch the LLM, and even there, classification is best-effort done from field names first, sample values second, with sensitivity masking applied.

**Field classification prompt skeleton:**

```
You are classifying API response fields to determine appropriate handling for a synthetic
data generator.

For each field below, classify it as one of: pii_name, pii_email, pii_phone, pii_ssn,
pii_address, pii_id, enum, freetext, numeric, timestamp, boolean, reference, object, array.

Heuristics:
- A field is enum if it has fewer than 20 distinct values across the sample
- A field is pii_* if it contains personally identifying information
- A field is reference if it appears to point to an entity in another endpoint
- A field is freetext if it's free-form natural language with no constrained vocabulary

For each field, return:
{
  "field_path": "...",
  "classification": "...",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence"
}

Fields to classify: [structured input]
```

### 7.2 Phase 2 — Synthesis

**Input:** test_bank with schema and classifications
**Output:** populated test_bank_entity rows

**No LLM in this phase.** Pure deterministic generation.

**Generation rules per classification:**

- `pii_name`: Faker `name()`
- `pii_email`: Faker `email()` with deterministic seed per entity_id
- `pii_phone`: Faker `phone_number()` with locale matching observed sample
- `pii_ssn`: pattern-matching the observed format, never a real SSN
- `pii_address`: Faker `address()`
- `pii_id`: ULID with optional prefix matching observed pattern
- `enum`: random selection from observed value set, weighted by observed frequency
- `freetext`: Faker `paragraph()` with length matching observed sample distribution
- `numeric`: sampled from observed distribution (preserve mean, std dev, min, max)
- `timestamp`: random within observed range, ISO 8601
- `boolean`: random with observed frequency
- `reference`: synthesized ID pointing to a real entity in the same test bank
- `object`/`array`: recursive application of above rules

**Reference resolution:** generate parent entities first, then children with foreign references resolved to real parent IDs. For circular or deep references, generate in topological order; break cycles with placeholder IDs that resolve in a second pass.

**Golden record:** the record with the highest field population from the sampled data is preserved (with PII synthesized) as a "golden record." Used as a default for "test with realistic data" UX.

### 7.3 Phase 3 — Intent capture

This is the user-facing AI conversation. The riskiest UX in the product. The thing that decides whether Solder feels magical or feels like every other AI integration tool.

**Two-pass design:**

**Pass 1 — silent hypothesis (no user interaction):**

Before asking the user anything, the agent reads:

- Source API schema (already discovered or fetched fresh)
- Target API schema
- User's free-text description of what they want

Agent produces a hypothesis: "Here is what I think you want, expressed as a list of source endpoints, target endpoints, and a high-level mapping intent." This is internal. The user does not see this raw output.

**Pass 2 — visible interrogation:**

Agent presents the hypothesis as a structured summary, then asks ONLY the questions whose answers it cannot infer from the schemas. Banned question types:

- "What kind of data are you syncing?" (the user already told you)
- "Which fields do you want to map?" (you have the schemas; ask about specific ambiguities)
- Open-ended "anything else?" prompts

Allowed question types:

- "I see two endpoints that could be the source — `/purchase_orders` and `/orders`. Which one?"
- "The `status` field has values `draft, submitted, approved, rejected`. Are you syncing all statuses or filtering?"
- "I see no obvious target field for `internal_notes`. Should we drop it, or should it map somewhere I'm missing?"

**Agent prompt skeleton:**

```
You are helping a user define an integration between two APIs.

Source API: {api_name_source} — schemas and endpoints provided
Target API: {api_name_target} — schemas and endpoints provided
User description: "{user_freetext}"

Step 1 (silent): Form a hypothesis of what the user wants. Identify:
- Which source endpoints are in scope
- Which target endpoints are in scope
- High-level direction (one-way? bidirectional? batch? per-record?)
- Any obvious filters implied by the description
- Any ambiguities you cannot resolve from the schemas alone

Step 2 (output): Return a structured response with:
- summary: one paragraph restating what you understand the user wants
- in_scope_source_endpoints: [...]
- in_scope_target_endpoints: [...]
- inferred_filters: [...]
- questions: [...]

Rules for questions:
- Never ask anything answerable from the schemas
- Maximum 5 questions
- Each question must be specific, naming actual fields or endpoints
- If you have no genuine ambiguity, return an empty questions list
```

**UI behavior:**

- User sees the summary and any questions in a chat-style panel
- Inferred decisions (in-scope endpoints, filters) are presented as cards with edit buttons — user can click to override
- Questions are asked one at a time with quick-action buttons where possible (radio for "all/some/none", multi-select for endpoint lists)
- User can return to intent capture later and edit; downstream phases regenerate

### 7.4 Phase 4 — Mapping

**Input:** confirmed intent, source + target test banks (now exist)
**Output:** proposed mapping document, user confirms or overrides

**Algorithm:**

1. For each in-scope source endpoint, identify the corresponding target endpoint(s) from the intent
2. For each (source_field, target_field) pair, compute a similarity score using:
   - Field name similarity (semantic, via Claude embedding or heuristic)
   - Type compatibility
   - Value set overlap (for enums)
   - Format compatibility (for IDs, timestamps)
3. Greedy match: highest-scoring pairs first, with one-to-one constraint by default
4. For unmatched target fields with high `required` confidence, flag for user attention
5. Submit to Claude (opus-4-7) with the candidate mapping for review and refinement

**Output format:**

```json
{
  "mappings": [
    {
      "source_field": "purchase_order.vendor_name",
      "target_field": "po.supplier",
      "confidence": 0.92,
      "rationale": "Field names semantically match; both are pii_name with overlapping value patterns",
      "transform": "identity",
      "user_confirmed": false
    }
  ],
  "unmapped_target_required": [
    {"field": "po.cost_center", "rationale": "Required field with no obvious source"}
  ],
  "unmapped_source": [
    {"field": "purchase_order.internal_notes", "rationale": "No corresponding target field"}
  ]
}
```

**UI:** existing PropertiesPanel pattern, but a new dedicated `MappingEditor` view. Two columns (source / target), connecting lines, confidence chips per mapping (`.chip-info` for low confidence, `.chip-success` for high), an "AI suggested" badge that turns into "user confirmed" once edited.

For v1, the only `transform` value is `identity`. Transformation logic (concat, lookup, conditional) is v2.

### 7.5 Phase 5 — Test execution support

This phase isn't a single agent call; it's the agent assistance that runs during testing.

When a user clicks "Test this node":

1. If upstream nodes have run, use their last test outputs as input to this node
2. If no upstream output exists, agent synthesizes plausible input by:
   - Reading the node's expected input shape from the integration definition
   - Pulling matching records from the test bank
   - Either using the golden record (default) or random samples (user choice)
3. Node executes against the mock-engine
4. Output is captured and made available to downstream nodes

When a test fails (mock returned an error from the corpus):

- Agent surfaces the error with explanation: "This is a real error Zip returns when vendor_id is invalid. Your integration sent vendor_id `xyz` which doesn't exist in the test bank. To fix: ..."
- This is where the curated error corpus pays off — the agent has rich context about why each error fires

---

## 8. UX specifications

### 8.1 Setup → Builder flow

The current builder assumes an integration already exists. v1 adds a creation flow:

1. User clicks "New Integration" on Integrations page
2. Modal: pick source connector, target connector
3. Modal: provide credentials (or pick existing) for each
4. Land on Builder with a new empty integration in "intent" state
5. Builder shows the intent capture panel front and center, canvas dimmed
6. Once intent is confirmed, discovery + synthesis run in the background (progress visible)
7. Once test banks are ready, mapping suggestions appear, user confirms
8. Canvas activates; user can now build and test

The intent → discovery → mapping pre-flight should feel like a guided setup, not a wizard. Use the existing PageHeader pattern with a step indicator (`eyebrow`-styled, not numbered "01/02/03" wizard cruft).

### 8.2 Environment selector

Top-right of the canvas, always visible. Two states:

- **Sandbox** (default): muted teal pill, no warning
- **Production**: amber-bordered pill, "PROD" eyebrow text inside

Clicking opens a dropdown with:

- Toggle between sandbox/production
- Per-node override list (any nodes currently overridden show here with reset button)
- "Read from prod, write to mock" intermediate option (toggleable)

Switching from sandbox → production triggers a confirmation modal naming the integration, the credentials, and what will run. No cancel-by-accident.

Every run is tagged with environment; run history shows the tag.

**Per-node override:** in the PropertiesPanel for a node, a small toggle: "Run this node against [Sandbox | Production]." Defaults to whatever the integration-level setting is. When overridden, the node shows a small badge in the canvas.

**Read/write asymmetry:** when "Read from prod, write to mock" is on, the mock-engine routes change behavior. GET/HEAD requests pass through to the real API; POST/PUT/PATCH/DELETE go to the mock. This requires the mock-engine to support a passthrough mode for specific methods.

### 8.3 Per-node testing

Right-click on a node, or button in PropertiesPanel: "Test this node."

What the user sees:

1. A dialog asking how to provide input to this node:
   - **Use upstream output** (only available if upstream node has run; default if available)
   - **Use golden record from test bank** (synthesizes the most-realistic-shaped input)
   - **Use random sample** (1, 5, or all from test bank)
   - **Hardcoded values** (user-provided JSON)
2. User picks, clicks "Run"
3. Node runs against mock-engine
4. Output appears in PropertiesPanel under "Last test output," available as upstream input to downstream nodes

This is where the test bank earns its keep. The user can test any node without having to manually craft realistic input. They can also test "what would this look like if upstream ran" by picking golden record without ever running upstream.

### 8.4 Mapping editor

Replaces the current generic PropertiesPanel for `transform.map` nodes. Two-column layout:

- Left column: source schema (collapsible tree)
- Right column: target schema (collapsible tree)
- Connecting lines drawn between mapped fields
- Confidence chip per line
- Hover on a field shows sample values from the test bank
- Drag to manually create a mapping; click line to edit / delete

Bottom section: "Unmapped" warnings — required target fields with no source, source fields not used. User can dismiss with reasoning.

### 8.5 Run drawer (extends existing)

Already exists per handoff doc. Adds:

- Environment indicator at the top of the drawer (Sandbox / Production)
- Mock session controls (reset session, persist session)
- Per-step audit access — click a step, see the actual HTTP request and response that hit the mock-engine
- If an error was injected, show the corpus entry that fired and why

### 8.6 Errors during testing

When a mock error fires, the run drawer shows it with structure:

```
✖ Step 3 — Create Purchase Order
  ZIP API Error: INVALID_REFERENCE
  "Vendor with id 'unknown_vendor' not found"

  This is a real error Zip returns when vendor_id is invalid.
  Your request: vendor_id = "unknown_vendor"
  In your test bank: 50 vendors, ids start with "v_"

  ▸ Suggested fix: ensure the vendor lookup step runs before this node, or
    use a hardcoded vendor_id from the test bank.
  ▸ View test bank vendors
  ▸ View full request/response
```

This is generated from the corpus entry's metadata + a small Claude call (sonnet-4-6) that adds context-specific explanation. This is the only LLM-in-runtime call in v1, and it fires only on errors, not on successful responses.

---

## 9. Connectors

### 9.1 Zip (both sides for dev)

Source endpoints required for v1 dev:

- `GET /v1/purchase_orders` (list)
- `GET /v1/purchase_orders/{id}` (detail)
- `POST /v1/purchase_orders` (create)
- `GET /v1/vendors` (list)
- `GET /v1/users` (list)

Adjust based on actual Zip API surface; this is illustrative.

Auth: bearer token (whatever Zip uses). Stored in `credential` table, encrypted at rest.

### 9.2 Second connector — required before v1 ships

Zip-to-Zip is fine for development but is not a credible demo. v1 is not "shippable" until a second real connector exists. Recommended candidates, ranked:

1. **HubSpot** — has CRM objects (contacts, deals, companies), pairs naturally with Zip's procurement domain (vendors → companies, POs → deals), has a free tier with API access, OpenAPI spec exists
2. **Linear** — clean REST API, GraphQL also available, OpenAPI spec, free tier, but the domain (issues) is awkwardly far from procurement for the demo
3. **Airtable** — universal-shaped data, good for schema demonstration, but feels less "real integration" in a demo

**Picked:** HubSpot. Build it second.

**Workday SOAP is explicitly not v1.** Yes, Dan can do it in his sleep. But SOAP/WSDL parsing complexity will pull focus from the synthetic data and error corpus work. v1 proves the architecture on REST. v2 brings Workday SOAP in as a moat-deepener once everything else is solid.

### 9.3 Connector contract

Adding a new connector requires:

- A connector definition (name, type, auth scheme, base URL pattern)
- An error corpus JSON file at `backend/app/mock_engine/error_corpora/{name}.json`
- Optional: a hand-curated `business_rules` file for the mock-engine (see Section 10 for North Star)
- Test fixtures showing example requests/responses for unit tests

Document the contract at `backend/app/connectors/CONNECTOR_GUIDE.md` so future connectors can be added without re-deriving the pattern.

---

## 10. Roadmap (v2, v3, North Star)

### v2

- **Workday SOAP connector.** Dan's domain expertise turned into a moat. WSDL parsing, SOAP envelope generation, ISU auth.
- **Transformation logic in mappings.** Concat, split, lookup, conditional, simple expression language. Existing PropertiesPanel edits split into per-kind editors per the handoff doc backlog.
- **Webhook + schedule triggers** wired for real (currently cosmetic).
- **OpenAPI spec ingestion.** "Paste an OpenAPI URL" → auto-generates connector definition + initial mock spec + initial error corpus draft. This is the *first* slice of the eventual docs-crawler vision, scoped tightly to a structured input format.
- **Bidirectional integrations** with conflict resolution.
- **Better debugging tools.** Request diffing, replay against new mock state, compare prod vs. mock response shapes.

### v3

- **Web crawler / docs ingestion** for unstructured docs (HTML, PDF). LLM-driven extraction of endpoints, schemas, error codes from API documentation pages.
- **Agent deep-dive sessions** — see North Star below. The first version of this lands here: a guided agent session where the user spends 30–60 minutes "teaching" the system about a new API, producing curated business rules and an enriched error corpus.
- **Cross-tenant connector marketplace.** Users can publish connectors they've built; others can install. Privacy-scrubbed by design.

### North Star: agent-curated mock specs that compound

The long-term moat. Today, mock specs are generated from sampling. Tomorrow, they're enriched by agents that read API docs, run exploratory calls, and learn business rules.

Architectural implications for v1 to not paint into a corner:

- Mock spec format must be **versioned and additive**. Every field has a `source` annotation: `discovered`, `agent_curated`, `user_authored`, `static_corpus`. New layers can be merged without rewriting earlier ones.
- Business rules section is scaffolded in the mock spec from v1, even though empty. Rules format: a list of `{trigger, effect}` pairs evaluated during request handling.
- Error corpus is structured, not freeform. New errors can be appended; existing entries can be tagged with provenance.
- Mock engine architecture is **interpretive** — it executes the spec at runtime. Never compile a mock to a static service. Every spec evolution is a database update, not a deploy.

If we get this right, every API a user touches gets *better* over time as agents learn it. Workato has a connector team. Solder has a learning system.

---

## 11. Conventions and non-negotiables

These are inherited from the handoff doc and extended for v1. Treat them as load-bearing.

### From the existing codebase (preserve)

- Default to no comments. Use them only when "why" is non-obvious. Never narrate "what."
- Eyebrow text uses `.eyebrow` class, not inline styles.
- Status pills use `.chip` + tone modifier.
- Container nodes never expand inline; step-into is the only path into a body.
- `prepareDiveIn(cardEl)` must be called before `onStepInto` in the same React tick.
- Focus path lives in the Zustand store, not lifted into Canvas.
- DnD MIME types: `application/x-solder-existing` (move) and `application/x-solder-new` (palette).
- `data-testid` patterns: `node-{kind}-{action}`, `palette-{kind}-{action}`.

### Added for v1

- **No LLM in the request path.** Mock-engine responses do not call Claude. Period. The only runtime LLM call is the error-explanation augmentation in Section 8.6.
- **PII never reaches the LLM unmasked.** Discovery's classification uses field names primarily; sample values are masked for any field whose name suggests sensitivity, even before classification.
- **Every agent call uses structured output / tool use.** No `text.find("{")` parsing. Replace existing instances during the v1 build.
- **AI proposes, user confirms.** No autonomous integration creation. Every agent output is reviewable and overrideable in UI.
- **Mock spec is the source of truth.** Don't sprinkle mock behavior across services. Everything routes through the mock-engine reading from the spec.
- **Environment is always visible.** No screen where a user might forget whether they're in sandbox or production.
- **Test bank is read-mostly.** Writes go through mock_session. Never mutate test_bank_entity during a run.

### File and module layout (additions to existing structure)

```
backend/
  app/
    mock_engine/
      __init__.py
      router.py                 # FastAPI routes for /mock/{integration_id}/...
      spec_loader.py            # loads mock_spec from DB
      request_validator.py
      response_generator.py
      session_manager.py        # session_state CRUD
      error_injector.py         # consults error_corpus, decides when to fire
      error_corpora/
        zip.json
        hubspot.json            # added with second connector
    agents/
      discovery.py              # phase 1
      synthesizer.py            # phase 2 (no LLM)
      intent.py                 # phase 3
      mapper.py                 # phase 4
      test_supporter.py         # phase 5
      prompts/                  # extracted prompt templates
    connectors/
      base.py
      zip.py
      hubspot.py                # second connector
      CONNECTOR_GUIDE.md

frontend/
  src/
    pages/
      IntegrationCreate.tsx     # new — replaces or extends existing
    components/
      builder/
        IntentPanel.tsx         # new — phase 3 conversation UI
        MappingEditor.tsx       # new — phase 4 mapping UI
        EnvironmentSelector.tsx # new — section 8.2
        TestNodeDialog.tsx      # new — section 8.3
        MockSessionControls.tsx # new — section 8.5 additions
      editors/
        http.tsx                # PropertiesPanel split per backlog
        transform.tsx
        branch.tsx
        loop.tsx
        process.tsx
        output.tsx
```

---

## 12. Open questions

Real ones. Not "we'll figure it out" — questions that need a call before they harden in code.

1. **Credential storage at rest.** v1 is single-user local. Encrypted with what key? Env var KMS-style? Or just rely on filesystem permissions? Easiest answer: a per-user encryption key stored at `~/.solder/key` with mode 0600, encrypt credentials with it. Revisit when multi-user lands.

2. **Mock-engine port.** Currently the backend serves at `:8000`. Mock requests routing through `/mock/...` is fine, but it means every node's HTTP client needs to know to swap base URLs at runtime. Confirm this is the cleanest place vs. running the mock-engine on a separate port (`:8001`).

3. **How does discovery handle write endpoints we don't want to call?** POST endpoints on the source side shouldn't be exercised during discovery — we'd be creating real records in the user's prod system. Discovery must be GET-only by default. But how does it then build a mock spec for POST routes? Best answer: discover GET routes from sampling, infer POST/PUT/DELETE routes from API docs (paste docs URL during setup) or skip them entirely in v1 with a manual "add POST route" affordance.

4. **Synthetic data refresh cadence.** Test banks go stale. If the source API adds a new field, the test bank doesn't know. Need a "refresh test bank" affordance and probably a drift detection that flags when the live schema differs from what's in the test bank. Defer mechanism details, but commit to having a refresh button in v1 UI.

5. **Container labels** (from existing backlog) — needs UX call. Where does the optional 1-line label render on Loop / Branch / Call-Subprocess nodes? Above the catalog name? Replacing it? Recommend: replaces "Loop" / "Branch" as the title when set, falls back to catalog name when empty.

6. **The webhook/schedule trigger pills.** Hide them in v1 UI, or leave them visible but disabled with a tooltip "v2"? Recommend: hide entirely. Visible-but-disabled features look like the product is broken.

---

## 13. Definition of done for v1

v1 ships when a new user can:

1. Connect Zip credentials and HubSpot credentials
2. Create a new integration "sync Zip vendors to HubSpot companies"
3. Watch the AI describe what it understood and confirm the scope in <2 minutes
4. See the test bank populate with realistic synthetic data
5. Confirm AI-suggested mappings (or override) in <2 minutes
6. Build the integration in the canvas, hitting mocks during construction
7. Trigger a node-level test and see it succeed
8. Trigger a chaos-mode error and see a real Zip error fire, with explanation
9. Switch the integration to production and run it against real APIs successfully
10. Have done all of the above without writing a single line of code

The 90-second demo: from "new integration" to "successful sandbox run" in under 2 minutes. If we can hit that demo, v1 is done.

---

## Appendix A: Glossary

- **Mock-engine** — the FastAPI service that responds to HTTP requests as if it were the real API
- **Mock spec** — the per-integration configuration loaded by the mock-engine
- **Test bank** — the synthetic record store mirroring the source/target API's data
- **Session state** — the writable overlay over the test bank for a single run
- **Error corpus** — hand-curated JSON of realistic API errors per supported API
- **Golden record** — the most-populated record observed during sampling, preserved (synthesized) as a default test input
- **Discovery** — the phase that pulls samples and classifies fields
- **Synthesis** — the phase that generates synthetic test bank records (no LLM)
- **Intent capture** — the AI-assisted conversation defining integration scope

## Appendix B: Decisions explicitly made and why

| Decision | Why |
|---|---|
| Postgres JSONB for test bank, not SQLite per integration | Simpler ops, no file lifecycle, fast random sampling |
| Single mock-engine, not server-per-integration | Adding clients = data, not deploys |
| Static error corpus, no runtime LLM | Determinism, latency, cost |
| Two-pass intent capture | Grounded questions feel magical; ungrounded feel like every other AI builder |
| Stateful sessions over test bank | Required for create→read flows; reset boundary keeps the bank clean |
| HubSpot as second connector, not Workday SOAP | Prove architecture on REST first; SOAP becomes v2 moat |
| AI proposes, user confirms (every phase) | Autonomous = liability for enterprise data work |
| Adaptive sampling with field-coverage stop | Coherent strategy beats stacked thresholds |
| Mock spec versioned + additive from v1 | North Star requires it; cheap to do now, expensive to retrofit |
| LLM augments error explanations only | The only runtime LLM call; only fires on errors; small payload |

## Appendix C: What we're not committing to

For honesty: things that sound like they belong in this spec but don't, with reasoning.

- **Connector marketplace.** Premature. Build a couple connectors first and see what the contract should be in practice.
- **Multi-user auth.** v1 is local single-user. Auth choices for multi-user (Auth0? Clerk? Roll-your-own?) deserve their own design doc.
- **Billing.** Same as above. Free / paid tier discussion is out of scope.
- **Data residency / regional deployment.** Same.
- **SSO, RBAC, audit logging for compliance.** All real concerns for the eventual buyer; none of them belong in v1.
- **Cross-integration analytics.** "Show me which of my 47 integrations failed last week" — fine product surface, but you have one integration in v1.
- **Template library.** Without users, templates are speculation about what people will want. Wait for evidence.

---

*End of spec. Next: implementation. Section 5 (Architecture) and Section 7 (Agent System) are the hottest paths. Start there.*