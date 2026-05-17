/**
 * Single source of truth for the node catalog.
 *
 * Every node in the integration graph is keyed by a two-axis discriminant
 * `{kind, action}`. Legacy single-axis `type` values are mapped through
 * LEGACY_TYPE_MAP on load (backend workflow has the matching shim).
 */

export type NodeGroup =
  | 'HTTP'
  | 'Connectors'
  | 'Data'
  | 'Format'
  | 'Logic'
  | 'Code'
  | 'AI'
  | 'State'
  | 'Time'
  | 'Process'
  | 'Output';

/**
 * Named input port. The default convention is one upstream-output input
 * referenced as `$`; multi-input nodes (Merge, Join) declare named inputs
 * here so the editor knows how many upstream sources to wire.
 */
export interface NodeInputSpec {
  name: string;
  /** Optional JSON-Schema-ish reference for documentation; not enforced at runtime yet. */
  shape?: string;
  required?: boolean;
}

/**
 * Coarse descriptor of what flows out of a node. Used by the run plan and
 * properties panel to render the right shape preview without inspecting
 * config. `passthrough` means the input shape is unchanged; `transform` is
 * user-controlled (Map / Output / API response).
 */
export type NodeOutputShape =
  | 'passthrough'
  | 'transform'
  | 'array'
  | 'object'
  | 'scalar'
  | 'side-effect'
  | 'error';

/**
 * How the node behaves under the sandbox/production switch. The runtime
 * reads this once at execution time:
 *   - `route-to-mock`: HTTP and connector calls — base URL is rewritten
 *     to the mock-engine path in sandbox; real URL in production.
 *   - `no-op`: the node does nothing in sandbox (e.g. Sleep). Useful for
 *     keeping iteration time low during testing.
 *   - `simulate`: the node runs a fast simulation in sandbox (e.g. a
 *     rate-limit emulator returning instantly).
 *   - `identical`: pure compute — same in both modes (Math, Format, etc.).
 */
export type SandboxBehavior = 'route-to-mock' | 'no-op' | 'simulate' | 'identical';

/** Top-level taxonomy. Drives palette grouping and the editor dispatcher. */
export type NodeCategory = 'leaf' | 'container' | 'trigger' | 'output' | 'ai';

/**
 * Declares which config fields a Solder agent can pre-fill on this node,
 * and from which context. The intent agent (FullSpec §7.3) populates
 * `intent` fields once the user confirms scope; the mapping agent
 * (FullSpec §7.4) populates `mapping` fields after test banks are ready;
 * the discovery agent (FullSpec §7.1) can populate URL/endpoint metadata.
 */
export interface AgentAssistSpec {
  fields: string[];
  fromContext: 'mapping' | 'intent' | 'discovery';
}

/**
 * A named variable declared on an If/Else or Switch node. Inner nodes
 * populate it during execution; downstream nodes read it from the
 * branch's scope after the branch completes.
 *
 * Frontend stores the declaration only — the runtime semantics (where
 * exactly the value lives in the per-run scope, how reads in unset
 * branches resolve, etc.) are backend-pending. See
 * NODE_CATALOG_PLAN.md §5.5.
 */
export interface BranchVariable {
  /** Identifier used to reference the variable from inner & downstream nodes. */
  name: string;
  /** Optional human-readable description shown in the editor. */
  description?: string;
  /**
   * Optional fallback value used when no arm sets the variable, or when
   * a downstream reference fires before the branch executes (rare).
   */
  default?: unknown;
}

/**
 * One case on a Switch node. The `key` is the corresponding key in
 * `node.branches[key]` — keep them in sync via `applySwitchCases`. The
 * `match` predicate is evaluated top-to-bottom; the first truthy case
 * runs. `label` is the case's display name on the canvas + editor; if
 * empty, the UI falls back to `Case N`.
 */
export interface SwitchCase {
  key: string;
  match: string;
  label?: string;
}

/**
 * A named accumulator on a Loop node. Inner nodes append values during
 * iteration; the final array surfaces downstream as a sibling of the
 * loop's `reduce` output. Lets a single loop emit multiple parallel
 * collections (e.g. `succeeded[]`, `failed[]`) without a downstream
 * splitter.
 */
export interface LoopAppend {
  name: string;
  description?: string;
}

/**
 * Resolve the live branch list for a node. For most container kinds
 * this is just the catalog's static `containerBranches`. For Switch
 * (where branches are dynamic — driven by `config.cases`) it derives
 * the list from config and appends the always-present `default` arm.
 *
 * Use this everywhere instead of `meta.containerBranches` directly,
 * so a future kind with dynamic branches doesn't require touching
 * every consumer.
 */
export function resolveBranches(
  node: { kind: string; action: string; config: Record<string, unknown> }
): Array<{ key: string; label: string }> | undefined {
  if (node.kind === 'logic' && node.action === 'switch') {
    const cases = (node.config.cases as SwitchCase[] | undefined) ?? [];
    const branches = cases.map((c, i) => ({
      key: c.key,
      label: c.label?.trim() || `CASE ${i + 1}`
    }));
    branches.push({ key: 'default', label: 'DEFAULT' });
    return branches;
  }
  const entry = CATALOG.find((e) => e.kind === node.kind && e.action === node.action);
  return entry?.containerBranches;
}

export interface CatalogEntry {
  kind: string;
  action: string;
  group: NodeGroup;
  label: string;
  description: string;
  icon: string;
  /** Chip-background classes applied to the circular icon container. */
  chip: string;
  /** Accent border-left color (Tailwind). */
  accent: string;
  /** Seed config when a fresh node is added. */
  defaultConfig: Record<string, unknown>;
  /** Derive the single-line body-preview text from the current node config. */
  preview: (config: Record<string, unknown>) => string;
  /**
   * If set, the node is a container — it holds named sub-chains of nodes.
   * The keys become branch names in `SolderNode.branches`. Values are labels
   * shown in the expanded container UI. Order defines rendering order.
   */
  containerBranches?: Array<{ key: string; label: string }>;

  // === v1 catalog metadata (NODE_CATALOG_PLAN.md §2). All optional except
  // `tier` so existing consumers don't break; new editors and the runtime
  // read whichever fields are populated. ===

  /** Named inputs the node accepts. Default (omitted) = single upstream-output input referenced as `$`. */
  inputs?: NodeInputSpec[];
  /** What this node emits to whatever runs after it. Drives plan-side preview. */
  outputShape?: NodeOutputShape;
  /** Declared error names a Try/Catch can catch from this node. */
  errorModes?: string[];
  /** How this node behaves under the sandbox/production switch (FullSpec §8.2). */
  sandboxBehavior?: SandboxBehavior;
  /** Gated by the credential picker in the editor. */
  requiresCredentials?: boolean;
  /** When set, ties this node to a specific connector id (e.g. "zip", "hubspot"). */
  requiresConnector?: string | null;
  /** Which Solder agent can pre-fill which fields on this node (FullSpec §7). */
  agentAssist?: AgentAssistSpec;
  /** Top-level taxonomy. Replaces the implicit `containerBranches?` flag for purposes other than rendering. */
  category?: NodeCategory;
  /** Implementation tier — drives palette filtering ("v1-ready" vs deferred). 1 = v1, 2 = v2, 3 = long tail. */
  tier: 1 | 2 | 3;
  /**
   * Static description of the data this node emits, surfaced in the
   * RefPicker dropdown so users can pick downstream references without
   * running the integration first. Each entry is a relative path under
   * `$.steps.<this-id>.output` plus a one-line description and an
   * optional sample value used for live preview.
   *
   * Only hand-author for kinds where the shape is predictable (HTTP
   * response envelope, Output mapping fields, State get scalar, etc.).
   * Kinds whose output shape depends on user config (Transform's
   * expression, Code's script body) emit just the root path; the
   * picker treats the rest as opaque until a real run lands.
   *
   * Used by `useReferenceableScope` (frontend/src/stores/integration.ts)
   * to populate the picker. The runtime resolver doesn't read this
   * field — it inspects actual run-time outputs.
   */
  referenceableOutputs?: Array<{
    path: string;
    description: string;
    sample?: unknown;
  }>;
}

/**
 * Default list returned for kinds that don't hand-author a shape. Keeps
 * the picker honest — it always offers *something* (the whole output)
 * even if we don't know the inner structure yet.
 */
export const FALLBACK_REFERENCEABLE_OUTPUTS: NonNullable<
  CatalogEntry['referenceableOutputs']
> = [{ path: '', description: 'Whole output of this step' }];

/**
 * Short uppercase code used as the ID prefix for nodes of each kind.
 * Surfaced everywhere a step is referenced — token strings, picker
 * row headers, run logs — instead of the previous UUID format. The
 * generator (`generateStepId` in stores/integration.ts) appends an
 * index for uniqueness within scope (`API_1`, `API_2`) and a `_LEV<n>`
 * suffix when nested inside a container (`FILTER_1_LEV1`).
 *
 * New catalog kinds should add their code here. Unknown kinds fall
 * back to the `idPrefixFor` heuristic — uppercase action with non-
 * alphanumeric stripped — which is fine but less polished than a
 * hand-authored short form.
 */
export const KIND_TO_ID_PREFIX: Record<string, string> = {
  // HTTP
  'http.request': 'API',
  // Connectors — one node per connector, action chosen at config time, so
  // the prefix is keyed by `<kind>.` (no specific action). Operation
  // changes don't rename the step (`ZIP_1` stays `ZIP_1` even after the
  // user switches from list_vendors to list_users).
  'zip.': 'ZIP',
  'hubspot.': 'HS',
  // Data
  'transform.map': 'TRANSFORM',
  'data.filter': 'FILTER',
  'data.sort': 'SORT',
  'data.unique': 'UNIQUE',
  'data.pick': 'PICK',
  'data.omit': 'OMIT',
  'data.rename': 'RENAME',
  // Math (folded into Data group; distinct kinds)
  'math.calc': 'CALC',
  'math.round': 'ROUND',
  // String
  'str.concat': 'CONCAT',
  'str.split': 'SPLIT',
  'str.replace': 'REPLACE',
  'str.trim': 'TRIM',
  'str.case': 'CASE',
  // Format
  'format.json_to_csv': 'JSON2CSV',
  'format.csv_to_json': 'CSV2JSON',
  'format.base64_encode': 'B64ENC',
  'format.base64_decode': 'B64DEC',
  'format.url_encode': 'URLENC',
  'format.url_decode': 'URLDEC',
  'format.hash': 'HASH',
  // Logic
  'logic.branch': 'IF',
  'logic.switch': 'SWITCH',
  'logic.loop': 'LOOP',
  'logic.assert': 'ASSERT',
  'logic.gate': 'GATE',
  // State
  'state.set': 'SET',
  'state.get': 'GET',
  'state.ulid': 'ULID',
  'state.uuid': 'UUID',
  'state.random_int': 'RANDINT',
  'state.random_float': 'RANDFLOAT',
  // Time
  'time.now': 'NOW',
  'time.parse': 'PARSE_DATE',
  'time.format': 'FORMAT_DATE',
  'time.add': 'ADD_DATE',
  'time.diff': 'DIFF_DATE',
  // Code
  'code.python': 'PY',
  // AI
  'ai.prompt': 'AI_PROMPT',
  'ai.classify': 'AI_CLASSIFY',
  'ai.extract': 'AI_EXTRACT',
  'ai.summarise': 'AI_SUMMARY',
  // Process / Output
  'process.call': 'CALL',
  'output.passthrough': 'OUTPUT',
  'output.return': 'RETURN',
  'output.error': 'ERROR'
};

/**
 * Resolve the short ID prefix for a (kind, action) pair. Falls back to
 * `${ACTION_UPPER}` for kinds not in the map — readable enough that an
 * unmapped node won't render as gibberish, just slightly verbose.
 */
export function idPrefixFor(kind: string, action: string): string {
  const explicit = KIND_TO_ID_PREFIX[`${kind}.${action}`];
  if (explicit) return explicit;
  // Connector kinds map by `<kind>.` regardless of which action is
  // chosen — keeps step ids stable across operation changes.
  const kindLevel = KIND_TO_ID_PREFIX[`${kind}.`];
  if (kindLevel) return kindLevel;
  // Family node dropped without an action picked yet — derive a prefix
  // from the kind alone so the step ID is stable until the user picks
  // an action and the per-action prefix takes over.
  if (!action) return kind.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_');
  return action.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_');
}

export const GROUPS: NodeGroup[] = [
  'HTTP',
  'Connectors',
  'Data',
  'Format',
  'Logic',
  'Code',
  'AI',
  'State',
  'Time',
  'Process',
  'Output'
];

/**
 * Family metadata — one entry per `kind` that exposes ≥2 actions in the
 * palette. The Sidebar collapses each family's per-action tiles into a
 * single tile that drops a `{kind, action: ''}` node; the editor then
 * renders an action picker, configures the chosen action's defaults, and
 * mounts the existing per-action editor unchanged.
 *
 * Single-action kinds (`http.request`, `code.python`, `transform.map`,
 * `output.passthrough`, `process.call`) are NOT families — they keep
 * their existing palette tile, since there's no action to choose.
 *
 * Logic is intentionally excluded: branch/switch/loop are containers
 * with structural side-effects (seedBranches, container scope), and
 * collapsing them would muddle the conceptual gap between "leaf" and
 * "container" actions in the palette. Authoring `Loop` and `If/Else`
 * as distinct first-class tiles keeps that boundary visible.
 */
export interface FamilyMeta {
  kind: string;
  group: NodeGroup;
  label: string;
  description: string;
  icon: string;
  chip: string;
  accent: string;
}

export const FAMILIES: FamilyMeta[] = [
  // Data group — three families fold ~14 tiles into 3.
  {
    kind: 'data',
    group: 'Data',
    label: 'Data shape',
    description: 'filter · sort · pick · omit · rename · unique',
    icon: '⊞',
    chip: 'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700',
    accent: 'border-l-surface-400'
  },
  {
    kind: 'math',
    group: 'Data',
    label: 'Math',
    description: 'calc · round',
    icon: '∑',
    chip: 'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700',
    accent: 'border-l-surface-400'
  },
  {
    kind: 'str',
    group: 'Data',
    label: 'String',
    description: 'concat · split · replace · trim · case',
    icon: 'Aa',
    chip: 'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700',
    accent: 'border-l-surface-400'
  },
  // Format group — collapses 7 tiles into 1.
  {
    kind: 'format',
    group: 'Format',
    label: 'Format',
    description: 'encode · decode · hash · CSV',
    icon: '⇄',
    chip: 'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700',
    accent: 'border-l-surface-400'
  },
  // State / Time / AI — each kind already has its own group; the family
  // is a 1:1 with the group. Tile shows up as the only entry.
  {
    kind: 'state',
    group: 'State',
    label: 'State',
    description: 'set · get · ULID · UUID · random',
    icon: '◧',
    chip: 'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700',
    accent: 'border-l-surface-400'
  },
  {
    kind: 'time',
    group: 'Time',
    label: 'Time',
    description: 'now · parse · format · add · diff',
    icon: '◷',
    chip: 'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700',
    accent: 'border-l-surface-400'
  },
  {
    kind: 'ai',
    group: 'AI',
    label: 'AI',
    description: 'prompt · classify · extract · summarise',
    icon: '✦',
    chip: 'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700',
    accent: 'border-l-surface-400'
  }
];

/** Set of `kind` strings that participate in family-mode palette tiles. */
export const FAMILY_KIND_SET: Set<string> = new Set(FAMILIES.map((f) => f.kind));

/** Lookup family metadata for a given kind. */
export function familyForKind(kind: string): FamilyMeta | undefined {
  return FAMILIES.find((f) => f.kind === kind);
}

/** Catalog entries (per-action) within a given family kind. */
export function actionsForKind(kind: string): CatalogEntry[] {
  return CATALOG.filter((e) => e.kind === kind && e.action);
}

/**
 * Default config for a (kind, action) pair. Used by the action picker
 * to seed the node's config when the user picks an action — same shape
 * the palette would have shipped if the user had dropped the per-action
 * tile directly.
 */
export function defaultConfigFor(
  kind: string,
  action: string
): Record<string, unknown> {
  const entry = CATALOG.find((e) => e.kind === kind && e.action === action);
  return entry ? { ...entry.defaultConfig } : {};
}

/*
 * Catalog chip palette.
 *
 * Per-category colours used to ship a five-hue rainbow (blue/purple/amber/rose/
 * cyan/emerald), which made any non-trivial canvas read as decorative confetti
 * with no clear focal point. We've collapsed the palette down to two tones:
 *
 *   - leaf nodes (http, transform, output)         → neutral
 *   - container nodes (branch, loop, call-subprocess) → primary accent
 *
 * Kind is still legible at a glance via the icon glyph (↗ ⚡ ⎇ ⟳ ⇥ ✓) and the
 * label text. Reserving colour for state (run status / selection) makes the
 * canvas's actual signal — what's running, what's failing — pop instead of
 * competing with category decoration. Containers get the one accent because
 * they own hierarchy; the rest stay quiet.
 */
const CHIP_LEAF =
  'bg-surface-100 text-surface-700 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700';
const CHIP_CONTAINER =
  'bg-primary-50 text-primary-700 ring-primary-200 dark:bg-primary-950/40 dark:text-primary-300 dark:ring-primary-800/50';

export const CATALOG: CatalogEntry[] = [
  {
    kind: 'http',
    action: 'request',
    group: 'HTTP',
    label: 'API Call',
    description: 'Make HTTP requests',
    icon: '↗',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      // HTTP node v2 — see editors/http/http.types.ts.
      schemaVersion: 2,
      connectionId: null,
      method: 'GET',
      url: '',
      params: [],
      headers: [],
      body: { mode: 'none', contentType: null },
      auth: { mode: 'inherit' },
      settings: {
        timeoutSeconds: 30,
        followRedirects: true,
        rejectUnauthorized: true,
        sandboxOverride: 'auto'
      },
      pagination: {
        mode: 'none',
        page_param: 'page',
        page_start: 1,
        page_size_param: '',
        page_size: 0,
        cursor_path: '$.next_cursor',
        cursor_param: 'cursor',
        items_path: '$',
        max_pages: 100,
        stop_on_empty: true
      }
    },
    preview: (cfg) => {
      const method = (cfg.method as string) || 'GET';
      const url = (cfg.url as string) || 'No URL set';
      const pag = cfg.pagination as { mode?: string } | undefined;
      const suffix = pag && pag.mode && pag.mode !== 'none' ? ` · ${pag.mode}` : '';
      return `${method} ${url}${suffix}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'transform',
    errorModes: ['http.4xx', 'http.5xx', 'timeout', 'auth'],
    sandboxBehavior: 'route-to-mock',
    requiresCredentials: true,
    agentAssist: { fields: ['method', 'url'], fromContext: 'intent' },
    referenceableOutputs: [
      { path: 'status_code', description: 'HTTP status code', sample: 200 },
      { path: 'headers', description: 'Response headers as an object' },
      { path: 'body', description: 'Decoded JSON response body' },
      { path: 'items', description: 'Aggregated items[] (when pagination is on)' }
    ]
  },
  // === Connectors === One palette node per connector. The specific
  // operation (list_vendors, list_contacts, …) is chosen in the editor's
  // Operation picker, which writes `action`, `endpoint.path`,
  // `endpoint.method`, `endpoint.entity_type` from the connector's
  // `discoverable_endpoints` (mirrored from `GET /api/connectors`).
  // Pagination defaults match each connector's wire shape: Zip = none
  // (sandbox lists are small), HubSpot = cursor (CRM v3 returns
  // `{results, paging.next.after}` in pages of up to 100).
  {
    kind: 'zip',
    action: '',
    group: 'Connectors',
    label: 'Zip',
    description: 'Pick an operation in the editor',
    icon: 'Z',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      credential_id: '',
      endpoint: { path: '', method: 'GET', entity_type: '' },
      pagination: { mode: 'none' }
    },
    preview: (cfg) => {
      const ep = cfg.endpoint as { path?: string; method?: string } | undefined;
      if (!ep?.path) return 'Pick an operation';
      return `${ep.method ?? 'GET'} ${ep.path}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    errorModes: ['http.4xx', 'http.5xx', 'timeout', 'auth'],
    sandboxBehavior: 'route-to-mock',
    requiresCredentials: true,
    requiresConnector: 'zip'
  },
  {
    kind: 'hubspot',
    action: '',
    group: 'Connectors',
    label: 'HubSpot',
    description: 'Pick an operation in the editor',
    icon: 'H',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      credential_id: '',
      endpoint: { path: '', method: 'GET', entity_type: '' },
      pagination: {
        mode: 'cursor',
        items_path: '$.results',
        cursor_path: '$.paging.next.after',
        cursor_param: 'after',
        page_size_param: 'limit',
        page_size: 100,
        max_pages: 100,
        stop_on_empty: true
      }
    },
    preview: (cfg) => {
      const ep = cfg.endpoint as { path?: string; method?: string } | undefined;
      if (!ep?.path) return 'Pick an operation';
      return `${ep.method ?? 'GET'} ${ep.path}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    errorModes: ['http.4xx', 'http.5xx', 'timeout', 'auth'],
    sandboxBehavior: 'route-to-mock',
    requiresCredentials: true,
    requiresConnector: 'hubspot'
  },
  {
    kind: 'transform',
    action: 'map',
    group: 'Data',
    label: 'Transform',
    description: 'Transform data',
    icon: '⚡',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { expression: '$.data' },
    preview: (cfg) => (cfg.expression as string) || 'No expression',
    category: 'leaf',
    tier: 1,
    outputShape: 'transform',
    errorModes: ['expression'],
    sandboxBehavior: 'identical',
    agentAssist: { fields: ['expression'], fromContext: 'mapping' }
  },
  {
    kind: 'data',
    action: 'ingest_to_bank',
    group: 'Data',
    label: 'Ingest to test bank',
    description: 'Persist upstream records into the integration test bank',
    icon: '▼',
    chip: CHIP_LEAF,
    accent: 'border-l-emerald-400',
    defaultConfig: {
      entity_type: '',
      id_path: '$.id',
      items_path: '',
      connector_name: '',
      replace: false
    },
    preview: (cfg) => {
      const et = (cfg.entity_type as string)?.trim() || '<entity_type>';
      const replace = cfg.replace ? ' (replace)' : '';
      return `→ bank: ${et}${replace}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'transform',
    errorModes: ['runtime'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'data',
    action: 'filter',
    group: 'Data',
    label: 'Filter',
    description: 'Keep array items matching a predicate',
    icon: '▽',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { over: '$', expression: '' },
    preview: (cfg) => {
      const over = (cfg.over as string) || '$';
      const expr = (cfg.expression as string)?.trim();
      return expr ? `filter ${over} where ${expr}` : `filter ${over}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    errorModes: ['expression'],
    sandboxBehavior: 'identical',
    agentAssist: { fields: ['expression'], fromContext: 'mapping' }
  },
  {
    kind: 'data',
    action: 'sort',
    group: 'Data',
    label: 'Sort',
    description: 'Sort an array by a key',
    icon: '⇅',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { over: '$', by: '', order: 'asc' },
    preview: (cfg) => {
      const over = (cfg.over as string) || '$';
      const by = (cfg.by as string)?.trim();
      const order = (cfg.order as string) || 'asc';
      return by ? `sort ${over} by ${by} · ${order}` : `sort ${over} · ${order}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    errorModes: ['expression'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'data',
    action: 'unique',
    group: 'Data',
    label: 'Unique',
    description: 'Deduplicate array items',
    icon: '✦',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { over: '$', by: '' },
    preview: (cfg) => {
      const over = (cfg.over as string) || '$';
      const by = (cfg.by as string)?.trim();
      return by ? `unique ${over} by ${by}` : `unique ${over}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'data',
    action: 'pick',
    group: 'Data',
    label: 'Pick fields',
    description: 'Whitelist fields from each item',
    icon: '◫',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { over: '$', fields: [] as string[] },
    preview: (cfg) => {
      const over = (cfg.over as string) || '$';
      const fields = (cfg.fields as string[]) || [];
      const summary = fields.length === 0 ? 'no fields' : `${fields.length} field${fields.length === 1 ? '' : 's'}`;
      return `pick ${summary} from ${over}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    sandboxBehavior: 'identical',
    agentAssist: { fields: ['fields'], fromContext: 'mapping' }
  },
  {
    kind: 'data',
    action: 'omit',
    group: 'Data',
    label: 'Omit fields',
    description: 'Drop fields from each item',
    icon: '⊟',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { over: '$', fields: [] as string[] },
    preview: (cfg) => {
      const over = (cfg.over as string) || '$';
      const fields = (cfg.fields as string[]) || [];
      const summary = fields.length === 0 ? 'no fields' : `${fields.length} field${fields.length === 1 ? '' : 's'}`;
      return `omit ${summary} from ${over}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'data',
    action: 'rename',
    group: 'Data',
    label: 'Rename fields',
    description: 'Rename fields per a mapping',
    icon: '⇄',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { over: '$', mapping: {} as Record<string, string> },
    preview: (cfg) => {
      const over = (cfg.over as string) || '$';
      const mapping = (cfg.mapping as Record<string, string>) || {};
      const count = Object.keys(mapping).length;
      const summary = count === 0 ? 'no renames' : `${count} rename${count === 1 ? '' : 's'}`;
      return `${summary} on ${over}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    sandboxBehavior: 'identical',
    agentAssist: { fields: ['mapping'], fromContext: 'mapping' }
  },
  {
    kind: 'math',
    action: 'calc',
    group: 'Data',
    label: 'Calc',
    description: 'Evaluate a math expression',
    icon: '∑',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { expression: '$.value' },
    preview: (cfg) => (cfg.expression as string) || 'no expression',
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['expression'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'math',
    action: 'round',
    group: 'Data',
    label: 'Round',
    description: 'Round / ceil / floor / truncate',
    icon: '⌊⌋',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { value: '$', mode: 'round' as 'round' | 'ceil' | 'floor' | 'trunc', places: 0 },
    preview: (cfg) => {
      const mode = (cfg.mode as string) || 'round';
      const places = (cfg.places as number) ?? 0;
      return `${mode} · ${places} dp`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'str',
    action: 'concat',
    group: 'Data',
    label: 'Concat',
    description: 'Join strings with a separator',
    icon: '⊕',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { parts: [] as string[], separator: '' },
    preview: (cfg) => {
      const parts = (cfg.parts as string[]) || [];
      const sep = (cfg.separator as string) ?? '';
      const sepLabel = sep === '' ? 'no sep' : `"${sep}"`;
      return `${parts.length} part${parts.length === 1 ? '' : 's'} · ${sepLabel}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'str',
    action: 'split',
    group: 'Data',
    label: 'Split',
    description: 'Split a string into an array',
    icon: '⫶',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { value: '$', separator: ',', max: 0 },
    preview: (cfg) => {
      const sep = (cfg.separator as string) ?? '';
      const max = (cfg.max as number) ?? 0;
      const sepLabel = sep === '' ? 'every char' : `on "${sep}"`;
      return max > 0 ? `${sepLabel} · max ${max}` : sepLabel;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'str',
    action: 'replace',
    group: 'Data',
    label: 'Replace',
    description: 'Find and replace (regex supported)',
    icon: '↹',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { value: '$', pattern: '', replacement: '', all: true, regex: false },
    preview: (cfg) => {
      const pattern = (cfg.pattern as string) || '';
      const all = cfg.all !== false;
      const regex = !!cfg.regex;
      const head = pattern ? `/${pattern}/` : 'no pattern';
      return `${head}${regex ? ' regex' : ''}${all ? ' · all' : ' · first'}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['pattern'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'str',
    action: 'trim',
    group: 'Data',
    label: 'Trim',
    description: 'Strip whitespace or specific chars',
    icon: '⤓',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { value: '$', side: 'both' as 'both' | 'start' | 'end', chars: '' },
    preview: (cfg) => {
      const side = (cfg.side as string) || 'both';
      const chars = (cfg.chars as string) || '';
      return chars ? `${side} · "${chars}"` : `${side} · whitespace`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'str',
    action: 'case',
    group: 'Data',
    label: 'Case',
    description: 'Convert string case',
    icon: 'Aa',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      value: '$',
      to: 'lower' as 'upper' | 'lower' | 'title' | 'camel' | 'snake' | 'kebab'
    },
    preview: (cfg) => `to ${(cfg.to as string) || 'lower'}`,
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'format',
    action: 'json_to_csv',
    group: 'Format',
    label: 'JSON → CSV',
    description: 'Array of objects → CSV string',
    icon: '▦',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { over: '$', columns: [] as string[], header: true, delimiter: ',' },
    preview: (cfg) => {
      const cols = (cfg.columns as string[]) || [];
      const summary = cols.length === 0 ? 'auto columns' : `${cols.length} cols`;
      const delim = (cfg.delimiter as string) || ',';
      return `${summary} · "${delim}"`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['format'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'format',
    action: 'csv_to_json',
    group: 'Format',
    label: 'CSV → JSON',
    description: 'CSV string → array of objects',
    icon: '⌗',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { csv: '$', has_header: true, delimiter: ',', type_coerce: false },
    preview: (cfg) => {
      const header = cfg.has_header === false ? 'no header' : 'with header';
      const delim = (cfg.delimiter as string) || ',';
      return `${header} · "${delim}"`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'array',
    errorModes: ['format'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'format',
    action: 'base64_encode',
    group: 'Format',
    label: 'Base64 encode',
    description: 'Encode bytes/string as base64',
    icon: '⊕',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { data: '$', url_safe: false },
    preview: (cfg) => (cfg.url_safe ? 'url-safe base64' : 'base64'),
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'format',
    action: 'base64_decode',
    group: 'Format',
    label: 'Base64 decode',
    description: 'Decode base64 to string or bytes',
    icon: '⊖',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { data: '$', as: 'string' as 'string' | 'bytes' },
    preview: (cfg) => `decode → ${(cfg.as as string) || 'string'}`,
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['format'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'format',
    action: 'url_encode',
    group: 'Format',
    label: 'URL encode',
    description: 'Percent-escape a string',
    icon: '%',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { data: '$', component: true },
    preview: (cfg) => (cfg.component === false ? 'encode (full URL)' : 'encode (component)'),
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'format',
    action: 'url_decode',
    group: 'Format',
    label: 'URL decode',
    description: 'Percent-unescape a string',
    icon: '⏎',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { data: '$' },
    preview: () => 'decode',
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['format'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'format',
    action: 'hash',
    group: 'Format',
    label: 'Hash',
    description: 'Compute md5 / sha1 / sha256 / sha512',
    icon: '#',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { data: '$', algo: 'sha256' as 'md5' | 'sha1' | 'sha256' | 'sha512', output: 'hex' as 'hex' | 'base64' },
    preview: (cfg) => `${(cfg.algo as string) || 'sha256'} · ${(cfg.output as string) || 'hex'}`,
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'logic',
    action: 'branch',
    group: 'Logic',
    label: 'If / Else',
    description: 'Two-way conditional — TRUE arm or FALSE arm',
    icon: '⎇',
    chip: CHIP_CONTAINER,
    accent: 'border-l-primary-500',
    /*
     * `variables` are declared on the action and populated by inner nodes;
     * after the branch completes they're available downstream. See
     * `BranchVariable` below + NODE_CATALOG_PLAN.md §5.5 ("If/Else &
     * Switch variables"). Runtime support is backend-pending — frontend
     * stores the declarations only for now.
     */
    defaultConfig: {
      expression: '$.status == "success"',
      variables: [] as BranchVariable[]
    },
    preview: (cfg) => `if ${(cfg.expression as string) || '—'}`,
    containerBranches: [
      { key: 'true', label: 'TRUE' },
      { key: 'false', label: 'FALSE' }
    ],
    category: 'container',
    tier: 1,
    outputShape: 'passthrough',
    errorModes: ['expression'],
    sandboxBehavior: 'identical'
  },
  {
    /*
     * Switch — N-way branch with named cases plus an always-present
     * `default` arm. Branch keys are *dynamic*: each entry in
     * `config.cases` becomes a branch in `node.branches`. The catalog's
     * static `containerBranches` is intentionally absent here; consumers
     * must use `resolveBranches(node)` instead, which derives the live
     * list from `config.cases` and appends `default` automatically.
     *
     * Match semantics: each case has its own `match` predicate, evaluated
     * top-to-bottom. The first one that's truthy runs; if none match,
     * `default` runs. Mirrors `if/elif/else` in code.
     */
    kind: 'logic',
    action: 'switch',
    group: 'Logic',
    label: 'Switch',
    description: 'Multi-way branch — first matching case, else default',
    icon: '◇',
    chip: CHIP_CONTAINER,
    accent: 'border-l-primary-500',
    defaultConfig: {
      cases: [
        { key: 'case_1', match: '', label: '' },
        { key: 'case_2', match: '', label: '' }
      ] as SwitchCase[],
      variables: [] as BranchVariable[]
    },
    preview: (cfg) => {
      const cases = (cfg.cases as SwitchCase[] | undefined) ?? [];
      const n = cases.length;
      return n === 0 ? 'default only' : `${n} ${n === 1 ? 'case' : 'cases'} · default`;
    },
    // No `containerBranches` — switch uses dynamic branches via resolveBranches().
    category: 'container',
    tier: 1,
    outputShape: 'passthrough',
    errorModes: ['expression'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'logic',
    action: 'loop',
    group: 'Logic',
    label: 'Loop',
    description: 'Repeat for each item',
    icon: '⟳',
    chip: CHIP_CONTAINER,
    accent: 'border-l-primary-500',
    /*
     * `appends` are the loop's named accumulators — the equivalent of
     * branch `variables` for iterative work. Inner nodes append values
     * (one per iteration, conditionally) and the final array is exposed
     * downstream. Lets a single loop emit multiple parallel collections
     * (`succeeded[]`, `failed[]`) without a downstream split.
     */
    defaultConfig: {
      over: '$.items',
      reduce: 'collect',
      appends: [] as LoopAppend[]
    },
    preview: (cfg) => `for each ${(cfg.over as string) || '$.items'}`,
    containerBranches: [{ key: 'body', label: 'BODY' }],
    category: 'container',
    tier: 1,
    // Default reduce mode is `collect` → array of body outputs. `last`
    // narrows to scalar/object; `count` is scalar; `none` is side-effect.
    // The card shows the chosen mode via loopReduceCaption.
    outputShape: 'array',
    errorModes: ['expression'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'logic',
    action: 'assert',
    group: 'Logic',
    label: 'Assert',
    description: 'Halt the run if the predicate is falsy',
    icon: '!',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { expression: '', message: 'Assertion failed' },
    preview: (cfg) => {
      const expr = (cfg.expression as string)?.trim();
      return expr ? `expect ${expr}` : 'no predicate';
    },
    category: 'leaf',
    tier: 2,
    // Pass-through on success — emit the input unchanged so downstream
    // nodes don't need a re-wire. Failure raises an assertion error
    // surfaced via the standard error envelope.
    outputShape: 'passthrough',
    errorModes: ['assertion'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'logic',
    action: 'gate',
    group: 'Logic',
    label: 'Gate',
    description: 'Pass-through or stop based on a predicate',
    icon: '∥',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      expression: '',
      on_false: 'skip' as 'skip' | 'stop'
    },
    preview: (cfg) => {
      const expr = (cfg.expression as string)?.trim();
      const onFalse = (cfg.on_false as string) || 'skip';
      return expr ? `if ${expr} · else ${onFalse}` : `else ${onFalse}`;
    },
    category: 'leaf',
    tier: 2,
    outputShape: 'passthrough',
    errorModes: ['expression'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'code',
    action: 'python',
    group: 'Code',
    label: 'Python',
    description: 'Run a sandboxed Python script',
    icon: 'py',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      // Sensible starter scaffold so users don't open a blank editor.
      // Snippets remain reachable via the editor's `Templates` toolbar
      // button regardless of source state. `result` is the conventional
      // name the runtime looks for as the node's output.
      source: '# input is bound to `data`\n# set `result` to the node output\nresult = data\n',
      timeout_ms: 30000,
      // Allowlist of stdlib modules the script can import. Empty list means
      // "stdlib safe set chosen by the sandbox" — runtime decides defaults.
      allow_imports: [] as string[]
    },
    preview: (cfg) => {
      const src = (cfg.source as string) || '';
      const lines = src.split('\n').filter((l) => l.trim()).length;
      const t = (cfg.timeout_ms as number) ?? 30000;
      return lines === 0 ? '(empty script)' : `${lines} line${lines === 1 ? '' : 's'} · ${Math.round(t / 1000)}s timeout`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'transform',
    errorModes: ['python.syntax', 'python.runtime', 'python.timeout', 'python.import_blocked'],
    // Pure compute from the network's perspective — sandboxed in both modes.
    // The sandbox itself is enforced backend-side; the editor stays the same.
    sandboxBehavior: 'identical'
  },
  {
    kind: 'ai',
    action: 'prompt',
    group: 'AI',
    label: 'Claude prompt',
    description: 'Free-form text prompt → text',
    icon: '✦',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      model: 'claude-sonnet-4-6',
      system: '',
      user: '$.prompt',
      max_tokens: 1024,
      structured: false
    },
    preview: (cfg) => {
      const model = (cfg.model as string) || 'claude-sonnet-4-6';
      const max = (cfg.max_tokens as number) ?? 1024;
      return `${model} · ≤${max} tokens`;
    },
    category: 'ai',
    tier: 2,
    outputShape: 'scalar',
    errorModes: ['ai.rate_limited', 'ai.context_overflow', 'ai.refused', 'ai.timeout'],
    // Sandbox routing for AI is FullSpec §10 Q5 (record/stub/live). Default
    // to route-to-mock so sandbox runs are deterministic and don't burn LLM
    // tokens; backend can serve recorded fixtures keyed by prompt hash.
    sandboxBehavior: 'route-to-mock',
    requiresCredentials: true,
    agentAssist: { fields: ['system', 'user'], fromContext: 'mapping' }
  },
  {
    kind: 'ai',
    action: 'classify',
    group: 'AI',
    label: 'Classify',
    description: 'Pick one of N labels',
    icon: '◇',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      input: '$',
      labels: [] as string[],
      model: 'claude-sonnet-4-6'
    },
    preview: (cfg) => {
      const labels = (cfg.labels as string[]) || [];
      return labels.length === 0 ? 'no labels' : `${labels.length} label${labels.length === 1 ? '' : 's'}`;
    },
    category: 'ai',
    tier: 2,
    outputShape: 'scalar',
    errorModes: ['ai.rate_limited', 'ai.context_overflow', 'ai.refused', 'ai.timeout', 'ai.invalid_label'],
    sandboxBehavior: 'route-to-mock',
    requiresCredentials: true,
    agentAssist: { fields: ['labels'], fromContext: 'mapping' }
  },
  {
    kind: 'ai',
    action: 'extract',
    group: 'AI',
    label: 'Extract',
    description: 'Pull structured data per a schema',
    icon: '⊞',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      input: '$',
      schema: {} as Record<string, unknown>,
      model: 'claude-sonnet-4-6'
    },
    preview: (cfg) => {
      const schema = (cfg.schema as Record<string, unknown>) || {};
      const fields = Object.keys(schema).length;
      return fields === 0 ? 'no schema' : `${fields} field${fields === 1 ? '' : 's'}`;
    },
    category: 'ai',
    tier: 2,
    outputShape: 'object',
    errorModes: ['ai.rate_limited', 'ai.context_overflow', 'ai.refused', 'ai.timeout', 'ai.schema_violation'],
    sandboxBehavior: 'route-to-mock',
    requiresCredentials: true,
    agentAssist: { fields: ['schema'], fromContext: 'mapping' }
  },
  {
    kind: 'ai',
    action: 'summarise',
    group: 'AI',
    label: 'Summarise',
    description: 'Long text → short summary',
    icon: '∷',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      input: '$',
      target_length: 'medium' as 'short' | 'medium' | 'long',
      style: 'neutral' as 'neutral' | 'bullets' | 'executive' | 'technical',
      model: 'claude-opus-4-7'
    },
    preview: (cfg) => {
      const len = (cfg.target_length as string) || 'medium';
      const style = (cfg.style as string) || 'neutral';
      return `${len} · ${style}`;
    },
    category: 'ai',
    tier: 2,
    outputShape: 'scalar',
    errorModes: ['ai.rate_limited', 'ai.context_overflow', 'ai.refused', 'ai.timeout'],
    sandboxBehavior: 'route-to-mock',
    requiresCredentials: true
  },
  {
    kind: 'process',
    action: 'call',
    group: 'Process',
    label: 'Call Subprocess',
    description: 'Run a reusable subprocess',
    icon: '⇥',
    chip: CHIP_CONTAINER,
    accent: 'border-l-primary-500',
    defaultConfig: {
      target_id: '',
      target_name: '',
      mode: 'once' as 'once' | 'for-each',
      over: '$.items',
      inputs: {}
    },
    preview: (cfg) => {
      const name = (cfg.target_name as string) || '(pick a subprocess)';
      const mode = (cfg.mode as string) || 'once';
      return mode === 'for-each' ? `${name} · for each ${(cfg.over as string) || '$.items'}` : name;
    },
    category: 'container',
    tier: 1,
    outputShape: 'transform',
    errorModes: ['subprocess', 'subprocess.not_found'],
    sandboxBehavior: 'identical',
    agentAssist: { fields: ['target_id', 'inputs'], fromContext: 'mapping' }
  },
  {
    kind: 'state',
    action: 'set',
    group: 'State',
    label: 'Set variable',
    description: 'Write to integration scope',
    icon: '⇒',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { name: '', value: '$' },
    preview: (cfg) => {
      const name = (cfg.name as string)?.trim() || '(unnamed)';
      const value = (cfg.value as string) || '$';
      return `${name} ← ${value}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'side-effect',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'state',
    action: 'get',
    group: 'State',
    label: 'Get variable',
    description: 'Read from integration scope',
    icon: '⇐',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { name: '', default: null as unknown },
    preview: (cfg) => {
      const name = (cfg.name as string)?.trim() || '(unnamed)';
      const hasDefault = cfg.default !== null && cfg.default !== undefined;
      return hasDefault ? `${name} (with default)` : name;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'transform',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'state',
    action: 'ulid',
    group: 'State',
    label: 'ULID',
    description: 'Generate a sortable ULID',
    icon: '◐',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { prefix: '' },
    preview: (cfg) => {
      const prefix = (cfg.prefix as string)?.trim();
      return prefix ? `${prefix}_<ulid>` : 'ulid';
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'state',
    action: 'uuid',
    group: 'State',
    label: 'UUID',
    description: 'Generate a UUID v4',
    icon: '◯',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {},
    preview: () => 'uuid v4',
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'state',
    action: 'random_int',
    group: 'State',
    label: 'Random int',
    description: 'Random integer in [min, max]',
    icon: '⚂',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { min: 0, max: 100, seed: '' },
    preview: (cfg) => {
      const min = (cfg.min as number) ?? 0;
      const max = (cfg.max as number) ?? 100;
      return `[${min}, ${max}]`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'state',
    action: 'random_float',
    group: 'State',
    label: 'Random float',
    description: 'Random float in [min, max)',
    icon: '⚄',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { min: 0, max: 1, seed: '' },
    preview: (cfg) => {
      const min = (cfg.min as number) ?? 0;
      const max = (cfg.max as number) ?? 1;
      return `[${min}, ${max})`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'time',
    action: 'now',
    group: 'Time',
    label: 'Now',
    description: 'Current timestamp',
    icon: '◷',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { format: 'iso' as 'iso' | 'unix' | 'unix_ms', tz: 'UTC' },
    preview: (cfg) => {
      const fmt = (cfg.format as string) || 'iso';
      const tz = (cfg.tz as string) || 'UTC';
      return fmt === 'iso' ? `iso · ${tz}` : fmt;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'time',
    action: 'parse',
    group: 'Time',
    label: 'Parse date',
    description: 'String → ISO timestamp',
    icon: '⇨',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      value: '$',
      formats: [] as string[],
      assume_tz: 'UTC'
    },
    preview: (cfg) => {
      const formats = (cfg.formats as string[]) || [];
      return formats.length === 0 ? 'auto-detect' : `${formats.length} format${formats.length === 1 ? '' : 's'}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['format'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'time',
    action: 'format',
    group: 'Time',
    label: 'Format date',
    description: 'ISO timestamp → string',
    icon: '⇦',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      value: '$',
      format: 'YYYY-MM-DD',
      tz: 'UTC'
    },
    preview: (cfg) => {
      const fmt = (cfg.format as string) || 'YYYY-MM-DD';
      const tz = (cfg.tz as string) || 'UTC';
      return `${fmt} · ${tz}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['format'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'time',
    action: 'add',
    group: 'Time',
    label: 'Add duration',
    description: 'Shift a timestamp by N units',
    icon: '⊕',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      value: '$',
      amount: 0,
      unit: 'days' as 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
    },
    preview: (cfg) => {
      const amount = (cfg.amount as number) ?? 0;
      const unit = (cfg.unit as string) || 'days';
      const sign = amount >= 0 ? '+' : '';
      return `${sign}${amount} ${unit}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    sandboxBehavior: 'identical'
  },
  {
    kind: 'time',
    action: 'diff',
    group: 'Time',
    label: 'Diff',
    description: 'Difference between two timestamps',
    icon: '∆',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: {
      a: '$',
      b: '',
      unit: 'days' as 'seconds' | 'minutes' | 'hours' | 'days'
    },
    preview: (cfg) => {
      const unit = (cfg.unit as string) || 'days';
      return `a − b · ${unit}`;
    },
    category: 'leaf',
    tier: 1,
    outputShape: 'scalar',
    errorModes: ['format'],
    sandboxBehavior: 'identical'
  },
  {
    kind: 'output',
    action: 'passthrough',
    group: 'Output',
    label: 'Output',
    description: 'Final output',
    icon: '✓',
    chip: CHIP_LEAF,
    accent: 'border-l-surface-400',
    defaultConfig: { mapping: {} },
    preview: () => 'Output mapping',
    category: 'output',
    tier: 1,
    outputShape: 'transform',
    errorModes: [],
    sandboxBehavior: 'identical',
    agentAssist: { fields: ['mapping'], fromContext: 'mapping' }
  }
];

/** Legacy single-axis `type` → new {kind, action}. Keep in sync with backend `_LEGACY_TYPE_MAP`. */
export const LEGACY_TYPE_MAP: Record<string, { kind: string; action: string }> = {
  api_call: { kind: 'http', action: 'request' },
  transform: { kind: 'transform', action: 'map' },
  condition: { kind: 'logic', action: 'if' },
  output: { kind: 'output', action: 'passthrough' }
};

const FALLBACK: CatalogEntry = {
  kind: 'unknown',
  action: 'unknown',
  group: 'HTTP',
  label: 'Unknown',
  description: 'Unrecognised node kind',
  icon: '?',
  chip: 'bg-surface-100 text-surface-500 ring-surface-300 dark:bg-surface-800 dark:text-surface-400 dark:ring-surface-700',
  accent: 'border-l-surface-400',
  defaultConfig: {},
  preview: () => '—',
  // Fallback isn't a real catalog entry — the user can't pick it. Tier 3
  // keeps it out of any "v1-ready" palette filter, and `passthrough` keeps
  // the run plan from making promises about output shape.
  category: 'leaf',
  tier: 3,
  outputShape: 'passthrough',
  sandboxBehavior: 'identical'
};

export function lookupCatalog(kind: string, action: string): CatalogEntry {
  // Exact match first. For connectors (one entry per kind, action chosen
  // at config time), fall back to the kind-level entry so saved nodes
  // with `action: 'list_vendors'` still render the correct icon, label,
  // and group instead of the unhelpful FALLBACK.
  const exact = CATALOG.find((e) => e.kind === kind && e.action === action);
  if (exact) return exact;
  const kindLevel = CATALOG.find((e) => e.kind === kind && e.action === '');
  if (kindLevel) return kindLevel;
  // Family kinds with no action chosen yet: synthesise a catalog entry
  // from the FamilyMeta so the NodeCard renders the family's icon/label
  // and a "pick action" preview instead of the generic Unknown chip.
  const family = familyForKind(kind);
  if (family) {
    return {
      kind: family.kind,
      action: '',
      group: family.group,
      label: family.label,
      description: family.description,
      icon: family.icon,
      chip: family.chip,
      accent: family.accent,
      defaultConfig: {},
      preview: () => 'pick action',
      category: 'leaf',
      tier: 1,
      outputShape: 'passthrough',
      sandboxBehavior: 'identical'
    };
  }
  return FALLBACK;
}

/** DOM key used for both CSS class suffix and data-testid. */
export function nodeKey(kind: string, action: string): string {
  return `${kind}-${action}`;
}

/** Group CATALOG into a `{group: [entries]}` map for grouped UI rendering. */
export function groupedCatalog(): Record<NodeGroup, CatalogEntry[]> {
  // Built dynamically from GROUPS so adding a new NodeGroup (Format / Time /
  // State / AI / etc.) doesn't require touching this function. The
  // double-cast bridges TS's string-keyed `fromEntries` inference to our
  // literal-keyed Record — the keys are guaranteed to match `NodeGroup` by
  // construction.
  const out = Object.fromEntries(GROUPS.map((g) => [g, [] as CatalogEntry[]])) as unknown as Record<
    NodeGroup,
    CatalogEntry[]
  >;
  for (const e of CATALOG) out[e.group].push(e);
  return out;
}

/**
 * Seed an empty branches map for container nodes. Returns undefined for
 * non-container kinds so callers can spread conditionally: `...(seeded ? { branches: seeded } : {})`.
 */
export function seedBranches(
  kind: string,
  action: string,
  config?: Record<string, unknown>
): Record<string, unknown[]> | undefined {
  // Switch is dynamic — seed from defaultConfig.cases (passed via the
  // newly-created node's config) plus the always-present `default` arm.
  // Falls back to the catalog defaultConfig if no config was passed,
  // which matches the old call shape used in places that don't have a
  // node yet.
  if (kind === 'logic' && action === 'switch') {
    const entry = CATALOG.find((e) => e.kind === kind && e.action === action);
    const cfg =
      config ?? (entry?.defaultConfig as Record<string, unknown> | undefined);
    const cases = (cfg?.cases as SwitchCase[] | undefined) ?? [];
    const out: Record<string, unknown[]> = {};
    for (const c of cases) out[c.key] = [];
    out.default = [];
    return out;
  }
  const entry = CATALOG.find((e) => e.kind === kind && e.action === action);
  if (!entry?.containerBranches) return undefined;
  const out: Record<string, unknown[]> = {};
  for (const b of entry.containerBranches) out[b.key] = [];
  return out;
}

/** Quick check: is this node kind/action a container? */
export function isContainerKind(kind: string, action: string): boolean {
  // Switch is a container even though it has no static `containerBranches`.
  if (kind === 'logic' && action === 'switch') return true;
  const entry = CATALOG.find((e) => e.kind === kind && e.action === action);
  return !!entry?.containerBranches;
}

/**
 * Derive a readable title for a container from its config. Pattern-recogniser,
 * not magic — when the config is too irregular to summarise we return null
 * and the card falls back to the catalog kind ("Loop", "Branch").
 *
 * Examples:
 *   Loop  over=$.invoices            → "For each invoice"
 *   Loop  over=$.purchase_orders[*]  → "For each purchase order"
 *   Loop  over=$.items               → "For each item"
 *   Branch  expression=$.status == "approved"  → "If status approved"
 *   Branch  expression=$.is_active             → "If is active"
 *   Branch  expression=$.count > 5             → "If count > 5"
 *   Process target_name="Sync vendor"          → "Sync vendor"
 */
export function defaultContainerLabel(node: {
  kind: string;
  action: string;
  config: Record<string, unknown>;
}): string | null {
  if (node.kind === 'logic' && node.action === 'loop') {
    const over = (node.config.over as string | undefined)?.trim();
    if (!over) return null;
    const noun = lastJsonPathSegment(over);
    if (!noun) return null;
    return `For each ${humanise(singularise(noun))}`;
  }
  if (node.kind === 'logic' && node.action === 'branch') {
    const expr = (node.config.expression as string | undefined)?.trim();
    if (!expr) return null;
    // `$.field == "value"` and friends → "If field value".
    const eq = expr.match(/^\$\.([\w.]+)\s*==\s*['"]?([^'"\s][^'"]*?)['"]?$/);
    if (eq) {
      const [, field, value] = eq;
      const last = field.split('.').pop() ?? field;
      return `If ${humanise(last)} ${humanise(value)}`.trim();
    }
    // Bare `$.field` truthy check → "If field".
    const bare = expr.match(/^\$\.([\w.]+)$/);
    if (bare) {
      const last = bare[1].split('.').pop() ?? bare[1];
      return `If ${humanise(last)}`;
    }
    // Comparison operators — keep the operator + RHS verbatim, humanise LHS.
    const cmp = expr.match(/^\$\.([\w.]+)\s*(==|!=|>=|<=|>|<|in|not in)\s*(.+)$/);
    if (cmp) {
      const [, field, op, rhs] = cmp;
      const last = field.split('.').pop() ?? field;
      return `If ${humanise(last)} ${op} ${rhs.trim()}`;
    }
    return null;
  }
  if (node.kind === 'logic' && node.action === 'switch') {
    const cases = (node.config.cases as SwitchCase[] | undefined) ?? [];
    const named = cases
      .map((c) => c.label?.trim())
      .filter((l): l is string => !!l);
    if (named.length === 0) return null;
    if (named.length === 1) return `Switch ${named[0]} or default`;
    if (named.length === 2) return `Switch ${named[0]} / ${named[1]} / default`;
    return `Switch ${named.length} cases`;
  }
  if (node.kind === 'process' && node.action === 'call') {
    const name = (node.config.target_name as string | undefined)?.trim();
    return name || null;
  }
  return null;
}

/**
 * Strip a leading `$.` and any `[N]` / `[*]` selector, then return the
 * last dot-separated segment. Used by the catalog's auto-naming and by
 * `LoopFrame` to derive a singular noun from an `over` path.
 */
export function lastJsonPathSegment(path: string): string | null {
  const cleaned = path.replace(/^\$\.?/, '').replace(/\[[^\]]*\]/g, '');
  const parts = cleaned.split('.').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function humanise(token: string): string {
  return token.replace(/[_-]+/g, ' ').trim();
}

/**
 * Cheap English singulariser — good enough for path segments. Only
 * kicks in on common plural endings; users can always override with an
 * explicit label if the auto-derived one is wrong.
 */
export function singularise(noun: string): string {
  if (/(ses|xes|zes|ches|shes)$/.test(noun)) return noun.slice(0, -2);
  if (/ies$/.test(noun)) return noun.slice(0, -3) + 'y';
  if (/s$/.test(noun) && !/ss$/.test(noun)) return noun.slice(0, -1);
  return noun;
}

/**
 * One-line "what is this container actually doing" headline rendered under
 * the card title. Returns the iteration source for Loops, the predicate
 * for Branches (verbatim, prefixed with `if`), or the target subprocess
 * name for Call Subprocess. Returns null when the kind has no headline
 * or the relevant config field is empty (so the card stays clean rather
 * than showing "if undefined").
 */
export function containerHeadline(node: {
  kind: string;
  action: string;
  config: Record<string, unknown>;
}): string | null {
  if (node.kind === 'logic' && node.action === 'branch') {
    const expr = (node.config.expression as string | undefined)?.trim();
    return expr ? `if ${expr}` : null;
  }
  if (node.kind === 'logic' && node.action === 'loop') {
    const over = (node.config.over as string | undefined)?.trim();
    return over ? `iterating ${over}` : null;
  }
  if (node.kind === 'logic' && node.action === 'switch') {
    const cases = (node.config.cases as SwitchCase[] | undefined) ?? [];
    const withMatch = cases.filter((c) => (c.match || '').trim());
    if (withMatch.length === 0) return null;
    return `${withMatch.length}-way · default fallback`;
  }
  if (node.kind === 'process' && node.action === 'call') {
    const name = (node.config.target_name as string | undefined)?.trim();
    if (!name) return null;
    const mode = (node.config.mode as string | undefined) ?? 'once';
    if (mode === 'for-each') {
      const over = (node.config.over as string | undefined)?.trim() || '$.items';
      return `${name} · for each ${over}`;
    }
    return name;
  }
  return null;
}

/**
 * Loop output reduction modes — what flows out of the loop after every
 * iteration ran. `collect` is the default and the most useful (downstream
 * sees an array of every iteration's output); the other modes are escape
 * hatches for callers that don't need the full set.
 */
export type LoopReduce = 'collect' | 'last' | 'count' | 'none';

/**
 * One-line caption describing what the Loop emits to whatever runs after
 * it. Surfaced on the card and in the run plan so the downstream shape is
 * never a surprise. Returns null for non-Loop nodes.
 */
export function loopReduceCaption(node: {
  kind: string;
  action: string;
  config: Record<string, unknown>;
}): string | null {
  if (node.kind !== 'logic' || node.action !== 'loop') return null;
  const mode = (node.config.reduce as LoopReduce | undefined) ?? 'collect';
  switch (mode) {
    case 'collect':
      return '→ collects each output';
    case 'last':
      return '→ keeps last only';
    case 'count':
      return '→ emits iteration count';
    case 'none':
      return '→ discards output';
  }
}

/**
 * Per-branch caption rendered next to the branch label on the parent card,
 * so the user can read the structure of a Branch without stepping inside:
 *   ▸ TRUE   if $.status == "approved"
 *   ▸ FALSE  else
 * Loops have a single body and don't need a per-branch caption (the
 * iteration source is already in the headline).
 */
export function branchCaption(
  node: { kind: string; action: string; config: Record<string, unknown> },
  branchKey: string
): string | null {
  if (node.kind === 'logic' && node.action === 'branch') {
    const expr = (node.config.expression as string | undefined)?.trim();
    if (!expr) return null;
    return branchKey === 'true' ? `if ${expr}` : 'else';
  }
  return null;
}
