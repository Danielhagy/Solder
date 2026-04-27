import { create } from 'zustand';
import { LEGACY_TYPE_MAP, idPrefixFor, seedBranches } from '@/catalog';

export interface NodeConfig {
  [key: string]: unknown;
}

/**
 * A node in an integration graph. Position is defined by execution topology:
 *   - `stage` is the 1-indexed sequential step (stages run one after another)
 *   - `slot` is the 0-indexed vertical position within a stage
 *
 * All nodes in the same stage execute concurrently. The next stage doesn't start
 * until every node in the current stage finishes.
 */
export interface SolderNode {
  id: string;
  kind: string;
  action: string;
  stage: number;
  slot: number;
  config: NodeConfig;
  /**
   * Optional one-line user-authored title. When set it replaces the catalog
   * label as the card's primary heading; the kind/action becomes a small
   * subtype chip. Lets a Loop be read as "For each invoice" without
   * stepping inside, and a Branch as "Is approved?" instead of just
   * "Branch". Empty string is treated the same as missing.
   */
  label?: string;
  /**
   * Optional JSONPath-ish gating expression. If set, the node only executes when
   * the expression evaluates truthy against the current data; otherwise it is
   * skipped and the current data passes through unchanged.
   */
  when?: string;
  /**
   * Container-node sub-chains. For `logic.branch`: `{ true: [...], false: [...] }`.
   * For `logic.loop`: `{ body: [...] }`. Each list is itself a stages graph
   * (nodes with their own stage/slot scoped to that branch).
   *
   * v1: one level of nesting only — do not put a container inside a container.
   */
  branches?: Record<string, SolderNode[]>;
}

export interface IntegrationConfig {
  nodes: SolderNode[];
  variables: Record<string, unknown>;
  // Legacy — kept optional for backward-compatible deserialization only.
  // New integrations do not write this; stage topology is explicit.
  connections?: unknown[];
}

/** Test-run sample payload — what the runtime hands to the integration
 *  when the user fires a test from the right rail. Manual + webhook
 *  types carry one; schedule + on_event don't (their payload is system-
 *  generated). The sample is structured JSON, edited via the in-rail
 *  JSON builder. */
export type WebhookSample = {
  headers?: Record<string, string>;
  body?: unknown;
};

export type TriggerConfig =
  | { type: 'manual'; sample?: unknown }
  | { type: 'webhook'; secret?: string | null; sample?: WebhookSample }
  | { type: 'schedule'; cron: string; timezone?: string }
  | { type: 'on_event'; source: string };

/** One level of step-into focus. Empty path = root view. */
export interface FocusSegment {
  parentId: string;
  branchKey: string;
}

interface IntegrationState {
  nodes: SolderNode[];
  variables: Record<string, unknown>;
  selectedNodeId: string | null;
  /** True when the user clicked a trigger pill — the right rail shows
   *  the trigger editor instead of the node editor or run plan. Mutually
   *  exclusive with `selectedNodeId` (selecting a node clears this). */
  triggerSelected: boolean;
  trigger: TriggerConfig;
  /** Step-into focus path. Empty = root canvas view. */
  focusPath: FocusSegment[];

  /** Append a new stage at the end containing just this one node. */
  addNodeToNewStage: (node: Omit<SolderNode, 'id' | 'stage' | 'slot'>) => string;
  /** Add a node to an existing stage as its last slot. */
  addNodeToStage: (stage: number, node: Omit<SolderNode, 'id' | 'stage' | 'slot'>) => string;
  /** Move a node to another stage at the given slot (defaults to end). */
  moveNodeToStage: (id: string, toStage: number, toSlot?: number) => void;
  /** Replace slot assignments inside a stage. */
  reorderWithinStage: (stage: number, orderedIds: string[]) => void;

  updateNode: (id: string, updates: Partial<SolderNode>) => void;
  updateNodeConfig: (id: string, config: NodeConfig) => void;
  removeNode: (id: string) => void;

  /**
   * Atomic update for a Switch node — keeps `config.cases` and
   * `branches` in lockstep so the editor never has to write both on its
   * own (which would risk a render where the case array references a
   * key that doesn't exist in branches yet, or vice versa). Existing
   * branches are preserved by key; cases removed from the array drop
   * their branch contents along with them.
   */
  applySwitchCases: (
    id: string,
    cases: Array<{ key: string; match: string; label?: string }>
  ) => void;

  /** Branch-scoped adds: insert into a container's named branch. */
  addNodeToBranchNewStage: (
    parentId: string,
    branchKey: string,
    node: Omit<SolderNode, 'id' | 'stage' | 'slot'>
  ) => string;
  addNodeToBranchStage: (
    parentId: string,
    branchKey: string,
    stage: number,
    node: Omit<SolderNode, 'id' | 'stage' | 'slot'>
  ) => string;

  /**
   * Move an existing node across scopes (root ↔ branch, or branch ↔ branch).
   * `toOwner` null means root; otherwise `{parentId, branchKey}` identifies
   * the destination container branch. A `newStage` marker (half-offset trick)
   * is supported via the `stage` value — callers pass e.g. `targetStage*10-5`
   * to "insert before". If the move would create a cycle (dropping a
   * container into its own descendant) the move is refused silently.
   */
  moveNodeCrossScope: (
    id: string,
    toOwner: { parentId: string; branchKey: string } | null,
    toStage: number,
    toSlot?: number
  ) => void;

  selectNode: (id: string | null) => void;
  /** Open the trigger editor in the right rail. Clears node selection. */
  selectTrigger: () => void;
  /** Replace the global variables map (used by the trigger editor's
   *  variables section). */
  setVariables: (v: Record<string, unknown>) => void;
  loadConfig: (config: IntegrationConfig) => void;
  reset: () => void;
  toConfig: () => IntegrationConfig;

  setTrigger: (t: TriggerConfig) => void;

  /** Replace the step-into focus path (empty array returns to root). */
  setFocusPath: (path: FocusSegment[]) => void;
  /** Push a new focus segment (drill into a container branch). */
  pushFocus: (seg: FocusSegment) => void;
  /** Pop the deepest focus segment. No-op at root. */
  popFocus: () => void;
}

const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

/**
 * Walks the integration tree to find `targetId`'s nesting depth.
 * Depth = number of containers we'd cross to reach the node from root.
 * Root-level node = 0. Inside one Loop body = 1. Two levels deep = 2.
 *
 * Used by `generateStepId` so the new code's `_LEV<n>` suffix matches
 * the actual depth the node is being inserted at — even when the
 * insertion target is a container several levels deep.
 *
 * Returns `null` if not found.
 */
function depthOf(roots: SolderNode[], targetId: string, currentDepth = 0): number | null {
  for (const n of roots) {
    if (n.id === targetId) return currentDepth;
    if (n.branches) {
      for (const list of Object.values(n.branches)) {
        const d = depthOf(list, targetId, currentDepth + 1);
        if (d !== null) return d;
      }
    }
  }
  return null;
}

/**
 * Generate a human-readable step ID like `API_1`, `FILTER_2_LEV1`.
 *
 * Per the spec:
 *   - `<KIND_PREFIX>_<N>` at root scope (`API_1`, `FILTER_2`)
 *   - `<KIND_PREFIX>_<N>_LEV<depth>` inside a container body
 *     (`FILTER_1_LEV1` for the first filter inside one Loop)
 *   - The counter `<N>` is scoped to the level — siblings at the same
 *     scope with the same prefix and suffix collide; siblings in
 *     different scopes do not.
 *
 * Existing UUIDs in saved integrations stay valid (the runtime
 * resolves either form); only NEW nodes added via the canvas get
 * codes. Mixed-mode is acceptable until a future migration pass
 * rewrites legacy UUIDs to codes.
 */
function generateStepId(
  kind: string,
  action: string,
  siblings: SolderNode[],
  depth: number
): string {
  const prefix = idPrefixFor(kind, action);
  const suffix = depth > 0 ? `_LEV${depth}` : '';
  // Collect the integer indices already used at this level by nodes of
  // the same kind. We scan ALL siblings (not just same-prefix) but
  // filter by the prefix string match — defensive against future
  // prefix overlaps (`B64ENC` vs `B64ENC_DECODE`-like collisions).
  const used = new Set<number>();
  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}_(\\d+)${suffix ? `${escapeRegExp(suffix)}` : ''}$`
  );
  for (const sib of siblings) {
    const m = sib.id.match(pattern);
    if (m) used.add(Number(m[1]));
  }
  // Pick the smallest free positive integer.
  let n = 1;
  while (used.has(n)) n++;
  return `${prefix}_${n}${suffix}`;
}

/** Escape a string for safe use in RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalize a raw node payload — accepts legacy `type`, legacy `position`, and new `{stage, slot}`. */
function normalizeRawNode(raw: Record<string, unknown>): Omit<SolderNode, 'stage' | 'slot'> | null {
  const id = typeof raw.id === 'string' ? raw.id : newId('node');
  const config = (raw.config as NodeConfig) ?? {};

  let kind = typeof raw.kind === 'string' ? (raw.kind as string) : '';
  let action = typeof raw.action === 'string' ? (raw.action as string) : '';
  if (!kind || !action) {
    const legacy = raw.type as string | undefined;
    if (legacy && LEGACY_TYPE_MAP[legacy]) {
      kind = LEGACY_TYPE_MAP[legacy].kind;
      action = LEGACY_TYPE_MAP[legacy].action;
    }
  }
  if (!kind || !action) return null;
  const when = typeof raw.when === 'string' ? (raw.when as string) : undefined;
  const label = typeof raw.label === 'string' ? (raw.label as string) : undefined;

  // Recursively normalize nested branches (container nodes).
  let branches: Record<string, SolderNode[]> | undefined;
  const rawBranches = raw.branches as Record<string, unknown> | undefined;
  if (rawBranches && typeof rawBranches === 'object') {
    branches = {};
    for (const [key, val] of Object.entries(rawBranches)) {
      if (!Array.isArray(val)) continue;
      // Walk raw + base in lockstep so a sub-node that fails to normalize
      // doesn't desync the index used to read stage/slot off the raw entry.
      // Previously: filter-then-index pulled the wrong raw row whenever any
      // entry returned null from `normalizeRawNode`.
      const subStaged: SolderNode[] = [];
      let cursor = 0;
      for (const r of val as Record<string, unknown>[]) {
        const base = normalizeRawNode(r);
        if (base === null) continue;
        subStaged.push({
          ...base,
          stage: typeof r.stage === 'number' ? (r.stage as number) : 1,
          slot: typeof r.slot === 'number' ? (r.slot as number) : cursor
        });
        cursor += 1;
      }
      branches[key] = compact(subStaged);
    }
  }

  return {
    id,
    kind,
    action,
    config,
    ...(label ? { label } : {}),
    ...(when ? { when } : {}),
    ...(branches ? { branches } : {})
  };
}

interface LegacyConnection {
  from: string;
  to: string;
}

/**
 * Derive `{stage, slot}` assignments for legacy integrations saved before stages.
 * Stage = 1 + max(stage of predecessors), so disconnected roots all start at stage 1.
 * Slot = insertion order among same-stage peers.
 */
function deriveStagesFromLegacy(
  bases: Array<Omit<SolderNode, 'stage' | 'slot'>>,
  connections: LegacyConnection[]
): SolderNode[] {
  const preds = new Map<string, string[]>();
  for (const c of connections) {
    if (!c?.from || !c?.to) continue;
    const list = preds.get(c.to) ?? [];
    list.push(c.from);
    preds.set(c.to, list);
  }
  const stageOf = new Map<string, number>();
  const visiting = new Set<string>();
  function stageFor(id: string): number {
    const cached = stageOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      stageOf.set(id, 1); // cycle break
      return 1;
    }
    visiting.add(id);
    const ps = preds.get(id) ?? [];
    const stage = ps.length === 0 ? 1 : 1 + Math.max(...ps.map(stageFor));
    visiting.delete(id);
    stageOf.set(id, stage);
    return stage;
  }

  const withStage = bases.map((n) => ({ ...n, stage: stageFor(n.id) }));
  // Assign slots deterministically by original-array order within each stage.
  const slotCursors = new Map<number, number>();
  return withStage.map((n) => {
    const cursor = slotCursors.get(n.stage) ?? 0;
    slotCursors.set(n.stage, cursor + 1);
    return { ...n, slot: cursor };
  });
}

/**
 * Walk the full node tree (root + every branch), applying `fn` to each node.
 * If `fn` returns null the node is dropped. Any branch whose list changed is
 * `compact`ed automatically so stage/slot numbering stays consistent.
 *
 * This recurses into branches BEFORE applying `fn`, so container nodes receive
 * their transformed children via the mutation we apply here.
 */
function mapNodesDeep(
  nodes: SolderNode[],
  fn: (n: SolderNode) => SolderNode | null
): SolderNode[] {
  const transformed: SolderNode[] = [];
  for (const n of nodes) {
    let node: SolderNode = n;
    if (node.branches) {
      const nextBranches: Record<string, SolderNode[]> = {};
      let anyChanged = false;
      for (const [k, list] of Object.entries(node.branches)) {
        const newList = mapNodesDeep(list, fn);
        if (newList !== list) anyChanged = true;
        nextBranches[k] = newList;
      }
      if (anyChanged) node = { ...node, branches: nextBranches };
    }
    const result = fn(node);
    if (result !== null) transformed.push(result);
  }
  return compact(transformed);
}

/** Reflow stage/slot assignments: compact stage numbers and slot indices so there are no gaps. */
function compact(nodes: SolderNode[]): SolderNode[] {
  // Group by stage
  const byStage = new Map<number, SolderNode[]>();
  for (const n of nodes) {
    const list = byStage.get(n.stage) ?? [];
    list.push(n);
    byStage.set(n.stage, list);
  }
  // Sort stage keys ascending, remap to 1..N
  const sortedStages = [...byStage.keys()].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  sortedStages.forEach((s, i) => remap.set(s, i + 1));

  const out: SolderNode[] = [];
  for (const oldStage of sortedStages) {
    const newStage = remap.get(oldStage)!;
    const stageNodes = (byStage.get(oldStage) ?? []).slice().sort((a, b) => a.slot - b.slot);
    stageNodes.forEach((n, slot) => {
      out.push({ ...n, stage: newStage, slot });
    });
  }
  return out;
}

/**
 * Walk the tree, extracting the node with the given id (if found) and
 * returning a tree without it. Branches are compacted on the way out so
 * stage/slot stay tight after the extraction.
 */
function extractNode(
  nodes: SolderNode[],
  id: string
): { tree: SolderNode[]; extracted: SolderNode | null } {
  let extracted: SolderNode | null = null;
  function walk(list: SolderNode[]): SolderNode[] {
    const result: SolderNode[] = [];
    for (const n of list) {
      if (n.id === id) {
        extracted = n;
        continue;
      }
      let next = n;
      if (n.branches) {
        const nextBranches: Record<string, SolderNode[]> = {};
        for (const [k, v] of Object.entries(n.branches)) {
          nextBranches[k] = compact(walk(v));
        }
        next = { ...n, branches: nextBranches };
      }
      result.push(next);
    }
    return result;
  }
  const tree = compact(walk(nodes));
  return { tree, extracted };
}

/** True if `target` is contained anywhere inside `container`'s branches. */
function containsDescendant(container: SolderNode, targetId: string): boolean {
  if (!container.branches) return false;
  for (const list of Object.values(container.branches)) {
    for (const n of list) {
      if (n.id === targetId) return true;
      if (containsDescendant(n, targetId)) return true;
    }
  }
  return false;
}

/** Insert a node into a flat list at the given stage/slot, sliding peers. */
function insertIntoStageList(
  list: SolderNode[],
  node: SolderNode,
  stage: number,
  slot?: number
): SolderNode[] {
  const peers = list.filter((n) => n.stage === stage).sort((a, b) => a.slot - b.slot);
  const others = list.filter((n) => n.stage !== stage);
  const insertAt =
    slot === undefined ? peers.length : Math.max(0, Math.min(slot, peers.length));
  const staged: SolderNode[] = [];
  for (let i = 0; i < peers.length; i++) {
    if (i === insertAt) staged.push({ ...node, stage, slot: -1 });
    staged.push(peers[i]);
  }
  if (insertAt === peers.length) staged.push({ ...node, stage, slot: -1 });
  const renumbered = staged.map((n, i) => ({ ...n, slot: i }));
  return compact([...others, ...renumbered]);
}

const initialState = {
  nodes: [] as SolderNode[],
  variables: {} as Record<string, unknown>,
  selectedNodeId: null as string | null,
  triggerSelected: false,
  trigger: { type: 'manual' } as TriggerConfig,
  focusPath: [] as FocusSegment[]
};

export const useIntegrationStore = create<IntegrationState>((set, get) => ({
  ...initialState,

  addNodeToNewStage: (node) => {
    const seeded = seedBranches(node.kind, node.action, node.config);
    let assignedId = '';
    set((s) => {
      // Generate the human-readable code at the same scope as the new
      // node — root level here, so depth=0 (no `_LEV<n>` suffix). Done
      // inside the setter so the generator sees the latest sibling
      // list (avoids races where two rapid adds get the same code).
      const id = generateStepId(node.kind, node.action, s.nodes, 0);
      assignedId = id;
      const maxStage = s.nodes.reduce((m, n) => Math.max(m, n.stage), 0);
      const newNode: SolderNode = {
        ...node,
        id,
        stage: maxStage + 1,
        slot: 0,
        ...(seeded ? { branches: seeded as Record<string, SolderNode[]> } : {})
      };
      return { nodes: [...s.nodes, newNode] };
    });
    return assignedId;
  },

  addNodeToStage: (stage, node) => {
    const seeded = seedBranches(node.kind, node.action, node.config);
    let assignedId = '';
    set((s) => {
      const id = generateStepId(node.kind, node.action, s.nodes, 0);
      assignedId = id;
      const peers = s.nodes.filter((n) => n.stage === stage);
      const slot = peers.length;
      const newNode: SolderNode = {
        ...node,
        id,
        stage,
        slot,
        ...(seeded ? { branches: seeded as Record<string, SolderNode[]> } : {})
      };
      // `compact` re-anchors fractional stage markers (e.g. 1.5 from a
      // drop on the gap-after-1) to integer positions and shifts later
      // stages out of the way. Integer stages are unaffected.
      return { nodes: compact([...s.nodes, newNode]) };
    });
    return assignedId;
  },

  moveNodeToStage: (id, toStage, toSlot) =>
    set((s) => {
      const moving = s.nodes.find((n) => n.id === id);
      if (!moving) return s;
      if (moving.stage === toStage && toSlot === undefined) return s;

      // Remove from current stage
      const remainingInOld = s.nodes
        .filter((n) => n.stage === moving.stage && n.id !== id)
        .sort((a, b) => a.slot - b.slot)
        .map((n, i) => ({ ...n, slot: i }));

      // Insert into target stage at the requested slot
      const targetPeers = s.nodes
        .filter((n) => n.stage === toStage && n.id !== id)
        .sort((a, b) => a.slot - b.slot);
      const insertAt = toSlot === undefined ? targetPeers.length : Math.max(0, Math.min(toSlot, targetPeers.length));
      const newStagePeers: SolderNode[] = [];
      for (let i = 0; i < targetPeers.length; i++) {
        if (i === insertAt) newStagePeers.push({ ...moving, stage: toStage, slot: -1 });
        newStagePeers.push(targetPeers[i]);
      }
      if (insertAt === targetPeers.length) {
        newStagePeers.push({ ...moving, stage: toStage, slot: -1 });
      }
      const renumberedTarget = newStagePeers.map((n, i) => ({ ...n, slot: i }));

      // Everything else stays put
      const others = s.nodes.filter(
        (n) => n.id !== id && n.stage !== moving.stage && n.stage !== toStage
      );

      return { nodes: compact([...others, ...remainingInOld, ...renumberedTarget]) };
    }),

  reorderWithinStage: (stage, orderedIds) =>
    set((s) => {
      const peers = s.nodes.filter((n) => n.stage === stage);
      const byId = new Map(peers.map((n) => [n.id, n]));
      const reordered = orderedIds
        .map((id, i) => {
          const p = byId.get(id);
          return p ? { ...p, slot: i } : null;
        })
        .filter((n): n is SolderNode => n !== null);
      // Append any peers we didn't mention
      for (const n of peers) {
        if (!orderedIds.includes(n.id)) reordered.push({ ...n, slot: reordered.length });
      }
      const others = s.nodes.filter((n) => n.stage !== stage);
      return { nodes: [...others, ...reordered] };
    }),

  updateNode: (id, updates) =>
    set((s) => ({
      nodes: mapNodesDeep(s.nodes, (n) => (n.id === id ? { ...n, ...updates } : n))
    })),

  updateNodeConfig: (id, config) =>
    set((s) => ({
      nodes: mapNodesDeep(s.nodes, (n) =>
        n.id === id ? { ...n, config: { ...n.config, ...config } } : n
      )
    })),

  applySwitchCases: (id, cases) =>
    set((s) => ({
      nodes: mapNodesDeep(s.nodes, (n) => {
        if (n.id !== id) return n;
        // Preserve existing branch nodes for keys that survive; drop
        // branches whose case was removed; seed empty arrays for any
        // newly-added cases. `default` is always present and untouched.
        const prev = n.branches ?? {};
        const next: Record<string, SolderNode[]> = {
          default: prev.default ?? []
        };
        for (const c of cases) {
          next[c.key] = prev[c.key] ?? [];
        }
        return {
          ...n,
          config: { ...n.config, cases },
          branches: next
        };
      })
    })),

  removeNode: (id) =>
    set((s) => ({
      nodes: mapNodesDeep(s.nodes, (n) => (n.id === id ? null : n)),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId
    })),

  addNodeToBranchNewStage: (parentId, branchKey, node) => {
    const seeded = seedBranches(node.kind, node.action, node.config);
    let assignedId = '';
    set((s) => {
      // Compute depth from the parent's position in the tree, so the
      // child's `_LEV<n>` suffix matches its actual nesting (parent's
      // depth + 1 for the child's branch).
      const parentDepth = depthOf(s.nodes, parentId) ?? 0;
      const childDepth = parentDepth + 1;
      return {
        nodes: mapNodesDeep(s.nodes, (n) => {
          if (n.id !== parentId || !n.branches) return n;
          const list = n.branches[branchKey] ?? [];
          if (!assignedId) {
            assignedId = generateStepId(node.kind, node.action, list, childDepth);
          }
          const maxStage = list.reduce((m, x) => Math.max(m, x.stage), 0);
          const child: SolderNode = {
            ...node,
            id: assignedId,
            stage: maxStage + 1,
            slot: 0,
            ...(seeded ? { branches: seeded as Record<string, SolderNode[]> } : {})
          };
          return { ...n, branches: { ...n.branches, [branchKey]: [...list, child] } };
        })
      };
    });
    return assignedId;
  },

  addNodeToBranchStage: (parentId, branchKey, stage, node) => {
    const seeded = seedBranches(node.kind, node.action, node.config);
    let assignedId = '';
    set((s) => {
      const parentDepth = depthOf(s.nodes, parentId) ?? 0;
      const childDepth = parentDepth + 1;
      return {
        nodes: mapNodesDeep(s.nodes, (n) => {
          if (n.id !== parentId || !n.branches) return n;
          const list = n.branches[branchKey] ?? [];
          if (!assignedId) {
            assignedId = generateStepId(node.kind, node.action, list, childDepth);
          }
          const peers = list.filter((x) => x.stage === stage);
          const child: SolderNode = {
            ...node,
            id: assignedId,
            stage,
            slot: peers.length,
            ...(seeded ? { branches: seeded as Record<string, SolderNode[]> } : {})
          };
          // Compact the branch list so fractional stage markers (e.g. 1.5
          // from a gap drop) renumber to integers and bump later stages.
          return {
            ...n,
            branches: { ...n.branches, [branchKey]: compact([...list, child]) }
          };
        })
      };
    });
    return assignedId;
  },

  moveNodeCrossScope: (id, toOwner, toStage, toSlot) =>
    set((s) => {
      const { tree, extracted } = extractNode(s.nodes, id);
      if (!extracted) return s;

      // Cycle guard: the extracted node cannot be dropped into its own
      // descendants (including becoming its own grandchild). The container
      // must still exist somewhere — but since we already pulled it out,
      // we check the branches of `extracted` itself.
      if (toOwner && containsDescendant(extracted, toOwner.parentId)) {
        return s; // refuse — would create a cycle
      }

      if (!toOwner) {
        return { nodes: insertIntoStageList(tree, extracted, toStage, toSlot) };
      }

      const nextNodes = mapNodesDeep(tree, (n) => {
        if (n.id !== toOwner.parentId || !n.branches) return n;
        const list = n.branches[toOwner.branchKey] ?? [];
        const updated = insertIntoStageList(list, extracted, toStage, toSlot);
        return {
          ...n,
          branches: { ...n.branches, [toOwner.branchKey]: updated }
        };
      });
      return { nodes: nextNodes };
    }),

  selectNode: (id) => set({ selectedNodeId: id, triggerSelected: false }),
  selectTrigger: () => set({ triggerSelected: true, selectedNodeId: null }),
  setVariables: (v) => set({ variables: v }),

  loadConfig: (config) => {
    // Reset focus when loading a new integration.
    set({ focusPath: [] });
    const incoming = (config.nodes ?? []) as unknown as Record<string, unknown>[];
    const bases = incoming
      .map(normalizeRawNode)
      .filter((n): n is Omit<SolderNode, 'stage' | 'slot'> => n !== null);

    // If the incoming payload already has stage/slot, trust it; otherwise derive.
    const hasStages = incoming.some(
      (raw) => typeof raw.stage === 'number' && typeof raw.slot === 'number'
    );
    let staged: SolderNode[];
    if (hasStages) {
      staged = bases.map((base, i) => {
        const raw = incoming[i];
        return {
          ...base,
          stage: typeof raw.stage === 'number' ? (raw.stage as number) : 1,
          slot: typeof raw.slot === 'number' ? (raw.slot as number) : 0
        };
      });
    } else {
      const legacyConns = (config.connections ?? []) as LegacyConnection[];
      staged = deriveStagesFromLegacy(bases, legacyConns);
    }

    set({
      nodes: compact(staged),
      variables: config.variables ?? {},
      selectedNodeId: null,
      triggerSelected: false
    });
  },

  reset: () => set({ ...initialState }),

  toConfig: () => {
    const s = get();
    return { nodes: s.nodes, variables: s.variables };
  },

  setTrigger: (t) => set({ trigger: t }),

  setFocusPath: (path) => set({ focusPath: path }),
  pushFocus: (seg) => set((s) => ({ focusPath: [...s.focusPath, seg] })),
  popFocus: () => set((s) => ({ focusPath: s.focusPath.slice(0, -1) }))
}));

export const selectedNode = (state: IntegrationState): SolderNode | null => {
  if (!state.selectedNodeId) return null;
  return findNodeDeep(state.nodes, state.selectedNodeId);
};

/**
 * Walk root + branches looking for a node by id. Necessary because the
 * selection selector used to only check root, which meant clicking a node
 * inside a Loop body or Branch arm produced an "invisible" selection
 * (testid changed but PropertiesPanel didn't render the editor).
 */
function findNodeDeep(nodes: SolderNode[], id: string): SolderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.branches) {
      for (const list of Object.values(n.branches)) {
        const hit = findNodeDeep(list, id);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * What can a node at `nodeId` reference? Walks the integration tree,
 * applies the cross-scope rules from `qa/artifacts/ux-review/data-
 * references/PLAN.md` §5, and returns a structured scope the
 * `RefPicker` dropdown can render.
 *
 * The algorithm:
 *   1. Find `nodeId` in the tree, recording the path of containers
 *      we crossed to get there (root → Loop → Branch arm → …).
 *   2. At each ancestor frame, gather the **siblings whose stage <
 *      the frame's pivot** — those are the upstream steps visible
 *      from inside `nodeId`. We DON'T expose siblings further down
 *      the chain (different stage in the same scope) because they
 *      run in parallel and their output isn't ordered before us.
 *   3. Add `$item` / `$index` for each Loop ancestor we passed
 *      through.
 *   4. Add declared `BranchVariable[]` / `LoopAppend[]` from
 *      *outer-finished* containers — only visible AFTER we leave
 *      the container, which for the picker means: declared
 *      variables show up at the root if a Branch/Loop completes
 *      before us; they DON'T show inside the same container's
 *      arms. v1 collects all declarations from root-level
 *      ancestors; finer scope rules can land in v2.
 *   5. Always append `$.run.*` metadata.
 *
 * Returns `null` when the node isn't found (e.g. the editor is open
 * for a node that's been deleted in another tab).
 */
export interface ReferenceableStep {
  /** Stable id used in `$.steps.<id>.output…` token. */
  id: string;
  /** Display label — user `label`, falls back to derived label, then catalog kind. */
  label: string;
  /** Stage number for ordering. */
  stage: number;
  /** Original kind/action so the picker can show the catalog icon. */
  kind: string;
  action: string;
}

export interface ReferenceableVariable {
  name: string;
  description?: string;
  /** Where it was declared — for the picker's "set in step 03 (If/Else)" caption. */
  declaredInStepId: string;
  declaredInStepLabel: string;
  /** Distinguishes variable types in the UI ("variable" vs "append"). */
  origin: 'branch-variable' | 'loop-append';
}

/**
 * The integration's trigger surfaces as a Stage-1 drill-in source. Its
 * output fields depend on `trigger.type` — webhook gets headers/body/
 * query, schedule gets the fired-at timestamp, manual gets the whole
 * input payload. The picker emits `{{$.trigger.<path>}}` tokens for
 * trigger fields, distinct from `{{$.steps.<id>.output.<path>}}` for
 * upstream-step output.
 */
export interface ReferenceableTrigger {
  type: TriggerConfig['type'];
  label: string;
  outputs: Array<{ path: string; description: string }>;
}

export interface ReferenceableScope {
  /** The integration's trigger as a drillable source. */
  trigger: ReferenceableTrigger;
  /** Upstream steps visible from `nodeId`'s position. */
  steps: ReferenceableStep[];
  /** Declared variables / loop appends from completed outer containers. */
  variables: ReferenceableVariable[];
  /**
   * Loop iteration scope, only present when `nodeId` lives inside a
   * Loop body. Picker shows `$item` and `$index` rows when this is
   * set.
   */
  loopScope?: { loopStepId: string; loopLabel: string };
  /**
   * Run metadata is always present. Stable reference; the picker can
   * inline this list rather than fetch it from the store.
   */
  runMeta: Array<{ path: string; description: string }>;
}

const RUN_META_REFS: ReferenceableScope['runMeta'] = [
  { path: 'id', description: 'Run ID (UUID)' },
  { path: 'environment', description: 'sandbox or production' },
  { path: 'started_at', description: 'ISO timestamp when this run began' }
];

/**
 * Output schema for the trigger payload, keyed by trigger type. Webhook
 * is the richest because the request shape is well-known; manual
 * exposes the user-supplied input as an opaque blob; schedule exposes
 * the firing context. `on_event` is disabled in the picker but listed
 * here so the type is exhaustive.
 */
function triggerOutputs(
  type: TriggerConfig['type']
): ReferenceableTrigger['outputs'] {
  switch (type) {
    case 'webhook':
      return [
        { path: 'body', description: 'Decoded JSON request body' },
        { path: 'headers', description: 'Request headers as an object' },
        { path: 'query', description: 'Query string params as an object' },
        { path: 'method', description: 'HTTP method (POST, etc.)' },
        { path: 'path', description: 'Request path' }
      ];
    case 'schedule':
      return [
        { path: 'scheduled_at', description: 'ISO timestamp the run was scheduled for' },
        { path: 'cron', description: 'Cron expression that fired' },
        { path: 'timezone', description: 'IANA timezone of the schedule' }
      ];
    case 'manual':
      return [
        { path: 'input', description: 'The trigger input payload (opaque)' }
      ];
    case 'on_event':
      return [];
  }
}

export function getReferenceableScope(
  state: IntegrationState,
  nodeId: string
): ReferenceableScope | null {
  // Recursive search; collects the ancestor path as we descend so the
  // returned scope can reflect Loop / Branch context.
  type Frame = {
    /** Sibling list this scope holds. */
    siblings: SolderNode[];
    /** When inside a container, the parent node that owns this branch. null at root. */
    parent: SolderNode | null;
    /** Branch key when inside a container (true / false / body / case_*). */
    branchKey: string | null;
  };

  function walk(frame: Frame, path: Frame[]): Frame[] | null {
    for (const n of frame.siblings) {
      if (n.id === nodeId) return [...path, frame];
      if (n.branches) {
        for (const [bk, list] of Object.entries(n.branches)) {
          const sub: Frame = { siblings: list, parent: n, branchKey: bk };
          const hit = walk(sub, [...path, frame]);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  const rootFrame: Frame = { siblings: state.nodes, parent: null, branchKey: null };
  const trail = walk(rootFrame, []);
  if (!trail) return null;

  // The deepest frame is the one containing `nodeId` itself; siblings
  // there with strictly-lower stage number are the immediate upstream.
  // Each shallower frame contributes its earlier-stage siblings up to
  // (but not including) the container that wraps the current frame.
  const target = findNodeDeep(state.nodes, nodeId);
  if (!target) return null;

  const steps: ReferenceableStep[] = [];
  const variables: ReferenceableVariable[] = [];
  let loopScope: ReferenceableScope['loopScope'] | undefined;

  // Walk frames outermost-first so step lists are roughly chronological.
  for (let i = 0; i < trail.length; i++) {
    const frame = trail[i];
    const isDeepestFrame = i === trail.length - 1;
    // Within `frame.siblings`, "upstream of the current path step" is:
    //   - on the deepest frame: any node whose stage < target.stage
    //   - on shallower frames: any node whose stage < the *parent's*
    //     stage (the parent is the one that owns the branch we
    //     descended into; siblings at the parent's stage and beyond
    //     run in parallel or after us)
    const pivotStage = isDeepestFrame
      ? target.stage
      : trail[i + 1].parent?.stage ?? Number.POSITIVE_INFINITY;

    for (const sibling of frame.siblings) {
      if (sibling.id === nodeId) continue;
      if (sibling.stage >= pivotStage) continue;
      steps.push(stepRef(sibling));

      // Collect declared variables from completed Branch/Switch nodes
      // and loop appends from completed Loops. Cheap heuristic: any
      // upstream container at this scope is "completed" by the time
      // `nodeId` runs.
      const declaredVars = (sibling.config.variables as
        | { name: string; description?: string }[]
        | undefined) ?? [];
      for (const v of declaredVars) {
        if (!v.name?.trim()) continue;
        variables.push({
          name: v.name,
          description: v.description,
          declaredInStepId: sibling.id,
          declaredInStepLabel: stepRef(sibling).label,
          origin: 'branch-variable'
        });
      }
      const declaredAppends = (sibling.config.appends as
        | { name: string; description?: string }[]
        | undefined) ?? [];
      for (const a of declaredAppends) {
        if (!a.name?.trim()) continue;
        variables.push({
          name: a.name,
          description: a.description,
          declaredInStepId: sibling.id,
          declaredInStepLabel: stepRef(sibling).label,
          origin: 'loop-append'
        });
      }
    }

    // If the *next* frame's parent is a Loop, we're crossing into its
    // body — record loopScope. Only the innermost wins; the picker
    // surfaces $item / $index from the directly-enclosing loop.
    if (i + 1 < trail.length) {
      const nextParent = trail[i + 1].parent;
      if (nextParent && nextParent.kind === 'logic' && nextParent.action === 'loop') {
        loopScope = {
          loopStepId: nextParent.id,
          loopLabel: stepRef(nextParent).label
        };
      }
    }
  }

  return {
    trigger: {
      type: state.trigger.type,
      label: 'Trigger',
      outputs: triggerOutputs(state.trigger.type)
    },
    steps,
    variables,
    loopScope,
    runMeta: RUN_META_REFS
  };
}

/** Tiny helper — picker needs a stable label for each upstream step. */
function stepRef(node: SolderNode): ReferenceableStep {
  // Don't import the catalog here to avoid cycles; the picker can
  // re-resolve the catalog entry for icons and rich metadata.
  return {
    id: node.id,
    label: node.label?.trim() || `Step ${String(node.stage).padStart(2, '0')}`,
    stage: node.stage,
    kind: node.kind,
    action: node.action
  };
}

/** Group the current nodes by stage, returning stages in ascending order with their slotted nodes. */
export function groupByStage(nodes: SolderNode[]): Array<{ stage: number; nodes: SolderNode[] }> {
  const byStage = new Map<number, SolderNode[]>();
  for (const n of nodes) {
    const list = byStage.get(n.stage) ?? [];
    list.push(n);
    byStage.set(n.stage, list);
  }
  return [...byStage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stage, list]) => ({ stage, nodes: list.slice().sort((a, b) => a.slot - b.slot) }));
}
