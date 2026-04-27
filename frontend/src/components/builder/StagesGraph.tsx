import { useState, type DragEvent as ReactDragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useIntegrationStore,
  groupByStage,
  type SolderNode
} from '@/stores/integration';
import {
  CATALOG,
  branchCaption,
  containerHeadline,
  defaultContainerLabel,
  isContainerKind,
  loopReduceCaption,
  lookupCatalog,
  nodeKey,
  resolveBranches
} from '@/catalog';
import { DND_MIME_EXISTING, DND_MIME_NEW } from './dnd';
import TriggerCard from './TriggerCard';

/**
 * Configuration-completeness derived per node kind. Used to drive the
 * status pip on each node card so users can scan a stage row and see
 * "what's still empty" without opening the properties panel.
 *
 * `idle` is the no-information state — currently unused for new nodes
 * (we default to `incomplete` or `ready` based on config), but reserved
 * for future "never run" semantics once run history reaches the canvas.
 */
type NodeStatus = 'idle' | 'incomplete' | 'ready' | 'running' | 'success' | 'error';

function deriveNodeStatus(node: SolderNode): NodeStatus {
  const cfg = node.config;
  switch (`${node.kind}.${node.action}`) {
    case 'http.request':
      return (cfg.url as string)?.trim() ? 'ready' : 'incomplete';
    case 'transform.map':
      return (cfg.expression as string)?.trim() ? 'ready' : 'incomplete';
    case 'logic.branch':
      return (cfg.expression as string)?.trim() ? 'ready' : 'incomplete';
    case 'logic.loop':
      return (cfg.over as string)?.trim() ? 'ready' : 'incomplete';
    case 'process.call':
      return (cfg.target_id as string)?.trim() ? 'ready' : 'incomplete';
    case 'output.passthrough':
      // Output is "ready" by default — empty mapping is a valid passthrough.
      return 'ready';
    default:
      return 'idle';
  }
}

/**
 * Returns true if the DataTransfer carries any solder DnD payload (either an
 * existing-node move or a new-node palette drop).
 */
export function hasAnyDnD(dt: DataTransfer): boolean {
  const types = Array.from(dt.types);
  return types.includes(DND_MIME_EXISTING) || types.includes(DND_MIME_NEW);
}

/**
 * Wire a step-into click: measure the clicked card's rect so the Canvas can
 * pin the zoom's transform-origin to it, then call `then()` which actually
 * pushes the focus. Origin measurement and focus push fire in the same tick
 * — React batches the state updates so the outgoing motion.div sees the
 * correct transform-origin when Framer starts the exit animation.
 */
function triggerDive(
  e: { currentTarget: Element },
  nodeId: string,
  prepare: ((cardEl: HTMLElement) => void) | undefined,
  then: () => void
): void {
  const card = e.currentTarget.closest(`[data-node-id="${nodeId}"]`);
  if (card instanceof HTMLElement && prepare) prepare(card);
  then();
}

/**
 * Identifies a drop target within a particular stages graph. Nested graphs
 * reuse the same shape — the owner scope is supplied separately by the
 * `StagesGraph` that owns the drop.
 */
export interface DropTarget {
  /** Insert into this stage. */
  stage: number;
  /** Slot position within the stage. */
  slot: number;
  /** Create a brand-new stage before/after the target stage. */
  newStage?: 'before' | 'after';
}

/**
 * Identifies the owner of a stages graph. `null` means root; otherwise the
 * graph lives inside a container node's named branch.
 */
export type GraphOwner = { parentId: string; branchKey: string } | null;

interface StagesGraphProps {
  nodes: SolderNode[];
  /** Identifies this graph's owner for drag/drop scope — null for root. */
  owner: GraphOwner;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  hotZone: string | null;
  setHotZone: (z: string | null) => void;
  onDragStart: (e: ReactDragEvent, nodeId: string) => void;
  /** Top-level drop entrypoint. Receives (target, owner, evt). */
  onDropInto: (target: DropTarget, owner: GraphOwner, e: ReactDragEvent) => void;
  /**
   * Invoked when the user clicks a container's "step into" affordance. The
   * Canvas pushes the segment onto its focus path and re-renders with the
   * scoped node list as the new root.
   */
  onStepInto?: (parentId: string, branchKey: string) => void;
  /**
   * Called synchronously with the clicked card element right before the
   * step-into fires. Canvas uses this to measure the card rect and pin the
   * camera-zoom's transform-origin. Omit for graphs that shouldn't trigger
   * the camera effect (none today, but kept optional for recursive safety).
   */
  onPrepareDiveIn?: (cardEl: HTMLElement) => void;
  /** Depth guard — pass 0 from root; +1 when rendered inside a branch. Containers hide their branches if depth >= 1. */
  depth: number;
}

/**
 * Build a scope prefix for hotZone ids so nested graphs don't collide with
 * the root graph or with each other. Root returns `""`, a branch returns
 * `"branch:<parentId>.<branchKey>:"`.
 */
function scopePrefix(owner: GraphOwner): string {
  return owner ? `branch:${owner.parentId}.${owner.branchKey}:` : '';
}

export default function StagesGraph({
  nodes,
  owner,
  selectedNodeId,
  onSelect,
  onDelete,
  hotZone,
  setHotZone,
  onDragStart,
  onDropInto,
  onStepInto,
  onPrepareDiveIn,
  depth
}: StagesGraphProps) {
  const stages = groupByStage(nodes);
  const prefix = scopePrefix(owner);

  function allowDrop(zoneId: string) {
    return (e: ReactDragEvent) => {
      if (!hasAnyDnD(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes(
        DND_MIME_NEW
      )
        ? 'copy'
        : 'move';
      setHotZone(zoneId);
    };
  }

  function clearHot() {
    setHotZone(null);
  }

  // Nested graphs use tighter column widths so a container card isn't huge.
  const columnMinWidth = depth > 0 ? 'min-w-[200px]' : 'min-w-[260px]';
  const columnMaxWidth = depth > 0 ? 'max-w-[260px]' : 'max-w-[320px]';
  // Root gaps are wider (80px) to make the "new stage" affordance obvious;
  // nested graphs keep a tighter gap so container cards don't bloat.
  const gapMinWidth = depth > 0 ? 'min-w-[44px]' : 'min-w-[80px]';
  const isRoot = !owner;
  // Visual offset applied to the rendered stage label so the user's
  // real stage 1 reads as `02` (the trigger card occupies `01`). Only
  // applied at root — branches don't get a trigger.
  const stageOffset = isRoot ? 1 : 0;

  if (stages.length === 0) {
    // Empty graph — render a blueprint-style drop surface. Drafting-paper
    // frame corners + measurement rule deploy the otherwise-unused
    // `.frame-corners` / `.measure-rule` primitives so the empty state
    // reads as schematic ("this is where the flow gets drafted") rather
    // than generic SaaS "click + to start".
    const tailId = `${prefix}gap-before-1`;
    const active = hotZone === tailId;
    return (
      // Outer is `relative` + `flex-1` so the empty-state copy can absolute-
      // position to the canvas viewport's geometric center (the user wants
      // it centered in the whole canvas, not just the slot to the right of
      // the trigger card). The dropzone still spans the full area for d&d.
      <div className="relative flex-1 min-h-[60vh]">
        {isRoot && (
          <div
            className={`absolute top-0 left-0 z-10 flex flex-col flex-shrink-0 ${columnMinWidth} ${columnMaxWidth}`}
          >
            <div className="mb-3 flex items-center gap-2 px-1">
              <span className="text-[10px] font-mono uppercase tracking-[0.2em] tabular-nums text-surface-400 dark:text-surface-500">
                01
              </span>
              <span className="text-xs font-semibold uppercase tracking-wider text-surface-700 dark:text-surface-300">
                start
              </span>
            </div>
            <TriggerCard />
          </div>
        )}
        <div
          data-testid="empty-canvas-dropzone"
          onDragOver={allowDrop(tailId)}
          onDragLeave={clearHot}
          onDrop={(e) =>
            onDropInto({ stage: 1, slot: 0, newStage: 'before' }, owner, e)
          }
          className={`absolute inset-0 flex items-center justify-center transition-colors ${
            active ? 'ring-2 ring-forge-500/60 bg-forge-500/[0.04] rounded-2xl' : ''
          }`}
        >
          <div className="max-w-sm flex flex-col items-center gap-3 text-center px-4">
            <span className="eyebrow text-surface-400 dark:text-surface-500">
              {isRoot ? 'integration · empty' : 'branch · empty'}
            </span>
            <h2
              className={`font-display text-2xl font-semibold tracking-[-0.01em] transition-colors ${
                active
                  ? 'text-forge-400'
                  : 'text-surface-700 dark:text-surface-200'
              }`}
            >
              {isRoot ? 'Draft your first stage' : 'Draft this branch'}
            </h2>
            <div className="measure-rule w-40 my-1" aria-hidden="true" />
            <p className="text-sm text-surface-500 dark:text-surface-400">
              {isRoot
                ? 'Trigger is set. Drop a step from the palette to add stage 02 — or click one to append it.'
                : 'Drop a step here to populate this branch — its body will run inside the parent.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      {/* Synthetic trigger column at root — visual stage 01. Real stages
          shift to 02+ via `visualStageOffset` below. Branches skip this. */}
      {isRoot && (
        <div className={`flex flex-col flex-shrink-0 ${columnMinWidth} ${columnMaxWidth}`}>
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] tabular-nums text-surface-400 dark:text-surface-500">
              01
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-surface-700 dark:text-surface-300">
              start
            </span>
          </div>
          <TriggerCard />
        </div>
      )}
      {/* Lead drop-zone before stage 1 */}
      <StageGap
        active={hotZone === `${prefix}gap-before-1`}
        onDragOver={allowDrop(`${prefix}gap-before-1`)}
        onDragLeave={clearHot}
        onDrop={(e) =>
          onDropInto(
            { stage: stages[0].stage, slot: 0, newStage: 'before' },
            owner,
            e
          )
        }
        label="new stage"
        kindTestId="gap-lead"
        minWidthClass={gapMinWidth}
        alwaysVisibleLabel
      />
      {stages.map((group, i) => {
        const isLast = i === stages.length - 1;
        return (
          <div key={group.stage} className="flex items-start gap-2">
            <StageColumn
              stage={group.stage}
              nodes={group.nodes}
              owner={owner}
              hotZone={hotZone}
              setHotZone={setHotZone}
              selectedNodeId={selectedNodeId}
              onSelect={onSelect}
              onDelete={onDelete}
              onDragStart={onDragStart}
              onDropInto={onDropInto}
              onStepInto={onStepInto}
              onPrepareDiveIn={onPrepareDiveIn}
              depth={depth}
              minWidthClass={columnMinWidth}
              maxWidthClass={columnMaxWidth}
              scopePrefix={prefix}
              visualStageOffset={stageOffset}
            />
            {/* Inter-stage gap: a compact "insert stage here" zone between columns. */}
            {!isLast && (
              <StageGap
                active={hotZone === `${prefix}gap-after-${group.stage}`}
                onDragOver={allowDrop(`${prefix}gap-after-${group.stage}`)}
                onDragLeave={clearHot}
                onDrop={(e) =>
                  onDropInto(
                    { stage: group.stage, slot: 0, newStage: 'after' },
                    owner,
                    e
                  )
                }
                label="insert"
                kindTestId={`gap-after-${group.stage}`}
                minWidthClass={gapMinWidth}
                alwaysVisibleLabel
              />
            )}
          </div>
        );
      })}
      {/* Trailing phantom slot — renders as a full-size column that previews
          the next stage. Replaces the old thin "new stage" gap so users drag
          to an obvious column-shaped target, not a narrow vertical strip. */}
      <PhantomSlot
        stage={stages[stages.length - 1].stage + 1 + stageOffset}
        active={hotZone === `${prefix}phantom-trailing`}
        onDragOver={allowDrop(`${prefix}phantom-trailing`)}
        onDragLeave={clearHot}
        onDrop={(e) =>
          onDropInto(
            { stage: stages[stages.length - 1].stage, slot: 0, newStage: 'after' },
            owner,
            e
          )
        }
        minWidthClass={columnMinWidth}
      />
    </div>
  );
}

/**
 * Full-size ghost column rendered after the last real stage (and, for empty
 * canvases, as the sole visible drop surface). Shows where the next stage
 * will land without users having to aim for a narrow gap.
 */
function PhantomSlot({
  stage,
  active,
  onDragOver,
  onDragLeave,
  onDrop,
  minWidthClass
}: {
  stage: number;
  active: boolean;
  onDragOver: (e: ReactDragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent) => void;
  minWidthClass: string;
}) {
  // The phantom column matches a real stage column's width so it reads as a
  // sibling slot. The DOM structure is *stable* across active/idle — only
  // colours/ring change. This is critical: in HTML5 drag, if the descendant
  // chain under the cursor is replaced mid-drag (e.g. swapping `flex-1` and
  // structurally different children when `active` flips), Chromium stops
  // firing `dragover` on the previous element, `preventDefault` never
  // re-asserts, and the eventual `drop` is suppressed. Hot-zone visuals are
  // the only thing that should change when the drag enters.
  const tileBorder = active
    ? 'border-primary-400 bg-primary-50/50 dark:border-primary-500 dark:bg-primary-500/10'
    : 'border-surface-200 dark:border-surface-800 hover:border-surface-300 dark:hover:border-surface-700 hover:bg-surface-50/50 dark:hover:bg-surface-900/40';
  const tilePlate = active
    ? 'text-primary-500 ring-primary-300 dark:ring-primary-500/50'
    : 'text-surface-400 dark:text-surface-500 ring-surface-200 dark:ring-surface-800 group-hover:text-primary-500 group-hover:ring-primary-200 dark:group-hover:ring-primary-500/40';
  const tileLabel = active
    ? 'text-primary-600 dark:text-primary-400'
    : 'text-surface-400 dark:text-surface-500 group-hover:text-surface-600 dark:group-hover:text-surface-300';
  return (
    <div
      data-testid="dropzone-new-stage"
      data-gap-kind="gap-trailing"
      className={`group relative flex flex-col rounded-xl transition-all solder-phantom-slot ${minWidthClass} ${
        active ? 'ring-2 ring-primary-400 bg-primary-50/30 dark:bg-primary-500/[0.06]' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Reserve the same vertical space as a StageColumn header so the tile
          below lines up with the first node card in adjacent stages. */}
      <div className="mb-3 flex items-center gap-2 px-1 invisible select-none" aria-hidden="true">
        <span className="text-[10px] font-mono uppercase tracking-[0.2em] tabular-nums">00</span>
        <span className="text-xs font-semibold uppercase tracking-wider">stage</span>
      </div>
      <div className="px-1">
        <div
          className={`rounded-xl border border-dashed p-3 flex items-center gap-2 transition-colors ${tileBorder}`}
        >
          <span
            className={`inline-flex items-center justify-center h-6 w-6 rounded-md text-base leading-none ring-1 transition-colors ${tilePlate}`}
            aria-hidden="true"
          >
            +
          </span>
          <span
            className={`text-[11px] font-mono uppercase tracking-[0.15em] transition-colors ${tileLabel}`}
          >
            {active ? `${String(stage).padStart(2, '0')} · drop to add stage` : 'new stage'}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Vertical gap between stages. Drops here create a new stage.
 *
 * Visuals:
 *   idle            → faint arrow + "new stage" caption at opacity-40
 *   hover (cursor)  → opacity-100 + subtle surface tint
 *   dragover        → primary tint, dashed border, strong arrow
 */
function StageGap({
  active,
  onDragOver,
  onDragLeave,
  onDrop,
  showArrow = true,
  label,
  kindTestId,
  minWidthClass,
  alwaysVisibleLabel = false
}: {
  active: boolean;
  onDragOver: (e: ReactDragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent) => void;
  showArrow?: boolean;
  label?: string;
  /**
   * Distinguishing testid: 'gap-lead' for the pre-stage-1 zone,
   * 'gap-after-N' for the inter-stage zone after stage N. Lets harnesses
   * target a specific gap; `dropzone-new-stage` is also emitted for
   * back-compat with existing tests.
   */
  kindTestId?: string;
  minWidthClass: string;
  alwaysVisibleLabel?: boolean;
}) {
  return (
    <div
      className={`group flex flex-col items-center justify-center self-stretch ${minWidthClass} pt-8 rounded-lg border-2 border-dashed transition-all ${
        active
          ? 'bg-primary-100/40 dark:bg-primary-500/10 border-primary-400/70 dark:border-primary-500/60'
          : 'border-transparent hover:bg-surface-100/40 dark:hover:bg-surface-800/30'
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid={label ? 'dropzone-new-stage' : undefined}
      data-gap-kind={kindTestId}
    >
      {showArrow && (
        <span
          className={`text-2xl leading-none transition-colors ${
            active
              ? 'text-primary-500'
              : alwaysVisibleLabel
                ? 'text-surface-400/70 dark:text-surface-600 group-hover:text-surface-500 dark:group-hover:text-surface-400'
                : 'text-surface-300 dark:text-surface-700 group-hover:text-surface-400 dark:group-hover:text-surface-500'
          }`}
        >
          →
        </span>
      )}
      {label && (
        <span
          className={`mt-2 text-[10px] font-mono uppercase tracking-[0.15em] transition-all select-none ${
            active
              ? 'text-primary-600 dark:text-primary-400 opacity-100'
              : alwaysVisibleLabel
                ? 'text-surface-400 dark:text-surface-600 opacity-60 group-hover:opacity-100'
                : 'text-surface-400 dark:text-surface-600 opacity-0 group-hover:opacity-80'
          }`}
        >
          {alwaysVisibleLabel ? '+ ' : ''}
          {label}
        </span>
      )}
    </div>
  );
}

interface StageColumnProps {
  stage: number;
  nodes: SolderNode[];
  owner: GraphOwner;
  hotZone: string | null;
  setHotZone: (z: string | null) => void;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: ReactDragEvent, nodeId: string) => void;
  onDropInto: (target: DropTarget, owner: GraphOwner, e: ReactDragEvent) => void;
  onStepInto?: (parentId: string, branchKey: string) => void;
  onPrepareDiveIn?: (cardEl: HTMLElement) => void;
  depth: number;
  minWidthClass: string;
  maxWidthClass: string;
  scopePrefix: string;
  /** Added to the stage's internal number when rendering its label. The
   *  root canvas passes `1` so the synthetic trigger card occupies
   *  visual `01` and the user's real stages start at `02`. Branches
   *  pass `0` (default) — no trigger inside containers. */
  visualStageOffset?: number;
}

function StageColumn({
  stage,
  nodes,
  owner,
  hotZone,
  setHotZone,
  selectedNodeId,
  onSelect,
  onDelete,
  onDragStart,
  onDropInto,
  onStepInto,
  onPrepareDiveIn,
  depth,
  minWidthClass,
  maxWidthClass,
  scopePrefix,
  visualStageOffset = 0
}: StageColumnProps) {
  const visualStage = stage + visualStageOffset;
  const tailZoneId = `${scopePrefix}stage-${stage}-tail`;
  const columnZoneId = `${scopePrefix}stage-${stage}-column`;
  const tailHot = hotZone === tailZoneId;
  // The column is the "candidate stage" whenever the cursor is over any
  // of its own zones (tail, column-body, or one of its slots).
  const ownedZonePrefix = `${scopePrefix}stage-${stage}-`;
  const columnCandidate =
    hotZone !== null && hotZone.startsWith(ownedZonePrefix);

  // Nested graphs inside a branch also emit a branch-scoped test id so
  // downstream tests can target exact sub-canvases without ambiguity.
  const branchTestId = owner
    ? `branch-${owner.parentId}-${owner.branchKey}-stage-${stage}`
    : undefined;

  // Slot hovered → render the in-flow drop placeholder at that index.
  // Parse from hotZone when it matches `...-slot-<idx>`.
  let hoveredSlot: number | null = null;
  if (hotZone !== null && hotZone.startsWith(`${ownedZonePrefix}slot-`)) {
    const n = Number(hotZone.slice(`${ownedZonePrefix}slot-`.length));
    if (Number.isFinite(n)) hoveredSlot = n;
  }

  return (
    <div
      className={`group relative flex flex-col ${minWidthClass} ${maxWidthClass} rounded-xl transition-all ${
        columnCandidate
          ? 'bg-primary-50/40 dark:bg-primary-500/[0.06] ring-1 ring-primary-300/50 dark:ring-primary-500/30'
          : ''
      }`}
      onClick={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        // Only claim column-body hover if no more-specific zone (slot/tail)
        // is already hovered — their own handlers take priority.
        if (!hasAnyDnD(e.dataTransfer)) return;
        if (
          hotZone !== null &&
          hotZone.startsWith(ownedZonePrefix) &&
          hotZone !== columnZoneId
        ) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes(
          DND_MIME_NEW
        )
          ? 'copy'
          : 'move';
        setHotZone(columnZoneId);
      }}
      onDragLeave={(e) => {
        // Only clear if the drag actually left this column (not a child).
        const related = e.relatedTarget as Node | null;
        if (related && e.currentTarget.contains(related)) return;
        if (hotZone === columnZoneId) setHotZone(null);
      }}
      onDrop={(e) => {
        // Column-body drop → append as last slot. Inner zones (slot drop-
        // zones, the tail strip) all call `onDropInto` which `stopPropagation`s
        // the event, so this handler only runs when none of them claimed the
        // drop. The previous `hotZone === columnZoneId` guard read stale React
        // state — between `setHotZone(...)` in `onDragOver` and the drop
        // event there's no commit, so the drop's closure saw the pre-update
        // value and quietly dropped on the floor (the user-reported "drag
        // does nothing" bug).
        onDropInto({ stage, slot: nodes.length }, owner, e);
      }}
      data-testid={`stage-column-${stage}`}
      data-branch-stage-testid={branchTestId}
      data-drop-candidate={columnCandidate ? 'true' : undefined}
    >
      {/* Header — `visualStage` reflects the offset applied at root for
          the synthetic trigger card. `stage` (internal) stays 1-indexed
          for data-flow correctness; `visualStage` is what the user reads. */}
      <div className="mb-3 flex items-center gap-2 px-1">
        <span className="text-[10px] font-mono uppercase tracking-[0.2em] tabular-nums text-surface-400 dark:text-surface-500">
          {String(visualStage).padStart(2, '0')}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wider text-surface-700 dark:text-surface-300">
          {nodes.length > 1
            ? `stage ${visualStage} · parallel`
            : `stage ${visualStage}`}
        </span>
      </div>

      {/* Full-column overlay when this stage is the drop candidate. Sits
          behind node cards (pointer-events: none) so the column itself
          still receives drag/drop events. */}
      {columnCandidate && (
        <div
          className="pointer-events-none absolute inset-0 rounded-xl border-2 border-dashed border-primary-400/60 dark:border-primary-500/50 z-0"
          aria-hidden="true"
        />
      )}

      {/* Node stack + interleaved slot drop-zones */}
      <div className="relative z-[1] flex flex-col gap-1.5 px-1">
        {nodes.map((n, idx) => {
          const slotZoneId = `${scopePrefix}stage-${stage}-slot-${idx}`;
          return (
            <div key={n.id}>
              <SlotDropZone
                active={hotZone === slotZoneId}
                onDragOver={(e) => {
                  if (!hasAnyDnD(e.dataTransfer)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = Array.from(
                    e.dataTransfer.types
                  ).includes(DND_MIME_NEW)
                    ? 'copy'
                    : 'move';
                  setHotZone(slotZoneId);
                }}
                onDragLeave={() => setHotZone(null)}
                onDrop={(e) => onDropInto({ stage, slot: idx }, owner, e)}
              />
              {/* In-flow drop-preview placeholder inserted at hovered index */}
              {hoveredSlot === idx && <DropPreviewCard />}
              <NodeCard
                node={n}
                selected={selectedNodeId === n.id}
                onClick={() => onSelect(n.id)}
                onDelete={() => onDelete(n.id)}
                onDragStart={(e) => onDragStart(e, n.id)}
                selectedNodeId={selectedNodeId}
                onSelect={onSelect}
                onDeleteNode={onDelete}
                hotZone={hotZone}
                setHotZone={setHotZone}
                onNestedDragStart={onDragStart}
                onDropInto={onDropInto}
                onStepInto={onStepInto}
                onPrepareDiveIn={onPrepareDiveIn}
                depth={depth}
              />
            </div>
          );
        })}
        {/*
         * Tail drop-zone: drop here to append as last slot.
         *
         * Quiet by default — a 2px strip that expands into a full dashed
         * box only when the column is hovered, when a drag is in flight
         * over it, or when the column is currently being targeted. This
         * removes the always-visible "+ PARALLEL" rectangle that was doubling
         * every stage's visual weight at rest.
         */}
        <div
          data-testid={`stage-${stage}-tail`}
          className={`mt-1 rounded-md border-2 border-dashed flex items-center justify-center gap-2 transition-all overflow-hidden ${
            tailHot || columnCandidate
              ? 'min-h-[52px] border-primary-400 bg-primary-50/50 dark:border-primary-500 dark:bg-primary-500/10'
              : 'min-h-[8px] border-transparent group-hover:min-h-[32px] group-hover:border-surface-200/70 dark:group-hover:border-surface-800/70'
          }`}
          onDragOver={(e) => {
            if (!hasAnyDnD(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = Array.from(
              e.dataTransfer.types
            ).includes(DND_MIME_NEW)
              ? 'copy'
              : 'move';
            setHotZone(tailZoneId);
          }}
          onDragLeave={() => setHotZone(null)}
          onDrop={(e) => onDropInto({ stage, slot: nodes.length }, owner, e)}
        >
          {(tailHot || columnCandidate) && (
            <>
              <span
                className={`text-lg leading-none ${
                  tailHot ? 'text-primary-500' : 'text-primary-400/70'
                }`}
                aria-hidden="true"
              >
                +
              </span>
              <span
                className={`text-xs font-mono uppercase tracking-[0.15em] ${
                  tailHot ? 'text-primary-500' : 'text-primary-500/80'
                }`}
              >
                parallel
              </span>
            </>
          )}
          {!(tailHot || columnCandidate) && (
            <span className="hidden group-hover:inline text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-600">
              + parallel
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Thin horizontal drop zone used between sibling nodes within a stage. */
function SlotDropZone({
  active,
  onDragOver,
  onDragLeave,
  onDrop
}: {
  active: boolean;
  onDragOver: (e: ReactDragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent) => void;
}) {
  return (
    <div
      className={`h-2 -my-1 rounded transition-colors ${
        active ? 'bg-primary-400/60' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    />
  );
}

/**
 * In-flow ghost placeholder rendered at the hovered slot index. Non-
 * interactive so the underlying SlotDropZone still receives drop events.
 */
function DropPreviewCard() {
  return (
    <div
      className="pointer-events-none rounded-xl border-2 border-dashed border-primary-400/70 dark:border-primary-500/60 bg-primary-500/10 p-3 mb-1.5 flex items-center justify-center animate-[solderNodeIn_180ms_ease-out]"
      aria-hidden="true"
    >
      <span className="text-xs font-mono uppercase tracking-[0.15em] text-primary-500 dark:text-primary-400">
        drop here
      </span>
    </div>
  );
}

interface NodeCardProps {
  node: SolderNode;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
  onDragStart: (e: ReactDragEvent) => void;
  /** Props below only matter when the node is a container and renders sub-graphs. */
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  onDeleteNode: (id: string) => void;
  hotZone: string | null;
  setHotZone: (z: string | null) => void;
  onNestedDragStart: (e: ReactDragEvent, nodeId: string) => void;
  onDropInto: (target: DropTarget, owner: GraphOwner, e: ReactDragEvent) => void;
  onStepInto?: (parentId: string, branchKey: string) => void;
  onPrepareDiveIn?: (cardEl: HTMLElement) => void;
  depth: number;
}

/** Node card — renders the node with chip/label/preview + delete + drag handle. */
function NodeCard({
  node,
  selected,
  onClick,
  onDelete,
  onDragStart,
  selectedNodeId,
  onSelect,
  onDeleteNode,
  hotZone,
  setHotZone,
  onNestedDragStart,
  onPrepareDiveIn,
  onDropInto,
  onStepInto,
  depth
}: NodeCardProps) {
  const meta = lookupCatalog(node.kind, node.action);
  const key = nodeKey(node.kind, node.action);
  const catalogEntry = CATALOG.find(
    (c) => c.kind === node.kind && c.action === node.action
  );
  // Resolve the live branches via the helper — handles dynamic kinds
  // (Switch derives its arms from `config.cases`) so we don't have to
  // special-case here. Treat the node as a container only when it has
  // both the catalog category for it AND a populated branches map.
  const branches = resolveBranches(node);
  const isContainer =
    isContainerKind(node.kind, node.action) && !!node.branches && !!branches;
  const navigate = useNavigate();
  const isProcessCall = node.kind === 'process' && node.action === 'call';
  const processTargetId =
    isProcessCall && typeof node.config.target_id === 'string'
      ? (node.config.target_id as string)
      : '';

  // Containers sit at normal card size and don't expand their body inline —
  // step-into is the only path in. The accented left edge differentiates
  // containers from leaf nodes — promoted to forge so the canvas's hot
  // metaphor carries over to the structural cue, not just sky-blue
  // everywhere. The selection ring uses forge for the same reason.
  const containerEdgeClass = isContainer
    ? 'border-l-[3px] border-l-forge-500/60 dark:border-l-forge-500/70'
    : '';
  const status = deriveNodeStatus(node);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      data-testid={`node-${key}`}
      data-node-id={node.id}
      data-node-status={status}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`node node-${key} group relative rounded-xl bg-white border border-surface-200 p-3 cursor-grab active:cursor-grabbing shadow-node hover:shadow-node-hover dark:bg-surface-900/90 dark:border-surface-800 dark:shadow-none dark:hover:shadow-lg dark:hover:shadow-black/40 dark:backdrop-blur-sm animate-[solderNodeIn_200ms_ease-out] ${containerEdgeClass} ${
        selected
          ? 'ring-2 ring-forge-500 ring-offset-2 dark:ring-offset-surface-950'
          : ''
      }`}
    >
      {/*
       * The visible status pip that used to live here was removed —
       * its dark ring (sized for visibility against the white card
       * shadow) was reading as a "random black circle" against the
       * glass-rail card backgrounds rather than the subtle status cue
       * it was meant to be. The status itself is still derived and
       * exposed via `data-node-status` on the card root above so a
       * future indicator (forge-tinted left edge, run-time pulse, etc.)
       * has a stable hook. The .status-pip CSS classes are preserved
       * in index.css for that reuse.
       */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {/*
           * Icon is now the leftmost element. The step-number badge that
           * used to sit before it was removed — the column header above
           * the card already prints "01 START / 02 STAGE 2 / …", so a
           * second copy on every card was just redundant chrome.
           */}
          <span
            className={`inline-flex items-center justify-center h-6 w-6 rounded-md text-xs leading-none ${meta.chip}`}
            aria-hidden="true"
          >
            {meta.icon}
          </span>
          {(() => {
            // Title resolution chain (FullSpec § 11 + roadmap promotion):
            //   1. user-authored label (always wins)
            //   2. derived label (containers only — read off config so the
            //      card always reads as a sentence, never the bare kind)
            //   3. catalog kind ("Loop", "Branch", "API Call", …)
            // The kind-eyebrow renders alongside whenever the title is NOT
            // the bare kind, so the user can still see what the node is.
            const userLabel = node.label?.trim();
            const derived = isContainer ? defaultContainerLabel(node) : null;
            const title = userLabel || derived || meta.label;
            const showKindEyebrow = title !== meta.label;
            return (
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-medium text-sm text-surface-900 dark:text-surface-50 truncate">
                  {title}
                </span>
                {showKindEyebrow && (
                  <span className="eyebrow shrink-0" aria-label="kind">
                    {meta.label}
                  </span>
                )}
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-1">
          {isProcessCall && processTargetId && (
            <button
              type="button"
              aria-label="Open subprocess"
              title="Open the referenced subprocess in a new builder"
              className="text-surface-400 dark:text-surface-500 hover:text-primary-500 dark:hover:text-primary-400 transition-colors text-sm leading-none px-1"
              data-testid={`jump-to-subprocess-${node.id}`}
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/integrations/${processTargetId}`);
              }}
            >
              ↗
            </button>
          )}
          {isContainer && onStepInto && branches && branches.length > 0 && (
            <button
              type="button"
              aria-label="Step into container"
              title="Step into (focus this branch)"
              className="text-surface-400 dark:text-surface-500 hover:text-primary-500 dark:hover:text-primary-400 transition-colors text-sm leading-none px-1"
              data-testid={`step-into-${nodeKey(node.kind, node.action)}`}
              onClick={(e) => {
                e.stopPropagation();
                // Default target: the first resolved branch (`true` for
                // If/Else, `body` for Loop, the first configured `case_*`
                // for Switch). Users navigate deeper from there.
                const first = branches[0];
                triggerDive(e, node.id, onPrepareDiveIn, () =>
                  onStepInto(node.id, first.key)
                );
              }}
            >
              ⤢
            </button>
          )}
          <button
            type="button"
            aria-label="Delete node"
            className="text-surface-300 dark:text-surface-600 hover:text-red-500 dark:hover:text-red-400 transition-colors text-sm leading-none"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {node.when && (
        <div className="min-w-0 mb-1">
          <span className="chip chip-warn max-w-full">
            <span className="opacity-70 shrink-0">when</span>
            <span className="truncate">{node.when}</span>
          </span>
        </div>
      )}
      {/*
       * Headline row.
       *
       * For containers: a kind-specific one-liner (`iterating $.items` for
       * loops, `if $.status == "approved"` for branches, `<target> · for each
       * <over>` for process calls). For leaf nodes: the catalog's preview
       * function. The headline is what tells the user "what this card is
       * actually doing" without stepping in.
       */}
      <div className="font-mono text-xs text-surface-500 dark:text-surface-400 truncate">
        {(isContainer ? containerHeadline(node) : null) ?? meta.preview(node.config)}
      </div>
      {(() => {
        // Loop reduce caption — tells downstream readers what shape this
        // loop hands off (array of outputs / count / last / nothing).
        const cap = loopReduceCaption(node);
        if (!cap) return null;
        return (
          <div className="font-mono text-[11px] text-surface-400 dark:text-surface-500 truncate mt-0.5">
            {cap}
          </div>
        );
      })()}

      {/*
       * Container body summary: the inside of a Loop / Branch / Call
       * Subprocess at a glance.
       *   - "3 steps · API Call · Transform" — aggregate count + ordered
       *     kind list from across all branches, so the user never has to
       *     step in just to read what's there.
       *   - One row per branch: label + caption (e.g. "if $.status ==
       *     'approved'" on the TRUE branch, "else" on FALSE) + step count.
       * The whole region is non-draggable so the rows don't accidentally
       * grab pointer focus from the parent card's drag affordance.
       */}
      {isContainer && branches && (
        <div
          className="mt-2 space-y-1 pt-2 border-t border-surface-200/70 dark:border-surface-800/70"
          onClick={(e) => e.stopPropagation()}
          draggable={false}
          onDragStart={(e) => e.stopPropagation()}
        >
          {(() => {
            const all = Object.values(node.branches ?? {}).flat() as SolderNode[];
            if (all.length === 0) {
              return (
                <div className="text-[11px] font-mono text-surface-400 dark:text-surface-600 italic">
                  empty — step in to add steps
                </div>
              );
            }
            const kinds = all.map((n) => lookupCatalog(n.kind, n.action).label);
            return (
              <div className="text-[11px] font-mono text-surface-500 dark:text-surface-400 flex items-center gap-1.5 min-w-0">
                <span className="tabular-nums shrink-0">
                  {all.length} {all.length === 1 ? 'step' : 'steps'}
                </span>
                <span className="text-surface-300 dark:text-surface-700 shrink-0">·</span>
                <span className="truncate" title={kinds.join(' · ')}>
                  {kinds.join(' · ')}
                </span>
              </div>
            );
          })()}
          {branches.map((b) => {
            const list = node.branches?.[b.key] ?? [];
            const caption = branchCaption(node, b.key);
            return (
              <button
                key={b.key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!onStepInto) return;
                  triggerDive(e, node.id, onPrepareDiveIn, () =>
                    onStepInto(node.id, b.key)
                  );
                }}
                disabled={!onStepInto}
                title={onStepInto ? 'Step into this branch' : undefined}
                data-testid={`branch-header-${node.id}-${b.key}`}
                className="w-full flex items-center justify-between gap-2 py-1 px-1.5 -mx-1.5 rounded text-[11px] font-mono text-surface-500 dark:text-surface-400 hover:bg-surface-100/80 dark:hover:bg-surface-800/60 hover:text-primary-600 dark:hover:text-primary-400 transition-colors disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-surface-500"
              >
                <span className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span className="text-surface-400 dark:text-surface-600 shrink-0">▸</span>
                  <span className="uppercase tracking-[0.15em] shrink-0">
                    {b.label}
                  </span>
                  {caption && (
                    <span
                      className="text-[10px] text-surface-600 dark:text-surface-300 truncate normal-case tracking-normal"
                      title={caption}
                    >
                      {caption}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1.5 text-surface-400 dark:text-surface-600 shrink-0">
                  <span className="tabular-nums">
                    {list.length} {list.length === 1 ? 'step' : 'steps'}
                  </span>
                  <span className="opacity-60">⤢</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Re-export the store hook so Canvas can stay tiny. */
export { useIntegrationStore };
