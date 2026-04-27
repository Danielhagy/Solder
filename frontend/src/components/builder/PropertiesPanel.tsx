import { useIntegrationStore, selectedNode as selectSelected, groupByStage, type SolderNode } from '@/stores/integration';
import { defaultContainerLabel, isContainerKind, lookupCatalog, resolveBranches } from '@/catalog';
import HttpEditor from './editors/http';
import ConnectorEditor from './editors/connector';
import TransformEditor from './editors/transform';
import DataEditor from './editors/data';
import FormatEditor from './editors/format';
import MathEditor from './editors/math';
import StrEditor from './editors/str';
import StateEditor from './editors/state';
import TimeEditor from './editors/time';
import CodeEditor from './editors/code';
import AiEditor from './editors/ai';
import LogicEditor from './editors/logic';
import ProcessEditor from './editors/process';
import OutputEditor from './editors/output';
import TriggerEditor from './TriggerEditor';
import TestNodeOverlay from './TestNodeOverlay';
import type { EditorProps } from './editors/_shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

interface RunPlanRowHandlers {
  /** Whether the user is currently dragging — pointerenter only adds to
   *  selection while this is true. */
  draggingRef: React.MutableRefObject<boolean>;
  /** ID of the row that received the most recent pointerdown. Set by
   *  rows on pointerdown; cleared by the View's window-level pointerup
   *  AND by any row whose pointerenter fires during a drag (a drag-
   *  select rules out a tap). A pointerup on the row whose id matches
   *  is treated as a tap. */
  tappedRowRef: React.MutableRefObject<string | null>;
  /** Mark a node as part of the drag-selection. */
  addToSelection: (id: string) => void;
  /** Toggle a node in/out of the selection (used by per-row checkbox). */
  toggleSelection: (id: string) => void;
  /** True when the row's id is in the active selection set. */
  isSelected: (id: string) => boolean;
  /** Click without drag — focus on canvas + open editor. */
  onTap: (id: string) => void;
  /** Mousedown — begin a drag-selection that starts on this row. */
  onMouseDown: (id: string) => void;
}

/**
 * True when `node` itself is selected, or — recursively — any node in
 * any of its container branches is selected. Drives the stage card's
 * glow: a Branch with one of its children selected glows the whole
 * stage card, not just the leaf row inside.
 */
function hasSelectedInTree(
  node: SolderNode,
  isSelected: (id: string) => boolean
): boolean {
  if (isSelected(node.id)) return true;
  if (!node.branches) return false;
  for (const list of Object.values(node.branches)) {
    for (const child of list as SolderNode[]) {
      if (hasSelectedInTree(child, isSelected)) return true;
    }
  }
  return false;
}

/**
 * Returns the pointer-event props that drive drag-select + tap-to-focus
 * for a given node id. Attached to a row's outer div AND — when the
 * row is the only node in its stage card — also to the card itself, so
 * clicking anywhere inside the container counts. Both handlers fire on
 * a row click (event bubbles); operations are idempotent (`Set.add`,
 * `tappedRowRef = id` is a noop if already that id), so doubled fires
 * are harmless.
 */
function pointerHandlersFor(
  nodeId: string,
  handlers: RunPlanRowHandlers
) {
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Release any implicit pointer capture so the window-level
      // pointermove listener can hit-test other rows as the drag
      // crosses them. With capture in effect, pointer events keep
      // routing to the capture target regardless of cursor position,
      // breaking drag-select on neighbor rows.
      const tgt = e.currentTarget;
      if (tgt.hasPointerCapture?.(e.pointerId)) {
        tgt.releasePointerCapture(e.pointerId);
      }
      handlers.tappedRowRef.current = nodeId;
      handlers.onMouseDown(nodeId);
    },
    onPointerEnter: () => {
      if (handlers.draggingRef.current) {
        handlers.tappedRowRef.current = null;
        handlers.addToSelection(nodeId);
      }
    },
    onPointerUp: () => {
      if (handlers.tappedRowRef.current === nodeId) {
        handlers.tappedRowRef.current = null;
        handlers.onTap(nodeId);
      }
    }
  };
}

/**
 * Recursive Run Plan row. Renders a leaf node as a single line; renders a
 * container node as a header line followed by indented per-branch sub-
 * groups, each containing its own `groupByStage` recursion. The forge-
 * tinted gutter rail on container children visually reinforces the
 * nesting that the canvas's left-edge accent already establishes — Run
 * Plan and canvas now read with the same hierarchy at a glance, instead
 * of the canvas showing a Loop and the Plan showing a flat list.
 *
 * Interactions, threaded down through `handlers`:
 *   - Tap (mouseup with no drag): focus this node on the canvas via
 *     `onTap`. The store selects the node, which switches the right rail
 *     into the per-node editor and the canvas scrolls it into view.
 *   - Click-and-hold + drag over neighbors: builds a selection set; the
 *     Test button then runs scoped to that subset.
 */
function RunPlanRow({
  node,
  depth,
  handlers
}: {
  node: SolderNode;
  depth: number;
  handlers: RunPlanRowHandlers;
}) {
  const meta = lookupCatalog(node.kind, node.action);
  const isContainer = isContainerKind(node.kind, node.action) && !!node.branches;
  const title = node.label?.trim() || (isContainer ? defaultContainerLabel(node) : null) || meta.label;
  const selected = handlers.isSelected(node.id);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        draggable={false}
        data-testid={`run-plan-row-${node.id}`}
        data-selected={selected || undefined}
        {...pointerHandlersFor(node.id, handlers)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handlers.onTap(node.id);
          }
        }}
        className="flex items-center gap-2 text-sm rounded px-1.5 py-1 -mx-1.5 cursor-pointer select-none transition-colors hover:bg-surface-100/70 dark:hover:bg-white/[0.04]"
      >
        <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] ring-1 ${meta.chip}`}>
          {meta.icon}
        </span>
        <span className="truncate text-surface-800 dark:text-surface-200 flex-1">{title}</span>
        {/*
         * Selection checkbox — independent toggle for adding/removing a
         * node from the selection without dragging. Pointer events are
         * stopped so the parent row's drag/tap logic doesn't fire when
         * the user clicks the checkbox itself; React's onChange handles
         * the actual toggle.
         */}
        <input
          type="checkbox"
          checked={selected}
          onChange={() => handlers.toggleSelection(node.id)}
          // Stop ALL pointer events from bubbling to the row — without
          // this, a checkbox click bubbles a `pointerup` to the row,
          // which would treat it as a tap and select the node.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onPointerEnter={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          data-testid={`run-plan-checkbox-${node.id}`}
          aria-label={`Select ${title}`}
          className="h-3.5 w-3.5 rounded-sm border border-surface-300 text-forge-600 focus:ring-1 focus:ring-forge-500/40 dark:border-surface-600 dark:bg-surface-900 cursor-pointer"
        />
      </div>
      {isContainer && node.branches && (
        <div className="mt-1 space-y-1.5">
          {Object.entries(node.branches).map(([branchKey, branchNodes]) => {
            const branchStages = groupByStage(branchNodes as SolderNode[]);
            // Resolve through the helper so Switch's dynamic cases get
            // their configured labels rather than just the bare key.
            const branchMeta = resolveBranches(node)?.find((b) => b.key === branchKey);
            return (
              <div
                key={branchKey}
                className="ml-2 pl-3 border-l-2 border-forge-500/25 dark:border-forge-500/30"
              >
                <div className="eyebrow text-[10px] mb-1 text-forge-700/70 dark:text-forge-400/80">
                  {branchMeta?.label ?? branchKey.toUpperCase()}
                </div>
                {branchStages.length === 0 ? (
                  <div className="text-[11px] font-mono text-surface-400 dark:text-surface-600 italic">
                    empty
                  </div>
                ) : (
                  branchStages.map((g) => (
                    <div key={g.stage} className="space-y-1 mb-1.5">
                      {g.nodes.map((n) => (
                        <RunPlanRow key={n.id} node={n} depth={depth + 1} handlers={handlers} />
                      ))}
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Dispatch by `node.kind` to the per-kind editor in `./editors/`. Kept
 * thin so adding a new kind only requires creating the editor file and
 * adding one branch here. Unknown kinds get a placeholder so users see
 * "no editor" instead of an empty pane.
 */
function KindEditor({ node, set }: EditorProps) {
  switch (node.kind) {
    case 'http':
      return <HttpEditor node={node} set={set} />;
    case 'zip':
    case 'hubspot':
      return <ConnectorEditor node={node} set={set} />;
    case 'transform':
      return <TransformEditor node={node} set={set} />;
    case 'data':
      return <DataEditor node={node} set={set} />;
    case 'format':
      return <FormatEditor node={node} set={set} />;
    case 'math':
      return <MathEditor node={node} set={set} />;
    case 'str':
      return <StrEditor node={node} set={set} />;
    case 'state':
      return <StateEditor node={node} set={set} />;
    case 'time':
      return <TimeEditor node={node} set={set} />;
    case 'code':
      return <CodeEditor node={node} set={set} />;
    case 'ai':
      return <AiEditor node={node} set={set} />;
    case 'logic':
      return <LogicEditor node={node} set={set} />;
    case 'process':
      return <ProcessEditor node={node} set={set} />;
    case 'output':
      return <OutputEditor node={node} set={set} />;
    default:
      return (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No editor for {node.kind}.{node.action}.
        </p>
      );
  }
}

interface PropertiesPanelProps {
  /** Triggered by the Run Plan view's ▶ Test button. Receives the
   *  drag-selected subset (empty array = "test all"). */
  onTestPlan?: (selectedIds: string[]) => void;
  /** True while a run is in flight; disables the Test button. */
  running?: boolean;
}

export default function PropertiesPanel({ onTestPlan, running }: PropertiesPanelProps = {}) {
  const node = useIntegrationStore(selectSelected);
  const nodes = useIntegrationStore((s) => s.nodes);
  const triggerSelected = useIntegrationStore((s) => s.triggerSelected);
  const updateNode = useIntegrationStore((s) => s.updateNode);
  const updateNodeConfig = useIntegrationStore((s) => s.updateNodeConfig);
  const removeNode = useIntegrationStore((s) => s.removeNode);

  // Trigger selection wins over node selection (the store keeps them
  // mutually exclusive, but the right rail still has to pick one body
  // to render — trigger first when both are nominally truthy).
  if (triggerSelected) {
    return (
      <aside className="w-80 glass-rail rounded-xl flex flex-col pointer-events-auto">
        <TriggerEditor />
      </aside>
    );
  }

  if (!node) {
    return (
      <RunPlanView nodes={nodes} onTestPlan={onTestPlan} running={running} />
    );
  }

  return (
    <NodeEditorBody
      node={node}
      updateNode={updateNode}
      updateNodeConfig={updateNodeConfig}
      removeNode={removeNode}
    />
  );
}

/**
 * Right-rail Run Plan view — the "no selection" fallback. Hosts:
 *   - The ▶ Test button (top right of the header)
 *   - The recursive RunPlanRow tree, with click-and-hold drag selection
 *     and tap-to-focus interactions
 *
 * Drag-selection lives here (rather than each row) so the rows compose
 * cleanly under containers (Loops/Branches) and the selection survives
 * recursion. Mouseup anywhere ends the drag, which is registered on
 * `window` so a release outside the panel still terminates cleanly.
 */
function RunPlanView({
  nodes,
  onTestPlan,
  running
}: {
  nodes: SolderNode[];
  onTestPlan?: (selectedIds: string[]) => void;
  running?: boolean;
}) {
  const stages = groupByStage(nodes);
  const selectNode = useIntegrationStore((s) => s.selectNode);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const draggingRef = useRef(false);
  // Lifted into the View (rather than a per-row ref) so the global
  // pointerup listener can reset it after every gesture. With per-row
  // refs, a drag-select would leave the originating row's ref stuck at
  // `true` because that row never received its own pointerup — and a
  // later click on its checkbox would bubble pointerup to the row and
  // mistakenly fire `onTap`, navigating away from the run plan.
  const tappedRowRef = useRef<string | null>(null);

  // Window-level pointer handlers do two jobs:
  //   1. `pointerup` / `mouseup` / `pointercancel` end the drag from
  //      anywhere — a release outside the panel must still clean up
  //      `draggingRef` so a subsequent plain hover doesn't keep adding
  //      rows.
  //   2. `pointermove` AND `mousemove` both hit-test via
  //      `elementFromPoint` and add whichever row the cursor is over.
  //      We listen for both event families because real browsers
  //      sometimes (e.g., when an implicit pointer capture is in
  //      effect or when an HTML5 drag isn't started but the engine
  //      pauses pointermove anyway) deliver one but not the other
  //      reliably during a held-button move. Per-row `pointerenter`
  //      doesn't cut it on its own — implicit capture suppresses
  //      enter events on neighbor rows entirely.
  useEffect(() => {
    function endDrag() {
      draggingRef.current = false;
      // The window-level pointerup runs AFTER the row's own handler,
      // so the row gets first crack at firing `onTap` if it was a tap.
      // Whatever the outcome, the next gesture starts fresh.
      tappedRowRef.current = null;
    }
    function hitTest(clientX: number, clientY: number) {
      if (!draggingRef.current) return;
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      if (!el) return;
      const row = el.closest('[data-testid^="run-plan-row-"]') as HTMLElement | null;
      if (!row) return;
      const id = row.getAttribute('data-testid')?.replace('run-plan-row-', '');
      if (id) addToSelection(id);
    }
    const onPointerMove = (e: PointerEvent) => hitTest(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => hitTest(e.clientX, e.clientY);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onMouseMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addToSelection = useCallback((id: string) => {
    setSelected((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const onMouseDown = useCallback(
    (id: string) => {
      draggingRef.current = true;
      // Seed the selection with the row the drag started on. If the
      // user releases without moving, the tap handler clears it before
      // navigating to the canvas.
      setSelected(new Set([id]));
    },
    []
  );

  const onTap = useCallback(
    (id: string) => {
      // A tap is "I want to look at this node" — clear any drag
      // selection that was seeded on mousedown, select the node (which
      // opens its editor), and scroll the matching canvas card into
      // view. The card is identified by `data-node-id`; if it doesn't
      // exist (deleted, race condition) the focus is harmless.
      setSelected(new Set());
      selectNode(id);
      requestAnimationFrame(() => {
        const card = document.querySelector(`[data-node-id="${id}"]`);
        if (card && 'scrollIntoView' in card) {
          (card as HTMLElement).scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'center'
          });
        }
      });
    },
    [selectNode]
  );

  const isSelected = useCallback(
    (id: string) => selected.has(id),
    [selected]
  );

  const toggleSelection = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handlers: RunPlanRowHandlers = {
    draggingRef,
    tappedRowRef,
    addToSelection,
    toggleSelection,
    isSelected,
    onTap,
    onMouseDown
  };

  if (nodes.length === 0) {
    return (
      <aside className="w-80 glass-rail rounded-xl flex flex-col pointer-events-auto">
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div className="max-w-[240px]">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-surface-50 ring-1 ring-surface-200 mb-3 dark:bg-surface-800 dark:ring-surface-700">
              <span className="text-surface-400 text-sm dark:text-surface-500">◎</span>
            </div>
            <p className="eyebrow mb-1">no_selection</p>
            <p className="text-sm text-surface-600 dark:text-surface-300">
              Select a node to edit its properties
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const selCount = selected.size;
  const testLabel = selCount > 0 ? `▶ Test (${selCount})` : '▶ Test';
  const testTitle =
    selCount > 0
      ? `Run with ${selCount} node${selCount === 1 ? '' : 's'} selected`
      : 'Run all nodes in this plan';

  return (
    <aside className="w-80 glass-rail rounded-xl flex flex-col pointer-events-auto">
      <div className="px-4 pt-3 pb-3 bg-surface-50/50 border-b border-surface-200 dark:bg-surface-900/50 dark:border-surface-800">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h3 className="font-semibold text-sm text-surface-900 dark:text-surface-50">
              Run Plan
            </h3>
            <span className="text-[10px] font-mono text-surface-400 dark:text-surface-500 tabular-nums">
              {stages.length} {stages.length === 1 ? 'stage' : 'stages'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {/*
             * Clear-selection (✕) only appears when a selection is
             * active, but it sits inline with the Test button so that
             * adding/removing it doesn't shift the run plan body
             * vertically. A vertical layout shift here breaks the
             * drag-select mid-gesture: the body moves while the cursor
             * is mid-flight to the next row, so the cursor lands on
             * empty space where row 2 used to be.
             */}
            {selCount > 0 && (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                data-testid="run-plan-clear-selection"
                className="w-6 h-6 inline-flex items-center justify-center rounded-md text-surface-400 hover:text-red-500 hover:bg-red-500/[0.08] dark:text-surface-500 dark:hover:text-red-400 transition-colors"
                title={`Clear ${selCount} selected`}
              >
                ✕
              </button>
            )}
            <button
              type="button"
              onClick={() => onTestPlan?.(Array.from(selected))}
              disabled={running || !onTestPlan}
              data-testid="run-plan-test-button"
              data-selected-count={selCount}
              className="px-2.5 py-1 rounded-md text-[12px] font-mono text-forge-700 hover:bg-forge-500/10 ring-1 ring-forge-500/30 hover:ring-forge-500/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors dark:text-forge-300"
              title={testTitle}
            >
              {running ? 'running…' : testLabel}
            </button>
          </div>
        </div>
      </div>
      <div
        className="flex-1 overflow-auto solder-scroll-thin p-3 space-y-2"
        data-testid="run-plan-body"
      >
        {stages.map((group) => {
          // The stage card glows when ANY of its rows is selected
          // (including descendants buried inside Loop/Branch bodies).
          // The per-row visual stays softer — bg tint only — so the
          // outer ring is the dominant "this will run" signal.
          const stageHasSelected = group.nodes.some((n) =>
            hasSelectedInTree(n, isSelected)
          );
          // For single-node stages (the 95% case), the whole card is
          // the click target — clicking the stage label, the padding,
          // anywhere inside the rounded box drags / selects / focuses
          // the lone node. Multi-node stages stay row-only because the
          // card has no single id to bind to.
          const onlyNode = group.nodes.length === 1 ? group.nodes[0] : null;
          const cardBindings = onlyNode
            ? pointerHandlersFor(onlyNode.id, handlers)
            : null;
          return (
            <div
              key={group.stage}
              data-stage-selected={stageHasSelected || undefined}
              {...(cardBindings ?? {})}
              draggable={cardBindings ? false : undefined}
              className={`rounded-lg border bg-surface-50/50 p-2.5 dark:bg-surface-900/50 transition-shadow transition-colors ${
                cardBindings ? 'cursor-pointer select-none' : ''
              } ${
                stageHasSelected
                  ? 'border-forge-500/60 ring-2 ring-forge-500/40 shadow-[0_0_0_1px_rgba(234,88,12,0.25),0_8px_24px_-12px_rgba(234,88,12,0.45)] dark:border-forge-400/60 dark:ring-forge-400/35'
                  : 'border-surface-200 dark:border-surface-800'
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
                  {String(group.stage).padStart(2, '0')}
                </span>
                {group.nodes.length > 1 && (
                  <span className="eyebrow">{group.nodes.length} parallel</span>
                )}
              </div>
              <div className="space-y-1.5">
                {group.nodes.map((n) => (
                  <RunPlanRow key={n.id} node={n} depth={0} handlers={handlers} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function NodeEditorBody({
  node,
  updateNode,
  updateNodeConfig,
  removeNode,
}: {
  node: SolderNode;
  updateNode: (id: string, updates: Partial<SolderNode>) => void;
  updateNodeConfig: (id: string, config: Record<string, unknown>) => void;
  removeNode: (id: string) => void;
}) {
  const set = (key: string, value: unknown) => updateNodeConfig(node.id, { [key]: value });
  const key = `${node.kind}.${node.action}`;
  const meta = lookupCatalog(node.kind, node.action);
  const shortId = node.id.length > 8 ? node.id.slice(0, 8) : node.id;

  // Test-overlay state — hooks live in this dedicated subcomponent so
  // they're always called in the same order regardless of whether a
  // node is selected at the parent level.
  const [testOpen, setTestOpen] = useState(false);
  const params = useParams<{ id?: string }>();
  const integrationId = params.id && params.id !== 'new' ? params.id : null;

  return (
    <aside className="w-80 glass-rail rounded-xl flex flex-col pointer-events-auto">
      {/* Header — mirrors RunDrawer's chrome so the right-rail keeps a
          consistent shape whether the user is editing a node or watching a run. */}
      <div className="px-4 pt-3 pb-3 bg-surface-50/50 border-b border-surface-200 dark:bg-surface-900/50 dark:border-surface-800">
        <p className="eyebrow mb-0.5">
          stage {String(node.stage).padStart(2, '0')} · {node.kind}
        </p>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center justify-center h-6 w-6 rounded-md text-xs leading-none ring-1 ${meta.chip}`}
            aria-hidden="true"
          >
            {meta.icon}
          </span>
          <h3 className="font-semibold text-sm dark:text-surface-50 truncate">
            {meta.label}
          </h3>
          <span className="text-[10px] font-mono text-surface-400 dark:text-surface-500 tabular-nums">
            {shortId}
          </span>
          <button
            type="button"
            onClick={() => setTestOpen(true)}
            className="ml-auto px-2 py-0.5 rounded-md text-[11px] font-mono text-forge-700 hover:bg-forge-500/10 ring-1 ring-forge-500/30 hover:ring-forge-500/60 transition-colors dark:text-forge-300"
            data-testid="node-test-button"
            title="Replay a previous run's input through this node with its current config"
          >
            ▶ Test
          </button>
        </div>
      </div>

      {testOpen && (
        <TestNodeOverlay
          node={node}
          integrationId={integrationId}
          onClose={() => setTestOpen(false)}
        />
      )}

      <div className="flex-1 overflow-auto solder-scroll-thin p-4 space-y-4">
        {/*
         * User-authored 1-line label, available on every node. When set, it
         * replaces the catalog kind as the card title — e.g. a Loop reads as
         * "For each invoice" instead of "Loop". Critical for containers (a
         * canvas of three Branches all titled "Branch" is unreadable) but
         * useful on any node.
         */}
        <label className="block">
          <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Label
            <span className="eyebrow">optional</span>
          </span>
          <input
            type="text"
            className="input w-full"
            value={(node.label as string) || ''}
            placeholder={
              key === 'logic.loop'
                ? 'e.g. For each invoice'
                : key === 'logic.branch'
                  ? 'e.g. Is approved?'
                  : key === 'process.call'
                    ? 'e.g. Sync vendor'
                    : 'e.g. Fetch invoice'
            }
            onChange={(e) => updateNode(node.id, { label: e.currentTarget.value || undefined })}
          />
          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
            Becomes the card's primary title. Catalog kind moves to a small chip alongside.
          </p>
        </label>

        <KindEditor node={node} set={set} />

        <div className="pt-4 border-t border-surface-200 dark:border-surface-800">
          <label className="block">
            <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
              When
              <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500">optional</span>
            </span>
            <input
              type="text"
              className="input w-full font-mono text-sm"
              value={(node.when as string) || ''}
              placeholder='$.status == "success"'
              onChange={(e) => updateNode(node.id, { when: e.currentTarget.value || undefined })}
            />
            <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
              If set, this node only runs when the expression is truthy. JSONPath (e.g.{' '}
              <span className="font-mono">$.field</span>) with ==, !=, &gt;, &lt;, &gt;=, &lt;=, in, not in.
            </p>
          </label>
        </div>
      </div>

      <div className="p-4 border-t border-surface-200 dark:border-surface-800">
        <button
          type="button"
          className="btn btn-ghost text-red-600 w-full dark:text-red-400"
          onClick={() => removeNode(node.id)}
        >
          Delete Node
        </button>
      </div>
    </aside>
  );
}
