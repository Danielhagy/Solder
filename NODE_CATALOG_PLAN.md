# Solder — Node Catalog Project Plan

**Owner:** node-catalog agent (Opus 4.7 1M)
**Authored:** 2026-04-26
**Status:** Plan / brainstorm. Implementation tiers below.
**Reference docs:** `FullSpec.md` (product), `HANDOFF.md` (live coordination),
`frontend/src/catalog.ts` (current catalog), `frontend/src/stores/integration.ts`
(node store).

This document is the project plan for expanding Solder's node catalog from
the current 6 nodes (`http.request`, `transform.map`, `logic.branch`,
`logic.loop`, `process.call`, `output.passthrough`) to a complete v1+v2
catalog. It defines:

1. The **design principles** that constrain every node.
2. The canonical **attribute schema** every node carries.
3. The **interaction model** — how nodes pass data, fail, get gated, branch,
   and route through the mock-engine in sandbox.
4. The **catalog organization** — sidebar groups + ordering.
5. The **brainstorm** — every proposed node, by group.
6. **Implementation tiers** — v1 must-have, v1 nice-to-have, v2, deferred.
7. The **editor file plan** — `frontend/src/components/builder/editors/`.
8. **Backend execution plan** — runtime evaluation per kind.
9. **Test bank / mock-engine integration** — sandbox semantics per node.
10. **Open questions** for the user.

Everything here is opinionated. Where it says "build X," do X unless you
have a specific reason not to and can articulate it.

---

## 1. Design principles

These shape every node decision.

### 1.1 The user is technical-but-not-developer
Per FullSpec §2: integration consultants, solutions engineers, IT analysts
who can read JSON, understand HTTP, and write a JSONPath with effort. They
don't write Python. **Nodes that require code must justify themselves
against a config-driven equivalent.** A `python.script` node exists, but
80% of jobs should be doable without it.

### 1.2 AI proposes, user confirms
Per FullSpec §11. No node executes a side-effect that the user can't review
first. The agent system maps source-to-target fields, suggests transforms,
and proposes mock specs — but every output is overrideable in UI.

### 1.3 Sandbox parity, not sandbox lookalike
Every node has the **same configuration shape** in sandbox and production.
The only thing that changes is *where bytes go*. `http.request` to
`https://api.zip.co/v1/purchase_orders` in sandbox is rewritten to
`http://localhost:8000/mock/{integration_id}/source/v1/purchase_orders` per
FullSpec §5.1; the user sees the same URL in the editor.

### 1.4 No LLM in the request path
Per FullSpec §11. AI nodes (`ai.prompt`, etc.) are explicit; the rest never
call an LLM at run time. Field mapping suggestions, intent capture, error
explanation are all named, surfaceable agent calls — not hidden runtime
magic.

### 1.5 Containers are quiet
Per existing canvas conventions: container nodes (Branch / Loop / Call
Subprocess) never expand inline. New container nodes (Try/Catch, Parallel,
Switch) inherit the same step-into discipline.

### 1.6 One axis of categorisation, not five
Catalog already collapsed per-vendor color into a 2-tone palette (leaf vs
container). New nodes inherit that. Group label distinguishes domain
(HTTP / Data / Format / Logic / Code / Storage / AI / Connectors / Trigger /
Output). Visual signal is reserved for run state, not category decoration.

### 1.7 Reuse before reinvention
If a job is doable with `transform.map` + JSONata, don't add a dedicated
node. Cheap nodes pay rent in catalog noise and editor surface area.
Threshold for inclusion: the node either (a) saves the user from writing
an expression they couldn't reasonably write themselves, or (b) wraps a
side-effect that needs its own config UI.

---

## 2. Node attribute schema (canonical)

Every catalog entry carries these fields. Fields that diverge from
`CatalogEntry` in `frontend/src/catalog.ts` today are marked **NEW** —
they need to be added to the type.

```ts
interface CatalogEntry {
  // === identity ===
  kind: string;          // top-level family ("http", "data", "format", ...)
  action: string;        // specific operation ("request", "json_to_csv", ...)
  group: NodeGroup;      // sidebar group
  label: string;         // sidebar + card display name
  description: string;   // one-line, shown in palette + tooltip
  icon: string;          // single glyph (preferred) or 2-char short
  chip: string;          // CHIP_LEAF | CHIP_CONTAINER | CHIP_AI (NEW)
  accent: string;        // border-left color class

  // === data shape ===
  defaultConfig: Record<string, unknown>;
  preview: (config: Record<string, unknown>) => string;

  // === container semantics (existing) ===
  containerBranches?: Array<{ key: string; label: string }>;

  // === NEW: contract metadata ===
  inputs?: NodeInputSpec[];          // named inputs (default: one upstream `$`)
  outputShape?: 'passthrough'        // emits exactly the input shape
              | 'transform'          // user-controlled shape
              | 'array'              // emits an array
              | 'object'             // emits an object
              | 'scalar'             // emits a single value (string/number/bool)
              | 'side-effect'        // input passes through, side-effect happens
              | 'error';             // emits an error envelope (catch arms)

  errorModes?: string[];             // declared error names a Try/Catch can catch
  sandboxBehavior?: SandboxPolicy;   // how this node behaves in sandbox
  requiresCredentials?: boolean;     // gated by credential picker
  requiresConnector?: string | null; // credential type id (e.g. "zip", "hubspot")
  agentAssist?: AgentAssistSpec;     // optional AI-suggested-config
  category?: 'leaf' | 'container' | 'trigger' | 'output' | 'ai';
  tier: 1 | 2 | 3;                   // implementation order (see §6)
}

type NodeInputSpec = {
  name: string;        // "data" | "items" | "config" — `$` means default
  shape?: string;      // optional JSON Schema reference
  required?: boolean;
};

type SandboxPolicy =
  | 'route-to-mock'    // calls go to mock-engine; default for connectors and HTTP
  | 'no-op'            // node does nothing in sandbox (sleeps, real-time clocks)
  | 'simulate'         // node runs a fast simulation (rate-limit, throttle)
  | 'identical';       // pure compute — same in both modes

type AgentAssistSpec = {
  // What the intent / mapping agent can pre-fill on this node.
  fields: string[];                         // config keys the agent populates
  fromContext: 'mapping' | 'intent' | 'discovery';
};
```

**Why each new field exists:**

- `inputs` — currently every node implicitly takes one upstream output. Not
  enough for nodes like Merge (takes two upstreams) or Parallel-fanout
  (returns an object keyed by branch name).
- `outputShape` — the run plan + properties panel render differently based
  on what comes out. Makes the canvas readable without reading config.
- `errorModes` — a future Try/Catch container needs to know what errors are
  catchable per node kind.
- `sandboxBehavior` — the mock-engine integration is invisible today; making
  it explicit per node prevents silent surprises.
- `requiresCredentials` / `requiresConnector` — drives the creation modal
  and per-node credential picker.
- `agentAssist` — the intent and mapping agents already exist
  (`backend/app/agents/`). Declaring which fields they can pre-fill makes
  AI proposals legible per node.
- `category` — replaces the implicit `containerBranches?` flag with a
  proper taxonomy that includes triggers and AI nodes.
- `tier` — drives implementation order; lets the palette filter to
  "v1-ready" while v2 nodes stay hidden behind a flag.

---

## 3. Interaction model

### 3.1 Data flow
- The default convention is **one upstream output → one downstream input**.
  `$` resolves to the upstream node's output. Multi-input nodes
  (Merge, Join) declare named `inputs`.
- **Explicit references**: `$.steps.<node-id>.output` resolves to any
  earlier node's output anywhere in scope. The agent system pre-fills
  references when proposing transforms; users can override.
- **Variable scope**: `$.vars.<name>` reads from `IntegrationConfig.variables`
  (already on the store). `state.set` writes to it. Variables are
  integration-wide and persist across nodes for one run.
- **Run scope**: `$.run.id`, `$.run.environment`, `$.run.started_at`,
  `$.run.input` — read-only metadata available everywhere.

### 3.2 Branches and loops
Existing model is correct — preserve it.
- Branch: `branches.true[]`, `branches.false[]`. Outputs from the taken
  arm flow through; the other is skipped. The Branch node itself has no
  output — it's a router. (TODO: should it emit `$.taken_branch` for
  observability? Open question.)
- Loop: `branches.body[]`. `$item` and `$index` are bound per iteration.
  Reduce mode (already shipped: `collect | last | count | none`) controls
  what the loop emits downstream.
- New container: **Switch** — N+1 named branches, expression evaluated
  once, matching branch executes. `branches: { case_<n>: [], default: [] }`.
- New container: **Try / Catch** — `branches: { try: [], catch: [] }`.
  Errors thrown anywhere in `try` flow into `catch` with `$.error`
  bound. `errorModes` on each child node defines what's catchable.
- New container: **Parallel-fanout** — `branches: { <named-arm>: [] }`
  for static fanout. Output is `{ <arm>: <output> }`. Differs from
  stage-parallelism (which is implicit topology).

### 3.3 Conditional execution gate (`when`)
Already on the node model. Any node can have `when: <jsonpath>`. If false,
the node is skipped and its input passes through unchanged. Useful for
"only call this API when X." We document it as a global feature, not a
separate node.

### 3.4 Subprocess call
Existing. `process.call` invokes a saved integration with mode `once` or
`for-each`. Inputs map caller scope to subprocess scope; subprocess output
returns to caller. Already supports `$.items` for-each iteration. Outputs
are subject to the same reduce semantics as Loop in `for-each` mode
(today: implicit `collect`; should be made explicit — see §10 Q3).

### 3.5 Sandbox vs production
Per FullSpec §5.1 and §8.2.
- **Connector / HTTP nodes**: in sandbox, base URL is rewritten to the
  mock-engine path; in production, it goes to the real API. The
  configuration in the editor is identical.
- **State / storage nodes**: in sandbox, writes go to the run-scoped
  mock_session; in production, writes go to real persistence (Postgres
  KV, Redis, etc.). Reads merge.
- **AI nodes**: in sandbox, optionally route to a stub that returns a
  recorded fixture instead of paying the LLM round-trip cost. (See open
  question §10 Q5.)
- **Time nodes (Sleep, Wait until)**: in sandbox, become no-ops or
  simulate. Real `Sleep(60s)` during testing burns iteration time.
- **Math / format / pure-compute nodes**: identical in both modes.

The `sandboxBehavior` field on each catalog entry encodes this.

### 3.6 Error envelope
Errors from nodes are structured:
```json
{
  "error": {
    "kind": "http.4xx" | "validation" | "timeout" | "auth" | "user_error" | "system",
    "node_id": "...",
    "message": "...",
    "code": "...",            // optional API-specific error code
    "corpus_id": "...",       // if mock-engine fired a corpus error
    "retriable": true | false
  }
}
```
A Try/Catch arm receives this as `$.error`. A Retry node uses
`error.retriable` to decide.

### 3.7 Output node
`output.passthrough` is the integration's terminal node. The `mapping`
config picks fields from final scope into the integration's output shape.
Multiple integrations can share an output schema (the spec talks about
this for subprocesses returning structured data — see FullSpec §10
"Bidirectional integrations").

---

## 4. Catalog organization

The sidebar groups grow from **5 → 11**. Order matters — the user's eye
travels top-to-bottom, so the most-used groups go first.

| Order | Group | Rationale |
|---|---|---|
| 1 | **HTTP** | The most-used family. API Call, Webhook, GraphQL. |
| 2 | **Connectors** | Typed shortcuts to known APIs (Zip, HubSpot). Pre-configured `http.request` nodes with credentials + endpoint inferred. |
| 3 | **Data** | Map, Filter, Sort, Pick, Rename, Flatten — daily bread of integration work. |
| 4 | **Format** | JSON↔CSV, JSON↔XML, base64, JWT decode. Conversion utilities. |
| 5 | **Logic** | Branch, Loop, Switch, Try/Catch, Parallel. Containers. |
| 6 | **Code** | Python script, JS expression, JSONata. Last-resort escape hatches. |
| 7 | **Storage** | Set/Get variable, KV, counter, ULID gen. State across nodes. |
| 8 | **AI** | Claude prompt, classify, extract, summarise. Explicit LLM calls. |
| 9 | **Time** | Now, parse date, format date, sleep, schedule-aware. |
| 10 | **Process** | Call Subprocess. Stays its own group because it's a re-entry into another integration. |
| 11 | **Output** | The terminal node. Always present. |

**Triggers** are not a sidebar group — they're integration-level (the
`trigger` field on the integration config). The TriggerStrip already
handles them. A future Webhook-receive node could appear under HTTP if we
wire it as a node-level signal, but the integration-level trigger is the
primary surface.

---

## 5. The brainstorm — every proposed node

Format per row: `kind.action` · group · label · description · primary
config fields · sandbox behavior · tier.

Tier legend: **1** = ship in v1 alongside the agent system; **2** = post-v1
expansion; **3** = nice-to-have / long tail.

Existing nodes are marked ✅. Net-new nodes are marked ➕.

### 5.1 HTTP

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ✅ `http.request` | API Call | Make any HTTP request | `method, url, headers, body, pagination, auth_ref, timeout_ms, retries` | route-to-mock | 1 |
| ➕ `http.webhook_send` | Send Webhook | POST a payload to a URL with HMAC signature | `url, payload, secret_ref, sig_header` | route-to-mock | 2 |
| ➕ `http.graphql` | GraphQL | Run a GraphQL query/mutation | `endpoint, query, variables, auth_ref` | route-to-mock | 2 |
| ➕ `http.upload` | File Upload | multipart/form-data upload | `url, field_name, file_ref, headers` | route-to-mock | 2 |
| ➕ `http.download` | File Download | GET → bytes/file | `url, headers, save_as` | route-to-mock | 2 |

### 5.2 Connectors (typed pre-configured wrappers)

These are not separate node kinds — they're catalog entries that produce
a pre-configured `http.request` (or similar) with `requiresConnector` set.
The editor renders a higher-level form (no raw URL editing) but the
underlying node is still `http.request`. This keeps the catalog
extensible without bloating the runtime.

| ID | Label | Connector | Operation set | Tier |
|---|---|---|---|---|
| ➕ `connector.zip.list_purchase_orders` | Zip · List POs | zip | GET /v1/purchase_orders | 1 |
| ➕ `connector.zip.get_purchase_order` | Zip · Get PO | zip | GET /v1/purchase_orders/{id} | 1 |
| ➕ `connector.zip.create_purchase_order` | Zip · Create PO | zip | POST /v1/purchase_orders | 1 |
| ➕ `connector.zip.list_vendors` | Zip · List vendors | zip | GET /v1/vendors | 1 |
| ➕ `connector.hubspot.list_contacts` | HubSpot · List contacts | hubspot | GET /crm/v3/objects/contacts | 1 |
| ➕ `connector.hubspot.create_contact` | HubSpot · Create contact | hubspot | POST /crm/v3/objects/contacts | 1 |
| ➕ `connector.hubspot.list_companies` | HubSpot · List companies | hubspot | GET /crm/v3/objects/companies | 1 |
| ➕ `connector.hubspot.create_deal` | HubSpot · Create deal | hubspot | POST /crm/v3/objects/deals | 1 |
| ➕ `connector.workday.*` | Workday · ... | workday | (deferred per FullSpec §9.2) | 2 |
| ➕ `connector.<api>.*` | Catalog grows automatically | dynamic | discovered via OpenAPI ingestion | 3 |

**Catalog generation:** during connector setup, Solder reads the
connector's mock-spec routes (FullSpec §6.4) and generates a catalog
entry per route. New connectors don't require frontend changes — they
appear in the palette once their mock-spec lands.

### 5.3 Data (transform)

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ✅ `transform.map` | Transform | Map data with an expression | `expression` (JSONata) | identical | 1 |
| ➕ `data.filter` | Filter | Keep array items matching a predicate | `expression`, `over` | identical | 1 |
| ➕ `data.sort` | Sort | Sort an array | `over, by, order: asc\|desc` | identical | 1 |
| ➕ `data.unique` | Unique | Deduplicate by key | `over, by` | identical | 1 |
| ➕ `data.pick` | Pick fields | Whitelist fields from each item | `over, fields[]` | identical | 1 |
| ➕ `data.omit` | Omit fields | Drop fields from each item | `over, fields[]` | identical | 1 |
| ➕ `data.rename` | Rename | Rename fields per a mapping | `over, mapping: {from→to}` | identical | 1 |
| ➕ `data.flatten` | Flatten | Lift nested objects to dotted keys | `over, depth` | identical | 2 |
| ➕ `data.unflatten` | Unflatten | Inverse of flatten | `over, separator` | identical | 2 |
| ➕ `data.group_by` | Group by | Group array items by key | `over, by` | identical | 2 |
| ➕ `data.aggregate` | Aggregate | Sum / avg / min / max / count by group | `over, group_by, agg: sum\|avg\|min\|max\|count, on` | identical | 2 |
| ➕ `data.merge` | Merge | Combine two upstream outputs | `inputs: ["a","b"], strategy: shallow\|deep\|left-join` | identical | 2 |
| ➕ `data.join` | Join | SQL-style join two arrays | `left, right, on, mode: inner\|left\|outer` | identical | 2 |
| ➕ `data.template` | Template | Mustache/Handlebars template render | `template, context` | identical | 2 |
| ➕ `data.diff` | Diff | Structural diff of two objects | `a, b` | identical | 3 |
| ➕ `data.validate` | Validate | JSON Schema validation | `schema, on_invalid: error\|skip\|tag` | identical | 2 |

### 5.4 Format (conversion)

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ➕ `format.json_to_csv` | JSON → CSV | Array-of-objects → CSV | `over, columns?, header: bool, delimiter` | identical | 1 |
| ➕ `format.csv_to_json` | CSV → JSON | CSV → array of objects | `csv, has_header, delimiter, type_coerce: bool` | identical | 1 |
| ➕ `format.json_to_xml` | JSON → XML | Object → XML | `root_tag, pretty` | identical | 2 |
| ➕ `format.xml_to_json` | XML → JSON | XML → object | `attr_prefix, text_key` | identical | 2 |
| ➕ `format.json_to_yaml` | JSON → YAML | Pretty YAML emit | `data` | identical | 3 |
| ➕ `format.yaml_to_json` | YAML → JSON | YAML parse | `yaml` | identical | 3 |
| ➕ `format.base64_encode` | Base64 encode | Bytes/string → base64 | `data, url_safe: bool` | identical | 1 |
| ➕ `format.base64_decode` | Base64 decode | base64 → bytes/string | `data, as: string\|bytes` | identical | 1 |
| ➕ `format.url_encode` | URL encode | percent-escape | `data, component: bool` | identical | 1 |
| ➕ `format.url_decode` | URL decode | percent-unescape | `data` | identical | 1 |
| ➕ `format.hash` | Hash | md5 / sha1 / sha256 / sha512 | `data, algo, output: hex\|base64` | identical | 1 |
| ➕ `format.hmac` | HMAC | Keyed hash | `data, key_ref, algo, output: hex\|base64` | identical | 2 |
| ➕ `format.jwt_decode` | JWT decode | Decode header + payload (no verify) | `token` | identical | 2 |
| ➕ `format.jwt_sign` | JWT sign | Sign a payload | `payload, secret_ref, algo` | identical | 2 |
| ➕ `format.parse_excel` | Parse Excel | .xlsx / .xls → JSON | `file_ref, sheet, has_header` | identical | 3 |
| ➕ `format.parse_pdf` | Parse PDF | PDF → text/structured | `file_ref, ocr: bool` | identical | 3 |

### 5.5 Logic (containers + predicates)

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ✅ `logic.branch` | If / Else | Two-way conditional + optional declared variables | `expression, variables[]` | identical | 1 |
| ✅ `logic.loop` | Loop | Repeat for each item + optional named appends | `over, reduce, appends[]` | identical | 1 |
| ✅ `logic.switch` | Switch | N-way branch with dynamic cases + default + variables | `cases: [{key, match, label}], variables[]` | identical | 1 |
| ➕ `logic.try_catch` | Try / Catch | Catch errors from a sub-chain | `(no config)` — branches: try, catch | identical | 2 |
| ➕ `logic.parallel` | Parallel | Static N-way fanout | `branches: [{key, label}]`; output `{<key>: <out>}` | identical | 2 |
| ➕ `logic.assert` | Assert | Stop run if predicate is false | `expression, message` | identical | 2 |
| ➕ `logic.gate` | Gate | Pass-through or stop based on predicate | `expression, on_false: skip\|stop` | identical | 2 |
| ➕ `logic.merge` | Merge join | Wait for N upstreams, emit combined | `(no config beyond inputs)` | identical | 3 |

#### If/Else & Switch variables

Both `logic.branch` and `logic.switch` carry a `variables[]` config — a
declaration of named values that nodes inside the branch arms populate
during execution and downstream nodes consume after the branch
completes. Each entry is `{ name, description?, default? }`. The
runtime contract (backend-pending):

- `default` resolves when no arm sets the variable, or when a
  downstream reference fires before the branch executes.
- Variables are scoped to the parent scope of the branch — a
  downstream `transform.map` references them as `$.<name>`.
- The intent agent can pre-fill the declarations from the integration
  brief (e.g. "if order is over $1k, set `tier = 'priority'`").

#### Loop appends

`logic.loop` carries an `appends[]` array of `{ name, description? }`.
Inner steps append values per-iteration; the loop emits each named
list as a sibling of the `reduce` output. Lets a single loop emit
multiple parallel collections (e.g. `succeeded[]`, `failed[]`) without
a downstream split — the append name is the canonical reference
downstream.

Both concepts are runtime-pending — frontend stores the declarations,
no executor wires them yet. Backend wave for `logic.*` will land them
together with the switch evaluator.

### 5.6 Code (escape hatches)

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ➕ `code.python` | Python | Sandboxed Python script | `source, timeout_ms, allow_imports[]` | identical | 1 |
| ➕ `code.javascript` | JS expression | Single-expression JS | `expression, timeout_ms` | identical | 2 |
| ➕ `code.jsonata` | JSONata | JSONata expression | `expression` | identical | 2 |
| ➕ `code.jmespath` | JMESPath | JMESPath query | `expression` | identical | 2 |
| ➕ `code.shell` | Shell command | `bash -c` (host-side) | `command, args[], cwd` | no-op | 3 |

**Sandboxing for `code.python`**: hard guardrails — restricted builtins,
no network, no filesystem, CPU + memory limits, 30 s default timeout. The
sandbox is a separate process per invocation so a runaway can't stall
the workflow.

### 5.7 Storage (state)

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ➕ `state.set` | Set variable | Write to `$.vars.<name>` | `name, value` | identical | 1 |
| ➕ `state.get` | Get variable | Read from `$.vars.<name>` | `name, default` | identical | 1 |
| ➕ `state.kv_put` | KV put | Persistent KV write | `key, value, ttl` | route-to-mock (run-scoped writes go to mock_session) | 2 |
| ➕ `state.kv_get` | KV get | Persistent KV read | `key, default` | route-to-mock | 2 |
| ➕ `state.counter` | Counter | Increment / decrement | `name, delta, return: before\|after` | route-to-mock | 2 |
| ➕ `state.ulid` | ULID | Generate ULID | `prefix?` | identical | 1 |
| ➕ `state.uuid` | UUID | Generate UUID v4 | `(no config)` | identical | 1 |
| ➕ `state.random_int` | Random int | Random integer in range | `min, max, seed?` | identical | 1 |
| ➕ `state.random_float` | Random float | Random float in range | `min, max, seed?` | identical | 1 |

### 5.8 Math / numeric utilities

These could live under Data, but math is conceptually distinct enough
to deserve its own visual cluster. Decision: **fold into Data group** to
keep the sidebar at 11 groups rather than 12. Catalog still differentiates
with the `math.*` prefix.

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ➕ `math.calc` | Calc | Single expression, four-fn + parens | `expression` | identical | 1 |
| ➕ `math.round` | Round | Round / ceil / floor / truncate | `value, mode, places` | identical | 1 |
| ➕ `math.clamp` | Clamp | Constrain to range | `value, min, max` | identical | 2 |
| ➕ `math.percentile` | Percentile | nth percentile of array | `over, n` | identical | 2 |
| ➕ `math.units` | Convert units | Currency / weight / time conversions | `value, from, to` | identical | 3 |

### 5.9 String utilities

Folded into Data group; `str.*` prefix.

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ➕ `str.concat` | Concat | Join strings | `parts[], separator` | identical | 1 |
| ➕ `str.split` | Split | String → array | `value, separator, max?` | identical | 1 |
| ➕ `str.replace` | Replace | Regex find/replace | `value, pattern, replacement, all: bool` | identical | 1 |
| ➕ `str.trim` | Trim | Strip whitespace | `value, side: both\|start\|end, chars?` | identical | 1 |
| ➕ `str.case` | Case | upper / lower / title / camel / snake / kebab | `value, to` | identical | 1 |
| ➕ `str.slug` | Slugify | URL-safe slug | `value, separator` | identical | 2 |
| ➕ `str.format` | Format | printf-style template | `template, args[]` | identical | 2 |
| ➕ `str.regex_match` | Regex match | Test or extract groups | `value, pattern, mode: test\|capture\|all` | identical | 2 |

### 5.10 Time / date

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ➕ `time.now` | Now | Current timestamp | `format: iso\|unix\|unix_ms, tz` | identical | 1 |
| ➕ `time.parse` | Parse date | String → ISO | `value, formats[], assume_tz` | identical | 1 |
| ➕ `time.format` | Format date | ISO → string | `value, format, tz` | identical | 1 |
| ➕ `time.add` | Add duration | + N seconds/minutes/hours/days/months | `value, amount, unit` | identical | 1 |
| ➕ `time.diff` | Diff | Difference between two dates | `a, b, unit` | identical | 1 |
| ➕ `time.tz_convert` | Timezone convert | Translate between zones | `value, from_tz, to_tz` | identical | 2 |
| ➕ `time.sleep` | Sleep | Pause execution | `duration_ms` | no-op (dev: simulate) | 2 |
| ➕ `time.wait_until` | Wait until | Pause to a wall-clock time | `until, max_wait_ms` | no-op | 3 |
| ➕ `time.cron_match` | Cron match | Does N match a cron expression? | `value, cron` | identical | 3 |

### 5.11 AI

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ➕ `ai.prompt` | Claude prompt | Free-form text prompt → text | `model, system, user, max_tokens, structured?` | route-to-mock or live (see §10 Q5) | 2 |
| ➕ `ai.classify` | Classify | Pick one of N labels | `input, labels[], model` | same | 2 |
| ➕ `ai.extract` | Extract | Pull structured data per a schema | `input, schema, model` | same | 2 |
| ➕ `ai.summarise` | Summarise | Long text → short summary | `input, target_length, style, model` | same | 2 |
| ➕ `ai.embed` | Embed | Text → vector | `input, model` | same | 3 |
| ➕ `ai.translate` | Translate | One language → another | `input, target_language` | same | 3 |

**Per FullSpec §11**: AI nodes are explicit and labeled. The `model`
field defaults to `claude-sonnet-4-6` for high-volume operations
(classify, extract, embed) and `claude-opus-4-7` for reasoning-heavy
tasks (summarise with a complex style). Sandbox routing per §10 Q5.

### 5.12 Process

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ✅ `process.call` | Call Subprocess | Run a saved integration | `target_id, target_name, mode, over, inputs` | inherits sub | 1 |

### 5.13 Output

| ID | Label | Description | Config | Sandbox | Tier |
|---|---|---|---|---|---|
| ✅ `output.passthrough` | Output | Final output | `mapping` | identical | 1 |
| ➕ `output.return` | Return | Subprocess return value (renames passthrough when in a subprocess) | `mapping` | identical | 2 |
| ➕ `output.error` | Throw | Explicit error termination | `kind, message, retriable` | identical | 2 |

### 5.14 Trigger (integration-level — not in palette)

Configured on the integration itself via the TriggerStrip. Listed here
for completeness; these are not catalog entries the user drags onto the
canvas.

| ID | Description | Tier |
|---|---|---|
| `trigger.manual` | User clicks Run | 1 ✅ |
| `trigger.webhook` | Inbound HTTP webhook | 2 |
| `trigger.schedule` | Cron schedule | 2 |
| `trigger.event` | Internal event bus | 3 |

Per FullSpec §12 Q6 — webhook + schedule are cosmetic today. Open Q.

---

## 6. Implementation tiers

### Wave status

- ✅ **Wave 0 — schema migration shipped 2026-04-26.** All new fields live on `CatalogEntry`. Existing 6 entries backfilled. tsc + build clean.
- ✅ **Wave 1 — PropertiesPanel split shipped 2026-04-26.** Per-kind editors in `frontend/src/components/builder/editors/`. `KindEditor` dispatcher in `PropertiesPanel.tsx`. `editors/mapping.tsx` slot reserved for Step 4. Closes Tier-2 backlog item.
- ✅ **Wave 2-A — Data leaf nodes shipped 2026-04-26 (6/30 Tier-1 leaves done).** `data.filter`, `data.sort`, `data.unique`, `data.pick`, `data.omit`, `data.rename`. ⚠ Frontend-only — no backend runtime executors yet; integrations using these will fail at run time until the backend wave lands.
- ✅ **Wave 2-B — Format leaf nodes shipped 2026-04-26 (13/30 Tier-1 leaves done).** `format.json_to_csv`, `format.csv_to_json`, `format.base64_encode`, `format.base64_decode`, `format.url_encode`, `format.url_decode`, `format.hash`. **Promoted `Format` to a real `NodeGroup`.** Made `groupedCatalog()` + Sidebar's filter-record builder dynamic from `GROUPS` so future group additions are a one-line change. ⚠ Frontend-only.
- ✅ **Wave 2-C — Math + String utilities shipped 2026-04-26 (20/30 Tier-1 leaves done).** `math.calc`, `math.round`, `str.concat`, `str.split`, `str.replace`, `str.trim`, `str.case`. Folded into the `Data` sidebar group; distinct kinds (`math.*`, `str.*`) for runtime/dispatch hygiene. New `editors/math.tsx`, `editors/str.tsx`. ⚠ Frontend-only.
- ✅ **Logic split & variables/appends shipped 2026-04-26 (user-directed).** `logic.branch` relabelled to "If / Else" with `variables[]` declared on the action; new `logic.switch` (Tier-1 promoted from Tier-2) with dynamic `cases[]` (each `{key, match, label?}`) + always-present `default` arm + `variables[]`; `logic.loop` gains `appends[]` for named per-iteration accumulators. Catalog adds `resolveBranches(node)` so all consumers handle dynamic branch keys uniformly; `seedBranches` now accepts a config arg; new `applySwitchCases(id, cases)` store action keeps `config.cases` and `node.branches` atomic. New `editors/logic.tsx` rewrite covers all three actions + a shared `NamedListEditor` for the variables/appends UI. ⚠ Frontend-only — runtime evaluator (switch case eval, variables scope, loop append accumulator) is the next backend blocker for `logic.*`.
- ✅ **Wave 2-D — Time + State shipped 2026-04-26 (31/30+ Tier-1 leaves done — Tier-1 leaf catalog is now functionally complete on the frontend).** `state.{set,get,ulid,uuid,random_int,random_float}` and `time.{now,parse,format,add,diff}`. `State` and `Time` added to `NodeGroup` + `GROUPS`. New `editors/state.tsx`, `editors/time.tsx`. `state.set` declares `outputShape: 'side-effect'`. ⚠ Frontend-only.
- ✅ **Wave 3 — `code.python` shipped 2026-04-26 (frontend).** New `Code` group + `code.python` catalog entry + `editors/code.tsx`. Smoke 12/12 PASS. ⚠ Backend Python sandbox still pending — authoring works, runs don't.
- ✅ **Wave 6 — AI leaf nodes shipped 2026-04-26 (4 nodes).** `ai.prompt / classify / extract / summarise`. New `AI` group + `editors/ai.tsx`. `sandboxBehavior: 'route-to-mock'` (FullSpec §10 Q5 conservative default). Smoke 4/4 PASS. ⚠ Backend AI executors pending.
- ✅ **Wave 4 — Connector catalog shipped 2026-04-26 (6 ops).** New `Connectors` group + 6 typed entries (`zip.list_vendors`, `zip.list_purchase_orders`, `zip.list_users`, `hubspot.list_contacts`, `hubspot.list_companies`, `hubspot.list_deals`). New `editors/connector.tsx` with live `/api/connectors` + `/api/credentials` integration (select picker when creds exist, free-text fallback). All `tier: 1`, `category: 'leaf'`, `sandboxBehavior: 'route-to-mock'`, `requiresConnector` set. Smoke 6/6 PASS, end-to-end credential picker confirmed working.
- ✅ **Wave 5-A — `logic.assert` + `logic.gate` shipped 2026-04-26.** Tier-2 logic predicates that don't require new container plumbing.
- 🔲 **Wave 5-B — Tier-2 containers** (`logic.try_catch` + `logic.parallel`). Touches StagesGraph rendering — coordinate with whoever owns canvas before starting.
- 🔲 **Wave 7 — Tier-3 long tail** (opportunistic).

### Backend executor waves (frontend nodes that need runtime support)

The frontend catalog far outpaces the runtime. Backend waves catch up in dependency order — stdlib pure-compute first, then non-deterministic kinds (which need activities), then SDK-bound (AI / sandbox-Python).

- ✅ **Wave B-1 — pure-compute (data.* + format.*) shipped 2026-04-26 (13/~30 backend executors).** New `backend/app/runtime/pure.py`. Inline workflow dispatch (no activities). End-to-end verified through Temporal worker.
- ✅ **Wave B-2 — math.* + str.* shipped 2026-04-26 (20/~30 backend executors).** Extended `pure.py`. Safe math.calc (regex-substitute + whitelist + eval). End-to-end verified through Temporal worker.
- ✅ **Wave B-4 — logic predicates shipped 2026-04-26 (23/~30 backend executors).** `logic.{assert, gate, switch}`. New `_StopRun` sentinel for clean early-termination from `gate on_false='stop'`. Bonus fix to `evaluate_condition` so numeric RHS literals work everywhere.
- ✅ **Wave B-3 — non-deterministic ops shipped 2026-04-26 (34/~30+ backend executors — Tier-1+2 leaves now functionally complete on the backend save the connector wrappers).** `state.{set,get,ulid,uuid,random_int,random_float}` + `time.{now,parse,format,add,diff}`. Inline `self._vars` for run-scope variables; 5 new Temporal activities for the non-deterministic ops; 4 deterministic time functions in pure.py with stdlib-only month/year math. End-to-end verified through a 9-stage pipeline.
- ✅ **Wave B-7 — `code.python` subprocess sandbox shipped 2026-04-26 (35 backend executors).** `python -I` subprocess + JSON-piped bootstrap with import filter, builtins strip, stdout capture, wallclock timeout. 10/10 sandbox cases pass (incl. `timeout` kills runaway). End-to-end verified through Temporal worker. Single-user dev grade; v2 multi-user wants OS-level isolation behind the same activity seam.
- 🔈 **Wave B-5 — connector ops** (`zip.* + hubspot.*` — 6 ops). Translate to `http.request` with credential resolution + mock-engine routing. Backend has connectors + credentials API already (Slice 2); just need a wrapper.
- 🔲 **Wave B-6 — AI nodes** (`ai.{prompt,classify,extract,summarise}` — 4 ops). Needs Anthropic SDK + sandbox routing per FullSpec §10 Q5.
- 🔲 **Wave B-7 — `code.python` sandbox** (1 op, big). RestrictedPython or subprocess sandbox.

### Tier 1 — v1 must-have (~40 nodes)
The catalog the agent system needs to do the demo: discovery → synthesis
→ mapping → build → test → cutover (FullSpec §13). Specifically:

- All currently-shipped nodes (`http.request`, `transform.map`,
  `logic.branch`, `logic.loop`, `process.call`, `output.passthrough`).
- Core data: `data.filter`, `data.sort`, `data.unique`, `data.pick`,
  `data.omit`, `data.rename`.
- Core format: `format.json_to_csv`, `format.csv_to_json`,
  `format.base64_encode/decode`, `format.url_encode/decode`,
  `format.hash`.
- Math: `math.calc`, `math.round`.
- String: `str.concat`, `str.split`, `str.replace`, `str.trim`,
  `str.case`.
- Time: `time.now`, `time.parse`, `time.format`, `time.add`, `time.diff`.
- State: `state.set`, `state.get`, `state.ulid`, `state.uuid`,
  `state.random_int`, `state.random_float`.
- Code: `code.python` (with sandboxing).
- Connectors: full Zip + HubSpot operation set per §5.2 (~8 entries).

### Tier 2 — v1 nice-to-have / v2 launch (~20 nodes)
Adds the next 80% of integration jobs without writing Python:
- `data.flatten/unflatten/group_by/aggregate/merge/join/template/validate`
- `format.json_to_xml/xml_to_json/jwt_decode/jwt_sign/hmac`
- `logic.switch/try_catch/parallel/assert/gate`
- `code.javascript/jsonata/jmespath`
- `state.kv_put/kv_get/counter`
- `time.tz_convert/sleep`
- `math.clamp/percentile`
- `str.slug/format/regex_match`
- `ai.prompt/classify/extract/summarise`
- `output.return/output.error`

### Tier 3 — long tail / deferred
- `format.parse_excel/parse_pdf/yaml*`
- `data.diff`
- `logic.merge`
- `code.shell` (security-sensitive)
- `state` ops requiring real persistence beyond mock_session
- `time.wait_until/cron_match`
- `math.units`
- `ai.embed/translate`

---

## 7. Editor file plan

Per the existing Tier-2 backlog item in `HANDOFF.md`, `PropertiesPanel.tsx`
splits into per-kind editors. The split lands as:

```
frontend/src/components/builder/editors/
├── _shared.tsx          # field components: <ConfigField>, <ExpressionField>, <CredentialPicker>, <SchemaPreview>
├── http.tsx             # http.* (request, webhook_send, graphql, upload, download)
├── connector.tsx        # connector.<api>.<op> — derives form from connector spec
├── data.tsx             # data.* + transform.map
├── format.tsx           # format.*
├── logic.tsx            # logic.* (branch, loop, switch, try_catch, parallel, assert, gate)
├── code.tsx             # code.* with monaco-style code editor
├── state.tsx            # state.*
├── ai.tsx               # ai.*
├── time.tsx             # time.*
├── process.tsx          # process.call (subprocess picker + input mapping)
└── output.tsx           # output.*
```

`PropertiesPanel.tsx` becomes a thin dispatcher that imports from
`editors/<kind>` based on the selected node. Each editor exports a default
component `(props: { node: SolderNode }) => JSX.Element`.

**Coordination note**: this dovetails with Step 4 (`IntentPanel`,
`MappingEditor`) — the mapping editor specifically wants to live as
`editors/mapping.tsx` since it's a special case of `transform.map` with
two-column mapping UI. Owner: Step-4 agent. node-catalog agent owns
everything else under `editors/`.

---

## 8. Backend execution plan

The runtime evaluator lives in `backend/app/services/` (today) /
`backend/app/runtime/` (proposed split). For each node kind we need:

```python
# backend/app/runtime/nodes/<kind>.py
async def execute(node: SolderNode, scope: RunScope) -> NodeResult:
    """One-shot execution. Reads config + scope, returns output or error envelope."""
```

**Tier 1 implementations needed** (most are trivial):

| kind | Implementation note |
|---|---|
| `http.request` | exists; verify it routes to mock-engine in sandbox |
| `transform.map` | exists; uses JSONata |
| `logic.branch` | exists |
| `logic.loop` | exists; honour reduce mode |
| `process.call` | exists; resolves target_id, opens new run scope |
| `output.passthrough` | exists |
| `data.*` | thin wrappers over JSONata + array helpers |
| `format.*` | stdlib only (`csv`, `xml.etree`, `base64`, `urllib.parse`, `hashlib`, `hmac`, `pyjwt`) |
| `math.*` | stdlib + safe-eval for `math.calc` (no `eval()` — use `simpleeval` or pyparsing) |
| `str.*` | stdlib + `regex` |
| `time.*` | `datetime` + `dateutil` for parsing |
| `state.*` | reads/writes `IntegrationConfig.variables` (in-memory per run) |
| `code.python` | RestrictedPython or subprocess sandbox |

**Mock-engine integration**: `http.request` and any `connector.*` node
checks the integration's environment + per-node override. If sandbox,
swap the base URL for the mock-engine path before issuing the request.
This logic lives in one place (`backend/app/runtime/http_client.py`),
not per-node.

---

## 9. Test bank / mock-engine integration

Per FullSpec §5.1–§5.4. Sandbox routing is centralized:

1. **Connector nodes and `http.request`** route through
   `backend/app/runtime/http_client.py`. In sandbox, the client rewrites
   the URL: `https://api.zip.co/v1/...` → `http://localhost:8000/mock/{integration_id}/source/v1/...`.
2. **State / KV nodes** route through `backend/app/mock_engine/session_manager.py`
   in sandbox; through real persistence in production. Reads merge:
   session-state overlay wins over test-bank baseline.
3. **AI nodes**, in sandbox, optionally route to a deterministic stub
   (recorded fixture per `(node_id, prompt_hash)` pair). See §10 Q5.
4. **Time-dependent nodes** (Sleep, Wait until, Now with explicit
   override) accept a `frozen_now` value during sandbox tests so runs
   are deterministic.
5. **Error injection**: any node hitting the mock-engine may receive an
   injected error per the corpus (FullSpec §5.4). The structured
   `error` envelope flows downstream identically to a real API error.

---

## 10. Open questions

Decisions that need a product call before we harden them in code.

1. **Output of Branch.** Should `logic.branch` emit `{taken_branch:
   "true" | "false"}` for observability? Today it's a router — its arms
   produce output, but the node itself doesn't. Recommendation: emit
   `{$taken_branch: "true"}` under a metadata key so downstream Logs
   can show which path fired without affecting normal data flow.

2. **Multi-input nodes (`data.merge`, `data.join`).** How does the user
   wire two upstream nodes into one downstream? Current canvas model
   assumes single-stage-prior input. Options:
     - (a) Multi-input nodes pull from named earlier nodes via
       `inputs: [{ from: "<node-id>" }]` — explicit reference.
     - (b) Two-stage convention: the node lives in stage N+1, and pulls
       from all parallel nodes in stage N implicitly.
     - (c) New "Merge" container that explicitly wraps two parallel
       arms.
   Recommendation: (a). Most flexible, makes the data dependency
   explicit, no new container.

3. **Subprocess for-each reduce.** `process.call` in `for-each` mode
   today emits an implicit `collect`. Add an explicit `reduce` field to
   match `logic.loop`? Recommendation: yes. Same vocabulary
   (`collect | last | count | none`).

4. **`code.python` sandboxing.** RestrictedPython (in-process) is
   lighter; a subprocess sandbox (e.g. firejail / nsjail / Docker) is
   stronger but heavier. v1 uses local single-user dev — RestrictedPython
   is enough. v2 multi-user requires the subprocess approach. Capture
   this in the node's `requiresIsolation: true` flag and let the runtime
   pick.

5. **AI nodes in sandbox.** Three options:
     - (a) Always live — the LLM calls are cheap and sandbox runs are
       infrequent.
     - (b) Always stubbed — sandbox returns a fixed fixture for each
       `(node_id, prompt_hash)`. Deterministic but loses fidelity.
     - (c) Recorded — sandbox records the first call's result, replays
       on subsequent runs. Best of both.
   Recommendation: (c) — opt-in per node, with a "re-record" button.

6. **Connector catalog generation.** Each connector exposes a typed
   catalog of operations (§5.2). When does the frontend load it? At
   palette-open time (lazy) or at integration-load time (eager)?
   Recommendation: eager via `GET /api/connectors/{id}/catalog` cached
   for 1 minute. Avoids a palette flicker.

7. **Where does Math live in the sidebar?** Folded into Data per §4 for
   group-count economy. If users complain it's hard to find, promote to
   its own group later. Defer until we see usage signals.

8. **Webhook + schedule triggers** (FullSpec §12 Q6). Already an open
   question — surfaced again because the catalog touches it.
   Recommendation: hide entirely in v1 (consistent with the
   "no half-built features" rule). Re-introduce in v2 with real
   plumbing.

---

## 11. Implementation order (rough)

1. **Schema migration** — extend `CatalogEntry` in `frontend/src/catalog.ts`
   with the new fields (`inputs`, `outputShape`, `errorModes`,
   `sandboxBehavior`, `requiresCredentials`, `requiresConnector`,
   `agentAssist`, `category`, `tier`). Backfill existing 6 nodes.
   Coordinate with Step 4 since it edits the same store.
2. **PropertiesPanel split** — move to `editors/<kind>.tsx` (existing
   Tier-2 backlog). One PR. **Coordinate with Step 4 agent**.
3. **Tier 1 leaf nodes** in waves of 5–8 per PR:
   - `data.filter/sort/unique/pick/omit/rename`
   - `format.json_to_csv/csv_to_json/base64_encode/decode/url_encode/decode/hash`
   - `math.calc/round` + `str.concat/split/replace/trim/case`
   - `time.now/parse/format/add/diff`
   - `state.set/get/ulid/uuid/random_int/random_float`
   - `code.python` (separate PR — sandbox plumbing is non-trivial)
4. **Connector catalog generation** — `connector.zip.*` and
   `connector.hubspot.*` derived from mock-spec routes. Drives the
   "second connector required before v1 ships" gate (FullSpec §9.2).
5. **Tier 2 containers** — `logic.switch/try_catch/parallel/assert/gate`.
   Touches the canvas + step-into discipline; coordinate with whoever
   owns canvas.
6. **AI nodes** — after Tier 2 is stable. Wire to existing
   `services/agent.py` after that file's model pins are updated
   (HANDOFF backend punch list).
7. **Tier 3 / long tail** — opportunistic; not blocking v1.

---

## 12. Definition of done for the catalog (v1)

The catalog is "done for v1" when:

- All Tier-1 nodes ship with editors, runtime executors, sandbox routing,
  and at least one happy-path test each.
- The Zip + HubSpot connector catalogs are generated automatically from
  their mock-specs.
- The mapping agent (FullSpec §7.4) can propose a `transform.map` config
  that uses any Tier-1 `data.*` or `format.*` node when justified.
- The intent agent (FullSpec §7.3) can suggest the right connector node
  per endpoint mentioned in the user's free-text description.
- The PropertiesPanel split is complete; `editors/_shared.tsx` exists;
  every kind has its own editor file.
- The `code.python` sandbox passes a security review (no escape via
  `__builtins__`, `__import__`, file I/O, network, subprocess).
- `qa/qa_harness.py` smoke-tests at least one node from each Tier-1
  category.

---

## Appendix A — How this plan stays in sync with `HANDOFF.md`

This file is the **detailed plan**; `HANDOFF.md` is the **live ledger**.
When implementation work begins:

- The agent picking up node-implementation claims it in
  `HANDOFF.md` *Active Work* with the wave # (e.g. "Tier-1 wave 1: data.*").
- The agent updates this file to mark waves as done (strikethrough or
  "✅ shipped 2026-XX-XX") so the catalog of remaining work stays current.
- New nodes added to the brainstorm (someone realises we need a
  `format.markdown_to_html`) get appended to the relevant §5 table with
  a tier and a one-line rationale.
- Open questions resolved get moved to a "Resolved decisions" appendix.

The next agent reading this file should be able to know within 60 seconds
which nodes ship in v1, which configuration shape they use, and which
file to put the editor in.
