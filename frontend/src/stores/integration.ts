import { create } from 'zustand';
import { LEGACY_TYPE_MAP, seedBranches } from '@/catalog';

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

export type TriggerConfig =
  | { type: 'manual' }
  | { type: 'webhook'; secret?: string | null }
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

  // Recursively normalize nested branches (container nodes).
  let branches: Record<string, SolderNode[]> | undefined;
  const rawBranches = raw.branches as Record<string, unknown> | undefined;
  if (rawBranches && typeof rawBranches === 'object') {
    branches = {};
    for (const [key, val] of Object.entries(rawBranches)) {
      if (!Array.isArray(val)) continue;
      const subBases = (val as Record<string, unknown>[])
        .map(normalizeRawNode)
        .filter((n): n is Omit<SolderNode, 'stage' | 'slot'> => n !== null);
      // Branches also carry stage/slot scoped to the branch; trust them if present.
      const subStaged: SolderNode[] = subBases.map((base, i) => {
        const r = val[i] as Record<string, unknown>;
        return {
          ...base,
          stage: typeof r.stage === 'number' ? (r.stage as number) : 1,
          slot: typeof r.slot === 'number' ? (r.slot as number) : i
        };
      });
      branches[key] = compact(subStaged);
    }
  }

  return {
    id,
    kind,
    action,
    config,
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
  trigger: { type: 'manual' } as TriggerConfig,
  focusPath: [] as FocusSegment[]
};

export const useIntegrationStore = create<IntegrationState>((set, get) => ({
  ...initialState,

  addNodeToNewStage: (node) => {
    const id = newId('node');
    const seeded = seedBranches(node.kind, node.action);
    set((s) => {
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
    return id;
  },

  addNodeToStage: (stage, node) => {
    const id = newId('node');
    const seeded = seedBranches(node.kind, node.action);
    set((s) => {
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
    return id;
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

  removeNode: (id) =>
    set((s) => ({
      nodes: mapNodesDeep(s.nodes, (n) => (n.id === id ? null : n)),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId
    })),

  addNodeToBranchNewStage: (parentId, branchKey, node) => {
    const id = newId('node');
    const seeded = seedBranches(node.kind, node.action);
    set((s) => ({
      nodes: mapNodesDeep(s.nodes, (n) => {
        if (n.id !== parentId || !n.branches) return n;
        const list = n.branches[branchKey] ?? [];
        const maxStage = list.reduce((m, x) => Math.max(m, x.stage), 0);
        const child: SolderNode = {
          ...node,
          id,
          stage: maxStage + 1,
          slot: 0,
          ...(seeded ? { branches: seeded as Record<string, SolderNode[]> } : {})
        };
        return { ...n, branches: { ...n.branches, [branchKey]: [...list, child] } };
      })
    }));
    return id;
  },

  addNodeToBranchStage: (parentId, branchKey, stage, node) => {
    const id = newId('node');
    const seeded = seedBranches(node.kind, node.action);
    set((s) => ({
      nodes: mapNodesDeep(s.nodes, (n) => {
        if (n.id !== parentId || !n.branches) return n;
        const list = n.branches[branchKey] ?? [];
        const peers = list.filter((x) => x.stage === stage);
        const child: SolderNode = {
          ...node,
          id,
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
    }));
    return id;
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

  selectNode: (id) => set({ selectedNodeId: id }),

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
      selectedNodeId: null
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

export const selectedNode = (state: IntegrationState) =>
  state.selectedNodeId ? state.nodes.find((n) => n.id === state.selectedNodeId) ?? null : null;

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
