import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { groupByStage, type SolderNode } from '@/stores/integration';
import { lookupCatalog, nodeKey } from '@/catalog';

/** A single executed step as written by the Temporal workflow to Run.steps. */
export interface StepRecord {
  node_id?: string;
  node_type?: string;
  stage?: number;
  status?: 'running' | 'success' | 'failed' | 'skipped' | string;
  output?: unknown;
  error?: string;
  condition_result?: unknown;
}

export type RunStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timeout';

interface RunDrawerProps {
  open: boolean;
  /** Current run status, or null when no run is in flight/completed. */
  status: RunStatus | null;
  runId: string | null;
  /** Epoch ms when the run started (used for the elapsed counter). */
  startedAt: number | null;
  /** Step records from the latest poll tick. Empty while running, populated at terminal. */
  steps: StepRecord[];
  output?: unknown;
  error?: string | null;
  /** Root-level canvas nodes, used to render the planned stages up-front. */
  planNodes: SolderNode[];
  onClose: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
}

function statusMeta(status: string | undefined) {
  switch (status) {
    case 'success':
      return {
        glyph: '✓',
        chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800/50',
        label: 'ok'
      };
    case 'failed':
      return {
        glyph: '✕',
        chip: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-800/50',
        label: 'fail'
      };
    case 'skipped':
      return {
        glyph: '·',
        chip: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800/50',
        label: 'skip'
      };
    case 'running':
      return {
        glyph: '…',
        chip: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-800/50',
        label: 'run'
      };
    default:
      return {
        glyph: '○',
        chip: 'bg-surface-100 text-surface-500 ring-surface-200 dark:bg-surface-800 dark:text-surface-400 dark:ring-surface-700',
        label: 'queued'
      };
  }
}

/** Top-bar chip tone name for overall run status — maps to .chip-* classes. */
function overallMeta(status: RunStatus | null): { label: string; chip: string } {
  switch (status) {
    case 'success':
      return { label: 'success', chip: 'chip-success' };
    case 'failed':
      return { label: 'failed', chip: 'chip-danger' };
    case 'cancelled':
      return { label: 'cancelled', chip: 'chip-neutral' };
    case 'timeout':
      return { label: 'timeout', chip: 'chip-warn' };
    case 'running':
    default:
      return { label: 'running', chip: 'chip-info' };
  }
}

export default function RunDrawer({
  open,
  status,
  runId,
  startedAt,
  steps,
  output,
  error,
  planNodes,
  onClose
}: RunDrawerProps) {
  // Tick every 250ms while running so the elapsed counter is visibly alive.
  // Pauses once the run reaches a terminal state — no point burning renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'running' || !startedAt) return;
    const h = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(h);
  }, [status, startedAt]);

  // Map of node_id → most-recent status, so the plan column can paint each
  // planned node when its step record arrives. If a node appears multiple
  // times (nested re-execution), the latest wins.
  const statusByNodeId = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of steps) {
      if (s.node_id && s.status) m.set(s.node_id, s.status);
    }
    return m;
  }, [steps]);

  const stages = useMemo(() => groupByStage(planNodes), [planNodes]);
  const overall = overallMeta(status);
  const elapsedLabel = startedAt ? formatDuration((now || startedAt) - startedAt) : '—';

  // Steps that don't correspond to any planned root node (e.g. executed
  // inside a container's branches). Surface them in a secondary section so
  // the user still sees what ran.
  const extraSteps = useMemo(() => {
    const planIds = new Set(planNodes.map((n) => n.id));
    return steps.filter((s) => !s.node_id || !planIds.has(s.node_id));
  }, [steps, planNodes]);

  if (!open) return null;
  return (
    <motion.aside
      role="dialog"
      aria-label="Run details"
      data-testid="run-drawer"
      className="w-80 flex-shrink-0 bg-white border-l border-surface-200 dark:bg-surface-950 dark:border-surface-800 flex flex-col shadow-[inset_1px_0_0_0_rgb(244_244_245)]"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {/* Header — mirrors PropertiesPanel's chrome for slot parity. */}
      <div className="px-4 pt-3 pb-3 bg-surface-50/50 border-b border-surface-200 dark:bg-surface-900/50 dark:border-surface-800">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="eyebrow mb-0.5">run · {runId ? runId.slice(0, 8) : '—'}</p>
            <h3 className="font-semibold dark:text-surface-50">Live Run</h3>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="btn-icon"
            onClick={onClose}
            data-testid="run-drawer-close"
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className={`chip ${overall.chip}`}>{overall.label}</span>
          <span className="text-xs font-mono text-surface-500 dark:text-surface-400 tabular-nums">
            {elapsedLabel}
          </span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-3 alert alert-danger">
          <div className="eyebrow mb-0.5 opacity-70">error</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {error}
          </pre>
        </div>
      )}

      {/* Plan / progress */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <span className="eyebrow">plan</span>
                <span className="text-[10px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
                  {stages.length} {stages.length === 1 ? 'stage' : 'stages'}
                </span>
              </div>
              {stages.length === 0 ? (
                <p className="text-sm text-surface-500 dark:text-surface-400">
                  No nodes on the canvas.
                </p>
              ) : (
                <ol className="space-y-1.5" data-testid="run-plan">
                  {stages.map((group) => (
                    <li
                      key={group.stage}
                      className="rounded-md border border-surface-200 dark:border-surface-800 p-2 bg-surface-50/60 dark:bg-surface-900/60"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
                          {String(group.stage).padStart(2, '0')}
                        </span>
                        {group.nodes.length > 1 && (
                          <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-600">
                            {group.nodes.length} parallel
                          </span>
                        )}
                      </div>
                      <div className="space-y-1">
                        {group.nodes.map((n) => {
                          const meta = lookupCatalog(n.kind, n.action);
                          const stepStatus = statusByNodeId.get(n.id);
                          const sm = statusMeta(stepStatus);
                          return (
                            <div
                              key={n.id}
                              data-testid={`run-plan-${nodeKey(n.kind, n.action)}-${n.id}`}
                              data-step-status={stepStatus || 'queued'}
                              className={`flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
                                stepStatus === 'running'
                                  ? 'bg-blue-50/60 dark:bg-blue-950/30'
                                  : stepStatus === 'failed'
                                    ? 'bg-red-50/60 dark:bg-red-950/30'
                                    : ''
                              }`}
                            >
                              <span
                                className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] ring-1 ${meta.chip}`}
                                aria-hidden="true"
                              >
                                {meta.icon}
                              </span>
                              <span className="flex-1 min-w-0 text-sm text-surface-800 dark:text-surface-200 truncate">
                                {meta.label}
                              </span>
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ring-1 ${sm.chip}`}
                                title={stepStatus || 'queued'}
                              >
                                <span>{sm.glyph}</span>
                                <span>{sm.label}</span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {extraSteps.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="eyebrow">nested steps</span>
                  <span className="text-[10px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
                    {extraSteps.length}
                  </span>
                </div>
                <ul className="space-y-1" data-testid="run-extra-steps">
                  {extraSteps.map((s, i) => {
                    const sm = statusMeta(s.status);
                    return (
                      <li
                        key={i}
                        className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200"
                      >
                        <span
                          className={`inline-flex items-center justify-center w-4 h-4 rounded text-[10px] ring-1 ${sm.chip}`}
                        >
                          {sm.glyph}
                        </span>
                        <span className="font-mono text-xs truncate">
                          {s.node_type || 'node'}
                          {typeof s.stage === 'number' && (
                            <span className="text-surface-400 dark:text-surface-500 ml-1">
                              · stage {s.stage}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {output !== undefined && output !== null && (
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="eyebrow">output</span>
                </div>
                <pre className="font-mono text-xs bg-surface-50 dark:bg-surface-900 text-surface-700 dark:text-surface-300 rounded-md p-3 overflow-auto max-h-60">
                  {JSON.stringify(output, null, 2)}
                </pre>
              </div>
            )}
      </div>
    </motion.aside>
  );
}
