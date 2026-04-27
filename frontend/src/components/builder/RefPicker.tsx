import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CATALOG,
  FALLBACK_REFERENCEABLE_OUTPUTS,
  lookupCatalog
} from '@/catalog';
import type {
  ReferenceableScope,
  ReferenceableStep,
  ReferenceableTrigger
} from '@/stores/integration';

/**
 * Either an upstream step or the integration's trigger — both can be
 * drilled into. The picker uses this to keep Stage-2 logic uniform
 * (build a tree of outputs, render it, emit a token); the only thing
 * that varies is the token shape (`$.steps.<id>.output.<path>` vs
 * `$.trigger.<path>`) and the icon chip.
 */
type PickedSource =
  | { kind: 'step'; step: ReferenceableStep }
  | { kind: 'trigger'; trigger: ReferenceableTrigger };

const TRIGGER_TYPE_GLYPHS: Record<ReferenceableTrigger['type'], string> = {
  manual: '▶',
  webhook: '⤳',
  schedule: '◷',
  on_event: '◆'
};

/**
 * Two-stage reference picker.
 *
 * **Stage 1 — pick a source.** Lists upstream steps (each with a drill-
 * in chevron), plus three flat groups of values that don't have nested
 * structure to drill into: the Loop's `$item` / `$index`, declared
 * variables, and run metadata. Steps drill in; flat shortcuts insert
 * directly.
 *
 * **Stage 2 — pick a field.** A branched-diagram tree of the picked
 * step's `referenceableOutputs`. Each leaf is a clickable button; on
 * click the canonical token (`{{$.steps.<id>.output.<path>}}`) is
 * inserted into the field that opened the picker. A "← <step name>"
 * affordance returns to Stage 1.
 *
 * The picker renders via `createPortal` to `document.body` so its
 * `position: fixed` is viewport-relative — without this, a glass-rail
 * ancestor (`backdrop-filter`) would trap it inside the right rail.
 */

interface RefPickerProps {
  scope: ReferenceableScope;
  /** Called with the full reference token to insert at the cursor. */
  onSelect: (token: string) => void;
  /** Called when the user dismisses without selecting. */
  onClose: () => void;
  /** Anchor element used to size + position the dropdown. */
  anchorEl: HTMLElement | null;
}

export default function RefPicker({
  scope,
  onSelect,
  onClose,
  anchorEl
}: RefPickerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  /*
   * `pickedSource === null` is Stage 1 (the source list); a non-null
   * source (either an upstream step or the trigger) puts us in Stage 2
   * (the field diagram). State resets on the back affordance click.
   */
  const [pickedSource, setPickedSource] = useState<PickedSource | null>(null);
  // Reset query whenever stage transitions so the new view starts clean.
  useEffect(() => {
    setQuery('');
    setHighlightedIndex(0);
  }, [pickedSource]);

  // Highlighted item index for keyboard navigation. Reset on query change.
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  // Reposition on mount + resize. See `measure()` below for the full
  // viewport / flip-up / left-clamp logic.
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    flipped: boolean;
  }>(() => measure(anchorEl));
  useEffect(() => {
    setPos(measure(anchorEl));
    const onResize = () => setPos(measure(anchorEl));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [anchorEl]);

  // Refs the keyboard listener reads — keeps the listener stable
  // across renders (no need to re-attach on every state change).
  // Drillables (trigger + upstream steps) come visually FIRST in Stage
  // 1 so their indices come first in keyboard order; flat insert
  // tokens (loop scope, variables, run metadata) come after.
  const flatDrillablesRef = useRef<PickedSource[]>([]);
  const flatTokensRef = useRef<string[]>([]);
  const highlightedIndexRef = useRef(0);
  const pickedSourceRef = useRef<PickedSource | null>(null);
  highlightedIndexRef.current = highlightedIndex;
  pickedSourceRef.current = pickedSource;

  /*
   * Keyboard nav + dismissal — window-level so the field that opened
   * us can keep focus. Esc dismisses; in Stage 1 ArrowDown/Up walks
   * the list of items where Enter either drills in (a step / the
   * trigger) or inserts (a flat shortcut). In Stage 2 ArrowDown/Up
   * walks tree leaves and Enter inserts the selected field.
   * Backspace in an empty search box pops back to Stage 1.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const inSearch = e.target === searchRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
        const drillables = flatDrillablesRef.current;
        const tokens = flatTokensRef.current;
        const total = drillables.length + tokens.length;
        if (total === 0) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedIndex((i) => (i + 1) % total);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedIndex((i) => (i - 1 + total) % total);
        } else {
          // Enter
          e.preventDefault();
          const idx = Math.max(0, Math.min(highlightedIndexRef.current, total - 1));
          if (idx < drillables.length) {
            // Drillable row — advance to Stage 2.
            const target = drillables[idx];
            if (target) setPickedSource(target);
          } else {
            // Flat shortcut — insert directly.
            const target = tokens[idx - drillables.length];
            if (target) onSelect(target);
          }
        }
        return;
      }
      // Backspace in an empty search input while in Stage 2 → back to Stage 1.
      if (
        e.key === 'Backspace' &&
        inSearch &&
        searchRef.current?.value === '' &&
        pickedSourceRef.current
      ) {
        e.preventDefault();
        setPickedSource(null);
      }
    }
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      if (anchorEl?.contains(e.target as Node)) return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [onSelect, onClose, anchorEl]);

  const lowerQuery = query.trim().toLowerCase();
  const matchesQuery = (...needles: Array<string | undefined>) =>
    !lowerQuery ||
    needles.some((s) => (s ?? '').toLowerCase().includes(lowerQuery));

  // ==========================================================
  // STAGE 1 — source list
  // ==========================================================

  // The trigger appears as a top-of-list drill-in source. Match the
  // search against the trigger type and outputs so e.g. searching
  // "webhook" or "body" both surface it.
  const showTrigger =
    scope.trigger.outputs.length > 0 &&
    (matchesQuery(scope.trigger.label, scope.trigger.type) ||
      scope.trigger.outputs.some((o) =>
        matchesQuery(o.path, o.description)
      ));

  // Steps filtered by the search query — match step label or kind ID.
  const visibleSteps = useMemo(
    () =>
      scope.steps.filter((step) =>
        matchesQuery(step.label, step.id, step.kind, step.action)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.steps, lowerQuery]
  );

  const visibleVariables = scope.variables.filter((v) =>
    matchesQuery(v.name, v.description, v.declaredInStepLabel)
  );
  const visibleRunMeta = scope.runMeta.filter((m) =>
    matchesQuery(m.path, m.description)
  );
  const showLoopScope =
    !!scope.loopScope &&
    matchesQuery(scope.loopScope.loopLabel, '$item', '$index');

  // Drillable sources in visual order: trigger first (the integration's
  // entry point), then upstream steps.
  const visibleDrillables = useMemo<PickedSource[]>(() => {
    const out: PickedSource[] = [];
    if (showTrigger) out.push({ kind: 'trigger', trigger: scope.trigger });
    for (const step of visibleSteps) out.push({ kind: 'step', step });
    return out;
  }, [showTrigger, scope.trigger, visibleSteps]);

  // Flat list of *immediately-insertable* tokens at this stage. Loop
  // scope, variables, run metadata are flat shortcuts (insert on click);
  // drillables (trigger + steps) advance to Stage 2 instead and are
  // tracked in `flatDrillablesRef`.
  const stage1FlatTokens = useMemo(() => {
    if (pickedSource) return [];
    const tokens: string[] = [];
    if (showLoopScope) {
      tokens.push('{{$item}}');
      tokens.push('{{$index}}');
    }
    for (const v of visibleVariables) tokens.push(`{{$.vars.${v.name}}}`);
    for (const m of visibleRunMeta) tokens.push(`{{$.run.${m.path}}}`);
    return tokens;
  }, [pickedSource, showLoopScope, visibleVariables, visibleRunMeta]);

  // ==========================================================
  // STAGE 2 — field diagram for the picked source
  // ==========================================================

  /** Build the canonical token for a leaf at `path` under `pickedSource`. */
  function tokenFor(source: PickedSource, path: string): string {
    if (source.kind === 'trigger') {
      return path ? `{{$.trigger.${path}}}` : '{{$.trigger}}';
    }
    return path
      ? `{{$.steps.${source.step.id}.output.${path}}}`
      : `{{$.steps.${source.step.id}.output}}`;
  }

  // Build a nested tree from the picked source's outputs. Each entry's
  // `path` is split on `.` so `body.id` and `body.email` collapse into
  // a `body` branch with `id` / `email` leaves.
  const fieldTree = useMemo(() => {
    if (!pickedSource) return null;
    let outputs: Array<{ path: string; description: string; sample?: unknown }>;
    if (pickedSource.kind === 'trigger') {
      outputs = pickedSource.trigger.outputs;
    } else {
      const entry = CATALOG.find(
        (c) =>
          c.kind === pickedSource.step.kind &&
          c.action === pickedSource.step.action
      );
      outputs = entry?.referenceableOutputs ?? FALLBACK_REFERENCEABLE_OUTPUTS;
    }
    const filtered = outputs.filter((o) =>
      matchesQuery(o.path, o.description)
    );
    return buildTree(filtered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedSource, lowerQuery]);

  // Flat list of every leaf token in the tree, in render order, for
  // keyboard navigation.
  const stage2FlatTokens = useMemo(() => {
    if (!pickedSource || !fieldTree) return [];
    const tokens: string[] = [];
    walkTreeLeaves(fieldTree, (path) => {
      tokens.push(tokenFor(pickedSource, path));
    });
    return tokens;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedSource, fieldTree]);

  // Update the refs the keyboard listener reads. Stage 1: drillables
  // (trigger + steps) come first, then flat tokens. Stage 2: only
  // tokens (no drilling further from a leaf).
  flatDrillablesRef.current = pickedSource ? [] : visibleDrillables;
  flatTokensRef.current = pickedSource ? stage2FlatTokens : stage1FlatTokens;

  function handleSelectField(path: string) {
    if (!pickedSource) return;
    onSelect(tokenFor(pickedSource, path));
  }
  function handleBack() {
    setPickedSource(null);
  }

  const isStage1Empty =
    visibleDrillables.length === 0 &&
    visibleVariables.length === 0 &&
    visibleRunMeta.length === 0 &&
    !showLoopScope;

  // Highlight-index offsets — the keyboard order is "drillables first,
  // then flat tokens", so the visual sections need bases that match.
  const stepsBase = showTrigger ? 1 : 0;
  const tokensBase = visibleDrillables.length;
  let tokenCursor = 0; // walks the loop/var/run sections in render

  /** Header label for Stage 2 — the source's display name. */
  const pickedLabel = !pickedSource
    ? ''
    : pickedSource.kind === 'trigger'
      ? `${pickedSource.trigger.label} · ${pickedSource.trigger.type}`
      : pickedSource.step.label || pickedSource.step.id;

  // ==========================================================
  // RENDER
  // ==========================================================

  const picker = (
    <div
      ref={wrapRef}
      data-testid="ref-picker"
      role="dialog"
      aria-label="Insert reference"
      data-stage={pickedSource ? 'fields' : 'steps'}
      className="fixed z-50 glass-rail rounded-xl overflow-hidden flex flex-col"
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: 460
      }}
    >
      {/* Header — back affordance in Stage 2, otherwise just title; search input below. */}
      <div className="px-3 pt-2.5 pb-2 border-b border-surface-200/60 dark:border-white/[0.06] space-y-1.5">
        {pickedSource ? (
          <button
            type="button"
            onClick={handleBack}
            data-testid="ref-picker-back"
            className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-[0.15em] text-surface-500 dark:text-surface-400 hover:text-forge-600 dark:hover:text-forge-400 transition-colors"
          >
            <span aria-hidden="true">←</span>
            <span>{pickedLabel}</span>
            <span className="text-surface-300 dark:text-surface-700">·</span>
            <span className="text-surface-400 dark:text-surface-500 normal-case tracking-normal">
              fields
            </span>
          </button>
        ) : (
          <div className="text-xs font-mono uppercase tracking-[0.15em] text-surface-500 dark:text-surface-400">
            pick a source
          </div>
        )}
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={pickedSource ? 'Search fields…' : 'Search trigger, steps, variables…'}
          className="w-full bg-transparent text-sm placeholder:text-surface-400 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-auto solder-scroll-thin py-1">
        {!pickedSource && isStage1Empty && (
          <div className="px-3 py-6 text-center text-xs text-surface-500 dark:text-surface-400">
            No matches.
          </div>
        )}

        {/* ============== STAGE 1 ============== */}

        {/* Trigger drill-in: index 0 in keyboard order. The integration's
            entry point — surfaces fields like `body`, `headers`, etc. */}
        {!pickedSource && showTrigger && (
          <div className="px-1 py-1">
            <div className="eyebrow px-2 mb-1">Trigger</div>
            {(() => {
              const hl = 0 === highlightedIndex;
              return (
                <button
                  type="button"
                  data-highlighted={hl || undefined}
                  data-testid="ref-picker-trigger"
                  onClick={() =>
                    setPickedSource({ kind: 'trigger', trigger: scope.trigger })
                  }
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
                    hl
                      ? 'bg-forge-500/10 ring-1 ring-forge-500/40 dark:bg-forge-500/[0.14]'
                      : 'hover:bg-surface-100/70 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <span
                    className="inline-flex items-center justify-center h-5 w-5 rounded text-[11px] leading-none ring-1 ring-forge-500/40 bg-forge-500/[0.12] text-forge-600 dark:text-forge-300"
                    aria-hidden="true"
                  >
                    {TRIGGER_TYPE_GLYPHS[scope.trigger.type]}
                  </span>
                  <span className="text-sm font-medium text-surface-900 dark:text-surface-50 truncate flex-1">
                    {scope.trigger.label}
                    <span className="ml-1.5 text-[11px] font-mono text-surface-400 dark:text-surface-500">
                      {scope.trigger.type}
                    </span>
                  </span>
                  <span
                    className="text-surface-400 dark:text-surface-600 text-xs"
                    aria-hidden="true"
                  >
                    →
                  </span>
                </button>
              );
            })()}
          </div>
        )}

        {!pickedSource && visibleSteps.length > 0 && (
          <div className="px-1 py-1">
            <div className="eyebrow px-2 mb-1">Steps</div>
            {visibleSteps.map((step, i) => {
              const meta = lookupCatalog(step.kind, step.action);
              const idx = stepsBase + i;
              const hl = idx === highlightedIndex;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setPickedSource({ kind: 'step', step })}
                  data-highlighted={hl || undefined}
                  data-testid={`ref-picker-step-${step.id}`}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
                    hl
                      ? 'bg-forge-500/10 ring-1 ring-forge-500/40 dark:bg-forge-500/[0.14]'
                      : 'hover:bg-surface-100/70 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <span
                    className={`inline-flex items-center justify-center h-5 w-5 rounded text-[10px] leading-none ring-1 ${meta.chip}`}
                    aria-hidden="true"
                  >
                    {meta.icon}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
                    {String(step.stage).padStart(2, '0')}
                  </span>
                  <span className="text-sm font-medium text-surface-900 dark:text-surface-50 truncate flex-1">
                    {step.label}
                  </span>
                  <span
                    className="text-surface-400 dark:text-surface-600 text-xs"
                    aria-hidden="true"
                  >
                    →
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!pickedSource && showLoopScope && scope.loopScope && (
          <div className="px-1 py-1">
            <div className="eyebrow px-2 mb-1">
              Loop scope · {scope.loopScope.loopLabel}
            </div>
            {(() => {
              const hl = tokensBase + tokenCursor === highlightedIndex;
              tokenCursor++;
              return (
                <button
                  type="button"
                  onClick={() => onSelect('{{$item}}')}
                  data-highlighted={hl || undefined}
                  className={`w-full flex items-baseline gap-2 px-2 py-1 rounded text-left ${
                    hl ? 'bg-forge-500/10 ring-1 ring-forge-500/40' : 'hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10]'
                  }`}
                >
                  <span className="font-mono text-[11px] text-surface-700 dark:text-surface-300">
                    $item
                  </span>
                  <span className="text-[11px] text-surface-500 dark:text-surface-400">
                    Current iteration's element
                  </span>
                </button>
              );
            })()}
            {(() => {
              const hl = tokensBase + tokenCursor === highlightedIndex;
              tokenCursor++;
              return (
                <button
                  type="button"
                  onClick={() => onSelect('{{$index}}')}
                  data-highlighted={hl || undefined}
                  className={`w-full flex items-baseline gap-2 px-2 py-1 rounded text-left ${
                    hl ? 'bg-forge-500/10 ring-1 ring-forge-500/40' : 'hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10]'
                  }`}
                >
                  <span className="font-mono text-[11px] text-surface-700 dark:text-surface-300">
                    $index
                  </span>
                  <span className="text-[11px] text-surface-500 dark:text-surface-400">
                    Current iteration's 0-based index
                  </span>
                </button>
              );
            })()}
          </div>
        )}

        {!pickedSource && visibleVariables.length > 0 && (
          <div className="px-1 py-1">
            <div className="eyebrow px-2 mb-1">Variables</div>
            {visibleVariables.map((v) => {
              const hl = tokensBase + tokenCursor === highlightedIndex;
              tokenCursor++;
              return (
                <button
                  key={`${v.declaredInStepId}-${v.name}`}
                  type="button"
                  onClick={() => onSelect(`{{$.vars.${v.name}}}`)}
                  data-highlighted={hl || undefined}
                  className={`w-full flex items-baseline gap-2 px-2 py-1 rounded text-left ${
                    hl ? 'bg-forge-500/10 ring-1 ring-forge-500/40' : 'hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10]'
                  }`}
                >
                  <span className="font-mono text-[11px] text-surface-700 dark:text-surface-300">
                    $.{v.name}
                  </span>
                  <span className="text-[11px] text-surface-500 dark:text-surface-400 truncate">
                    {v.description ||
                      `${v.origin === 'loop-append' ? 'appended' : 'set'} in ${v.declaredInStepLabel}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!pickedSource && visibleRunMeta.length > 0 && (
          <div className="px-1 py-1">
            <div className="eyebrow px-2 mb-1">Run metadata</div>
            {visibleRunMeta.map((m) => {
              const hl = tokensBase + tokenCursor === highlightedIndex;
              tokenCursor++;
              return (
                <button
                  key={m.path}
                  type="button"
                  onClick={() => onSelect(`{{$.run.${m.path}}}`)}
                  data-highlighted={hl || undefined}
                  className={`w-full flex items-baseline gap-2 px-2 py-1 rounded text-left ${
                    hl ? 'bg-forge-500/10 ring-1 ring-forge-500/40' : 'hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10]'
                  }`}
                >
                  <span className="font-mono text-[11px] text-surface-700 dark:text-surface-300">
                    $.run.{m.path}
                  </span>
                  <span className="text-[11px] text-surface-500 dark:text-surface-400 truncate">
                    {m.description}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* ============== STAGE 2 ============== */}

        {pickedSource && fieldTree && (
          <FieldDiagram
            tree={fieldTree}
            onSelectField={handleSelectField}
            highlightedIndex={highlightedIndex}
            stepLabel={pickedLabel}
            rootPathLabel={
              pickedSource.kind === 'trigger' ? '$.trigger' : '$.output'
            }
          />
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-surface-200/60 dark:border-white/[0.06] text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500 flex justify-between">
        <span>
          {pickedSource
            ? '↑↓ navigate · ↵ insert · ⌫ back'
            : '↑↓ navigate · ↵ pick · esc close'}
        </span>
        {(() => {
          const total = pickedSource
            ? stage2FlatTokens.length
            : visibleDrillables.length + stage1FlatTokens.length;
          if (total === 0) return null;
          return (
            <span className="tabular-nums">
              {Math.min(highlightedIndex + 1, total)} / {total}
            </span>
          );
        })()}
      </div>
    </div>
  );

  // Portal so `position: fixed` is viewport-relative even when an
  // ancestor (the right rail's `glass-rail` with `backdrop-filter`)
  // would otherwise create a containing block. Falls back to inline
  // render in environments without `document` (SSR / some test rigs).
  if (typeof document === 'undefined') return picker;
  return createPortal(picker, document.body);
}

// ============================================================
// Tree types + helpers
// ============================================================

interface TreeNode {
  /** Children keyed by the next path segment (stable insertion order). */
  children: Map<string, TreeNode>;
  /** Set when this node corresponds to an entry in `referenceableOutputs`. */
  description?: string;
  /** Full dotted path from the root, used to build the insertion token. */
  fullPath?: string;
  /** Optional sample value (currently unused in render; reserved for v2 live preview). */
  sample?: unknown;
}

function buildTree(
  outputs: Array<{ path: string; description: string; sample?: unknown }>
): TreeNode {
  const root: TreeNode = { children: new Map() };
  for (const o of outputs) {
    if (!o.path) {
      // Whole-output entry — attach metadata to the root.
      root.description = o.description;
      root.fullPath = '';
      root.sample = o.sample;
      continue;
    }
    const parts = o.path.split('.');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!cur.children.has(part)) {
        cur.children.set(part, { children: new Map() });
      }
      cur = cur.children.get(part)!;
      if (i === parts.length - 1) {
        cur.description = o.description;
        cur.fullPath = o.path;
        cur.sample = o.sample;
      }
    }
  }
  return root;
}

/**
 * Walk the tree depth-first, calling `cb(path)` on every node that
 * carries a description (i.e. corresponds to an authored output).
 * Order matches the visual render so keyboard nav indices line up.
 */
function walkTreeLeaves(node: TreeNode, cb: (path: string) => void) {
  if (node.fullPath !== undefined) cb(node.fullPath);
  for (const child of node.children.values()) {
    walkTreeLeaves(child, cb);
  }
}

// ============================================================
// FieldDiagram — Stage 2 tree render
// ============================================================

function FieldDiagram({
  tree,
  onSelectField,
  highlightedIndex,
  stepLabel,
  rootPathLabel
}: {
  tree: TreeNode;
  onSelectField: (path: string) => void;
  highlightedIndex: number;
  stepLabel: string;
  /** Label shown next to the source name — e.g. `$.output` or `$.trigger`. */
  rootPathLabel: string;
}) {
  // Render counter so each row knows whether it's the highlighted one.
  // Walked in the same order as `walkTreeLeaves` so the index lines up.
  let cursor = 0;
  const isHighlighted = () => {
    const here = cursor === highlightedIndex;
    cursor++;
    return here;
  };

  const isEmpty = tree.children.size === 0 && tree.fullPath === undefined;
  if (isEmpty) {
    return (
      <div className="px-3 py-6 text-center text-xs text-surface-500 dark:text-surface-400">
        No matching fields.
      </div>
    );
  }

  return (
    <div className="px-2 py-2 font-mono text-sm" data-testid="ref-picker-tree">
      <div className="text-[11px] uppercase tracking-[0.15em] text-forge-700/80 dark:text-forge-400/80 mb-1.5 px-1">
        {stepLabel} <span className="text-surface-400 dark:text-surface-600">·</span>{' '}
        <span className="text-surface-500 dark:text-surface-400 normal-case tracking-normal">
          {rootPathLabel}
        </span>
      </div>
      {tree.fullPath !== undefined && (
        <FieldRow
          label="(whole output)"
          path={tree.fullPath}
          description={tree.description ?? ''}
          depth={0}
          isLast={tree.children.size === 0}
          isHighlighted={isHighlighted()}
          onSelect={() => onSelectField(tree.fullPath ?? '')}
        />
      )}
      <TreeBranch
        node={tree}
        depth={0}
        onSelectField={onSelectField}
        isHighlighted={isHighlighted}
      />
    </div>
  );
}

function TreeBranch({
  node,
  depth,
  onSelectField,
  isHighlighted
}: {
  node: TreeNode;
  depth: number;
  onSelectField: (path: string) => void;
  isHighlighted: () => boolean;
}) {
  const entries = [...node.children.entries()];
  return (
    <>
      {entries.map(([key, child], i) => {
        const isLast = i === entries.length - 1;
        const hasChildren = child.children.size > 0;
        const hl = child.fullPath !== undefined ? isHighlighted() : false;
        return (
          <div key={key}>
            {child.fullPath !== undefined ? (
              <FieldRow
                label={key}
                path={child.fullPath}
                description={child.description ?? ''}
                depth={depth}
                isLast={isLast && !hasChildren}
                isHighlighted={hl}
                onSelect={() => onSelectField(child.fullPath ?? '')}
              />
            ) : (
              // Intermediate branch (no entry of its own) — render as a
              // header row with the connector but no click action.
              <BranchHeader label={key} depth={depth} isLast={false} />
            )}
            {hasChildren && (
              <TreeBranch
                node={child}
                depth={depth + 1}
                onSelectField={onSelectField}
                isHighlighted={isHighlighted}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * One leaf row in the tree. The connector is drawn in CSS so the visual
 * "branched diagram" feel comes naturally from indentation + a vertical
 * line + the horizontal tick at each row. `isLast` tells the renderer
 * whether to draw a `└──` (last in its parent) or `├──` (continuation).
 */
function FieldRow({
  label,
  path,
  description,
  depth,
  isLast,
  isHighlighted,
  onSelect
}: {
  label: string;
  path: string;
  description: string;
  depth: number;
  isLast: boolean;
  isHighlighted: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className="relative"
      style={{ paddingLeft: `${depth * 14 + 2}px` }}
    >
      <div className="flex items-stretch">
        {/* Connector cell — vertical + horizontal tick */}
        <span
          className="relative inline-block w-4 shrink-0"
          aria-hidden="true"
        >
          <span
            className={`absolute left-1 top-0 ${
              isLast ? 'h-1/2' : 'h-full'
            } border-l border-surface-300 dark:border-surface-700`}
          />
          <span className="absolute left-1 top-1/2 w-3 border-t border-surface-300 dark:border-surface-700" />
        </span>
        <button
          type="button"
          onClick={onSelect}
          data-highlighted={isHighlighted || undefined}
          data-testid={`ref-picker-field-${path || '_root_'}`}
          className={`flex-1 flex items-baseline gap-2 px-1.5 py-0.5 rounded text-left min-w-0 transition-colors ${
            isHighlighted
              ? 'bg-forge-500/10 ring-1 ring-forge-500/40 dark:bg-forge-500/[0.14]'
              : 'hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10]'
          }`}
        >
          <span className="text-[12px] text-surface-800 dark:text-surface-200 shrink-0">
            {label}
          </span>
          <span className="text-[11px] text-surface-500 dark:text-surface-400 truncate">
            {description}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * Header for an intermediate branch that doesn't itself correspond to
 * an authored output (e.g. `body` is a parent of `body.id` / `body.name`
 * but isn't itself a leaf). Renders the connector + label, but isn't
 * clickable.
 */
function BranchHeader({
  label,
  depth,
  isLast
}: {
  label: string;
  depth: number;
  isLast: boolean;
}) {
  return (
    <div className="relative" style={{ paddingLeft: `${depth * 14 + 2}px` }}>
      <div className="flex items-stretch">
        <span
          className="relative inline-block w-4 shrink-0"
          aria-hidden="true"
        >
          <span
            className={`absolute left-1 top-0 ${
              isLast ? 'h-1/2' : 'h-full'
            } border-l border-surface-300 dark:border-surface-700`}
          />
          <span className="absolute left-1 top-1/2 w-3 border-t border-surface-300 dark:border-surface-700" />
        </span>
        <span className="text-[12px] text-surface-600 dark:text-surface-400 px-1.5 py-0.5">
          {label}
        </span>
      </div>
    </div>
  );
}

// ============================================================
// Position
// ============================================================

function measure(anchor: HTMLElement | null) {
  if (!anchor) return { top: 0, left: 0, width: 320, flipped: false };
  const rect = anchor.getBoundingClientRect();
  const PICKER_HEIGHT = 460;
  const GAP = 6;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  // Default below; flip above when there's not enough room below but
  // does fit above. Top is clamped to viewport so a flip-above on a
  // short viewport doesn't push the search row off-screen.
  const spaceBelow = viewportH - rect.bottom - GAP;
  const spaceAbove = rect.top - GAP;
  const flipped = spaceBelow < PICKER_HEIGHT && spaceAbove > spaceBelow;
  const rawTop = flipped ? rect.top - PICKER_HEIGHT - GAP : rect.bottom + GAP;
  const top = Math.max(GAP, rawTop);
  const width = Math.max(rect.width, 340);
  // Clamp `left` so the picker stays inside the viewport horizontally.
  // Without this the right-rail fields would push the picker past the
  // right edge — even with the portal, the picker should never extend
  // beyond the viewport.
  const maxLeft = viewportW - width - GAP;
  const left = Math.max(GAP, Math.min(rect.left, maxLeft));
  return { top, left, width, flipped };
}
