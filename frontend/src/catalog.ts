/**
 * Single source of truth for the node catalog.
 *
 * Every node in the integration graph is keyed by a two-axis discriminant
 * `{kind, action}`. Legacy single-axis `type` values are mapped through
 * LEGACY_TYPE_MAP on load (backend workflow has the matching shim).
 */

export type NodeGroup = 'HTTP' | 'Data' | 'Logic' | 'Process' | 'Output';

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
}

export const GROUPS: NodeGroup[] = ['HTTP', 'Data', 'Logic', 'Process', 'Output'];

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
      method: 'GET',
      url: '',
      headers: {},
      body: null,
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
    }
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
    preview: (cfg) => (cfg.expression as string) || 'No expression'
  },
  {
    kind: 'logic',
    action: 'branch',
    group: 'Logic',
    label: 'Branch',
    description: 'If/else two-way split',
    icon: '⎇',
    chip: CHIP_CONTAINER,
    accent: 'border-l-primary-500',
    defaultConfig: { expression: '$.status == "success"' },
    preview: (cfg) => `if ${(cfg.expression as string) || '—'}`,
    containerBranches: [
      { key: 'true', label: 'TRUE' },
      { key: 'false', label: 'FALSE' }
    ]
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
    defaultConfig: { over: '$.items' },
    preview: (cfg) => `for each ${(cfg.over as string) || '$.items'}`,
    containerBranches: [{ key: 'body', label: 'BODY' }]
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
    }
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
    preview: () => 'Output mapping'
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
  preview: () => '—'
};

export function lookupCatalog(kind: string, action: string): CatalogEntry {
  return CATALOG.find((e) => e.kind === kind && e.action === action) ?? FALLBACK;
}

/** DOM key used for both CSS class suffix and data-testid. */
export function nodeKey(kind: string, action: string): string {
  return `${kind}-${action}`;
}

/** Group CATALOG into a `{group: [entries]}` map for grouped UI rendering. */
export function groupedCatalog(): Record<NodeGroup, CatalogEntry[]> {
  const out = { HTTP: [], Data: [], Logic: [], Process: [], Output: [] } as Record<
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
export function seedBranches(kind: string, action: string): Record<string, unknown[]> | undefined {
  const entry = CATALOG.find((e) => e.kind === kind && e.action === action);
  if (!entry?.containerBranches) return undefined;
  const out: Record<string, unknown[]> = {};
  for (const b of entry.containerBranches) out[b.key] = [];
  return out;
}

/** Quick check: is this node kind/action a container? */
export function isContainerKind(kind: string, action: string): boolean {
  const entry = CATALOG.find((e) => e.kind === kind && e.action === action);
  return !!entry?.containerBranches;
}
