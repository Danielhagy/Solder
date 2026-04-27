import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '@/api/client';
import { useIntegrationStore, type SolderNode } from '@/stores/integration';
import { useTestResultStore } from '@/stores/test-results';

/** Slim run shape returned by `/api/nodes/runs` — only the fields the
 *  picker renders. Avoids importing the full `Run` type which carries
 *  heavy fields (steps, output_data) the picker doesn't use. */
interface NodeRunSummary {
  id: string;
  integration_id: string;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
}

/**
 * TestNodeOverlay — replay a past run's input through the *currently
 * configured* node and show what it produces.
 *
 * Why this exists: the Run drawer shows what HAPPENED. This dialog
 * answers "what WOULD happen now if I re-ran step X with my latest
 * tweaks?". The integration's saved config doesn't matter — we use
 * the live in-store node, including any unsaved edits — and we don't
 * re-execute upstream stages, just feed the historical input straight
 * into this node.
 *
 * Three states:
 *   1. Picking a run        — list recent runs for the integration,
 *                             sorted desc; click one to load its input
 *                             for this node. The "or provide manual
 *                             input" path lives at the head of the
 *                             list as a forge-tinted alternate, not as
 *                             a footer escape hatch.
 *   2. Reviewing the input  — JSON preview of the derived input + a Run
 *                             button. Provenance row shows where the
 *                             input came from (run id + relative time).
 *   3. Result               — output JSON in a "result inscribed" card,
 *                             status pip, tabular duration. Run again
 *                             with one click; pick a different run with
 *                             another.
 *
 * Visual direction matches Solder's editorial / drafting vocabulary,
 * sibling to `code-templates-overlay.tsx` and `code-ref-overlay.tsx`:
 *   - portal-rendered, AnimatePresence-wrapped, centered
 *   - glass-rail wrapper, eyebrow + display title, measure-rule rhythm
 *   - 2px forge rail on row hover (Select.tsx vocabulary)
 *   - provenance row with forge / emerald left edge for the picked run
 *   - measure-rule above each phase's footer so buttons read as a
 *     dimensioned annotation instead of a stray strip of UI
 */

interface Props {
  node: SolderNode;
  integrationId: string | null;
  onClose: () => void;
}

type Phase = 'pick' | 'review' | 'result';

export default function TestNodeOverlay({ node, integrationId, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [runs, setRuns] = useState<NodeRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const [inputJson, setInputJson] = useState('null');
  const [inputErr, setInputErr] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    kind: string;
    duration_ms: number;
    output?: unknown;
    error?: string;
    error_kind?: string | null;
  } | null>(null);

  // Re-build the dispatch payload from the live store so unsaved config
  // edits get tested. Cheap on each render — overlay only mounts on Test.
  const liveNode = useIntegrationStore((s) => findById(s.nodes, node.id) ?? node);

  // Load runs filtered to those where THIS node actually executed —
  // server-side JSONB containment filter via /api/nodes/runs. Avoids
  // showing the user a list of runs and only revealing post-pick that
  // the node never ran in any of them.
  useEffect(() => {
    if (phase !== 'pick') return;
    if (!integrationId) {
      setRuns([]);
      return;
    }
    setRunsLoading(true);
    api
      .listRunsForNode(integrationId, liveNode.id, 50)
      .then((rs) => setRuns(rs))
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false));
  }, [phase, integrationId, liveNode.id]);

  // Esc closes; mirrors the other two overlays.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handlePickRun(runId: string) {
    if (!integrationId) return;
    setPickedRunId(runId);
    try {
      const r = await api.getReplayInput(runId, liveNode.id);
      if (r.found) {
        setInputJson(JSON.stringify(r.input_data ?? null, null, 2));
        setInputErr('');
      } else {
        setInputJson('null');
        setInputErr(r.note || 'this node did not run in the picked run');
      }
    } catch (e) {
      setInputErr(e instanceof Error ? e.message : 'failed to derive input');
      setInputJson('null');
    }
    setPhase('review');
  }

  async function handleRun() {
    setInputErr('');
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(inputJson);
    } catch (e) {
      setInputErr(e instanceof Error ? e.message : 'invalid JSON');
      return;
    }
    setRunning(true);
    setResult(null);
    const persistResult = useTestResultStore.getState().setResult;
    try {
      const out = await api.testNode({
        node: liveNode as unknown as Record<string, unknown>,
        input_data: parsedInput,
      });
      setResult(out);
      // Persist for the editor's inline output panel — outlives the
      // modal so the user sees the last result without re-opening.
      persistResult(liveNode.id, {
        ok: out.ok,
        kind: out.kind,
        duration_ms: out.duration_ms,
        output: out.output,
        stdout: out.stdout ?? undefined,
        error: out.error,
        error_kind: out.error_kind ?? null,
        source_run_id: pickedRunId,
        finished_at: Date.now(),
      });
      setPhase('result');
    } catch (e) {
      const failed = {
        ok: false,
        kind: `${liveNode.kind}.${liveNode.action}`,
        duration_ms: 0,
        error: e instanceof Error ? e.message : 'request failed',
      };
      setResult(failed);
      persistResult(liveNode.id, {
        ...failed,
        error_kind: null,
        source_run_id: pickedRunId,
        finished_at: Date.now(),
      });
      setPhase('result');
    } finally {
      setRunning(false);
    }
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="test-node-overlay-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        className="fixed inset-0 z-50 grid place-items-center bg-surface-950/40 backdrop-blur-sm p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="test-node-overlay"
      >
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16, ease: [0.2, 0.7, 0.3, 1] }}
          className="glass-rail rounded-xl w-full max-w-2xl px-5 pt-4 pb-4 max-h-[85vh] overflow-y-auto solder-scroll-thin"
          onClick={(e) => e.stopPropagation()}
        >
          <Header node={liveNode} phase={phase} onBack={() => setPhase('pick')} onClose={onClose} />

          <div className="measure-rule mt-3 mb-3" />

          {phase === 'pick' && (
            <PickPhase
              runs={runs}
              loading={runsLoading}
              integrationId={integrationId}
              onPick={handlePickRun}
              onSkip={() => {
                setPickedRunId(null);
                setInputJson('{}');
                setInputErr('');
                setPhase('review');
              }}
            />
          )}

          {phase === 'review' && (
            <ReviewPhase
              inputJson={inputJson}
              setInputJson={setInputJson}
              inputErr={inputErr}
              running={running}
              onRun={handleRun}
              pickedRunId={pickedRunId}
              runs={runs}
            />
          )}

          {phase === 'result' && result && (
            <ResultPhase
              result={result}
              running={running}
              onRunAgain={handleRun}
              onPickDifferent={() => {
                setResult(null);
                setPhase('pick');
              }}
            />
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

// ── Header ──────────────────────────────────────────────────────────────

function Header({
  node,
  phase,
  onBack,
  onClose,
}: {
  node: SolderNode;
  phase: Phase;
  onBack: () => void;
  onClose: () => void;
}) {
  // Eyebrow tracks which phase we're in so the user knows whether the
  // ← back affordance lands them somewhere useful — same pattern the
  // ref-overlay uses for its two-stage picker.
  const eyebrow =
    phase === 'pick'
      ? 'test · stage 1 · pick a source'
      : phase === 'review'
        ? 'test · stage 2 · review input'
        : 'test · stage 3 · result';
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h3 className="font-display text-lg text-surface-900 dark:text-surface-50 truncate leading-tight">
          {node.label || `${node.kind}.${node.action}`}
          <span className="ml-2 text-[11px] font-mono text-surface-400 dark:text-surface-500">
            {node.id}
          </span>
        </h3>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {phase !== 'pick' && (
          <button
            type="button"
            onClick={onBack}
            className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-500 hover:text-forge-600 dark:text-surface-400 dark:hover:text-forge-400 transition-colors"
            data-testid="test-node-back"
          >
            ← back
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 text-lg leading-none px-1"
          aria-label="Close test overlay"
          data-testid="test-node-close"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ── Phase 1: pick a run ────────────────────────────────────────────────

function PickPhase({
  runs,
  loading,
  integrationId,
  onPick,
  onSkip,
}: {
  runs: NodeRunSummary[];
  loading: boolean;
  integrationId: string | null;
  onPick: (runId: string) => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">
        Replay a past run's input, or hand-write your own. The node executes with its{' '}
        <span className="font-mono text-surface-700 dark:text-surface-200">current</span>{' '}
        configuration — not the config that was active during a picked run.
      </p>

      {/* Manual-input affordance — promoted from a footer escape hatch
          to a forge-tinted alternate at the head of the list, so users
          read this surface as a binary "pick a past run OR write your
          own" choice. Mirrors the whole-output card in code-ref-overlay
          (forge ring + 2px rail + matching tonal text). */}
      <button
        type="button"
        onClick={onSkip}
        className="group relative w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-md ring-1 ring-forge-500/30 bg-forge-500/[0.04] hover:bg-forge-500/[0.10] hover:ring-forge-500/50 dark:bg-forge-500/[0.07] dark:hover:bg-forge-500/[0.14] transition-colors"
        data-testid="test-node-skip"
      >
        <span
          aria-hidden="true"
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-forge-500"
        />
        <span className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-[11px] leading-none bg-forge-500/15 text-forge-700 ring-1 ring-forge-500/30 dark:bg-forge-500/20 dark:text-forge-300 dark:ring-forge-500/40">
          ✎
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-mono text-forge-700 dark:text-forge-300">
            provide JSON manually
          </span>
          <span className="block text-[11px] text-surface-500 dark:text-surface-400">
            paste any value to test against the live config
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-forge-600/80 dark:text-forge-400/80 group-hover:text-forge-700 dark:group-hover:text-forge-300 transition-colors">
          manual
        </span>
      </button>

      {/* Past-runs section — eyebrow caption matches code-ref-overlay's
          Section pattern, dotted dividers between rows, row chrome
          inherits the Select.tsx hover vocabulary. */}
      <div>
        <div className="flex items-baseline justify-between mb-1 px-0.5">
          <span className="eyebrow">Past runs</span>
          <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
            {integrationId && !loading ? runs.length.toString().padStart(2, '0') : '—'}
          </span>
        </div>

        {!integrationId ? (
          <div className="px-3 py-4 rounded-md ring-1 ring-dashed ring-surface-200 dark:ring-surface-800 bg-surface-50/60 dark:bg-surface-900/40">
            <p className="text-[11px] font-mono text-surface-500 dark:text-surface-400 text-center">
              save the integration first to record runs
            </p>
          </div>
        ) : loading ? (
          <div className="px-3 py-4 rounded-md ring-1 ring-dashed ring-surface-200 dark:ring-surface-800 bg-surface-50/60 dark:bg-surface-900/40">
            <p className="text-[11px] font-mono italic text-surface-400 dark:text-surface-500 text-center">
              loading runs…
            </p>
          </div>
        ) : runs.length === 0 ? (
          <div className="px-3 py-4 rounded-md ring-1 ring-dashed ring-surface-200 dark:ring-surface-800 bg-surface-50/60 dark:bg-surface-900/40">
            <p className="text-[11px] font-mono text-surface-500 dark:text-surface-400 text-center">
              no past runs touched this node — use manual input above
            </p>
          </div>
        ) : (
          <ul className="max-h-72 overflow-y-auto solder-scroll-thin divide-y divide-dashed divide-surface-200/60 dark:divide-surface-800/60 rounded-md ring-1 ring-surface-200 dark:ring-surface-800">
            {runs.slice(0, 50).map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onPick(r.id)}
                  className="group relative w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10] transition-colors"
                  data-testid={`test-node-run-${r.id}`}
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r bg-forge-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                  <span className="flex-shrink-0 text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500 w-6">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <StatusPip status={r.status} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-mono tabular-nums text-surface-800 dark:text-surface-100 truncate">
                      {r.id.slice(0, 8)}
                    </span>
                    <span className="block text-[10px] font-mono uppercase tracking-[0.12em] text-surface-400 dark:text-surface-500 truncate">
                      {r.status} · {relativeTime(r.created_at)}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-surface-400 dark:text-surface-500 group-hover:text-forge-600 dark:group-hover:text-forge-400 transition-colors">
                    ▸
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusPip({ status }: { status: string }) {
  const tone =
    status === 'success' || status === 'completed'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-rose-500'
        : status === 'running'
          ? 'bg-sky-500 animate-pulse'
          : 'bg-surface-300 dark:bg-surface-600';
  return (
    <span
      className={`flex-shrink-0 inline-block w-2 h-2 rounded-full ${tone}`}
      aria-hidden="true"
    />
  );
}

// ── Phase 2: review the input + run ────────────────────────────────────

function ReviewPhase({
  inputJson,
  setInputJson,
  inputErr,
  running,
  onRun,
  pickedRunId,
  runs,
}: {
  inputJson: string;
  setInputJson: (s: string) => void;
  inputErr: string;
  running: boolean;
  onRun: () => void;
  pickedRunId: string | null;
  runs: NodeRunSummary[];
}) {
  const pickedRun = useMemo(
    () => runs.find((r) => r.id === pickedRunId) ?? null,
    [pickedRunId, runs]
  );

  return (
    <div className="space-y-3">
      {/* Provenance — same vocabulary as code-ref-overlay's Stage 2:
          coloured 2px left edge, mono caption with run id + relative
          time. Forge tint when replaying a run, neutral when manual. */}
      <div className="relative flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-md bg-surface-50/70 dark:bg-surface-900/50 ring-1 ring-surface-200/70 dark:ring-surface-800/70">
        <span
          aria-hidden="true"
          className={`absolute left-0 top-1 bottom-1 w-[2px] rounded-r ${
            pickedRun ? 'bg-emerald-500' : 'bg-forge-500'
          }`}
        />
        <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-500 dark:text-surface-400 flex-shrink-0">
          input
        </span>
        <span className="text-[10px] font-mono text-surface-500 dark:text-surface-400 truncate">
          {pickedRun ? (
            <>
              replay of run{' '}
              <span className="text-surface-800 dark:text-surface-100">
                {pickedRun.id.slice(0, 8)}
              </span>{' '}
              · {relativeTime(pickedRun.created_at)}
            </>
          ) : (
            <>manual · paste any JSON value</>
          )}
        </span>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1 px-0.5">
          <span className="eyebrow">JSON input</span>
          <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
            {inputJson.split('\n').length}L
          </span>
        </div>
        <textarea
          className="input w-full font-mono text-xs"
          rows={10}
          value={inputJson}
          onChange={(e) => setInputJson(e.currentTarget.value)}
          spellCheck={false}
          data-testid="test-node-input-json"
        />
      </div>

      {inputErr && <div className="alert alert-info text-[11px] font-mono">{inputErr}</div>}

      <div className="measure-rule" />

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onRun}
          className="btn btn-primary"
          disabled={running}
          data-testid="test-node-run"
        >
          {running ? 'Running…' : 'Run with current config'}
        </button>
      </div>
    </div>
  );
}

// ── Phase 3: result ─────────────────────────────────────────────────────

function ResultPhase({
  result,
  running,
  onRunAgain,
  onPickDifferent,
}: {
  result: NonNullable<Parameters<typeof setResultStub>[0]>;
  running: boolean;
  onRunAgain: () => void;
  onPickDifferent: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* Status row — provenance vocabulary again, coloured rail tracks
          the result's pass/fail signal. duration_ms gets the tabular
          mono treatment so successive runs read as a comparable column
          rather than a wandering caption. */}
      <div className="relative flex items-center gap-2.5 pl-3 pr-2 py-1.5 rounded-md bg-surface-50/70 dark:bg-surface-900/50 ring-1 ring-surface-200/70 dark:ring-surface-800/70">
        <span
          aria-hidden="true"
          className={`absolute left-0 top-1 bottom-1 w-[2px] rounded-r ${
            result.ok ? 'bg-emerald-500' : 'bg-rose-500'
          }`}
        />
        <span
          className={`flex-shrink-0 inline-block w-2 h-2 rounded-full ${
            result.ok ? 'bg-emerald-500' : 'bg-rose-500'
          }`}
          aria-hidden="true"
        />
        <span
          className={`text-[10px] font-mono uppercase tracking-[0.15em] flex-shrink-0 ${
            result.ok
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-rose-700 dark:text-rose-300'
          }`}
        >
          {result.ok ? 'success' : 'failed'}
        </span>
        <span className="text-[10px] font-mono text-surface-500 dark:text-surface-400 truncate">
          {result.kind}
        </span>
        <span className="ml-auto text-[10px] font-mono tabular-nums text-surface-500 dark:text-surface-400 flex-shrink-0">
          {result.duration_ms.toString().padStart(4, ' ')}ms
        </span>
      </div>

      {result.error && (
        <div className="alert alert-danger text-xs">
          <span className="font-mono uppercase tracking-[0.1em] text-[10px]">
            {result.error_kind ?? 'error'}:
          </span>{' '}
          {result.error}
        </div>
      )}

      {/* Output — "result inscribed" card. Distinct chrome from .input
          (no inset focusable feel) so users can tell at a glance that
          this is a read-only inscription, not an editable field. The
          inner header strip mirrors the snippet-preview ribbon in
          code-templates-overlay so the surfaces feel cut from the same
          cloth. */}
      <div>
        <div className="flex items-baseline justify-between mb-1 px-0.5">
          <span className="eyebrow">Output</span>
          <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
            {prettyJson(result.output).split('\n').length}L
          </span>
        </div>
        <div className="rounded-md ring-1 ring-surface-200 dark:ring-surface-800 bg-surface-50/80 dark:bg-surface-950/80 overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-2 py-[3px] bg-surface-100/70 dark:bg-surface-900/70 border-b border-surface-200/60 dark:border-surface-800/70">
            <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500">
              /* output */
            </span>
            <span className="font-mono text-[9px] tabular-nums text-surface-400 dark:text-surface-500">
              {result.ok ? 'inscribed' : 'no value'}
            </span>
          </div>
          <pre className="font-mono text-xs leading-[1.5] px-3 py-2 whitespace-pre-wrap break-words max-h-72 overflow-y-auto solder-scroll-thin text-surface-700 dark:text-surface-200">
            {prettyJson(result.output)}
          </pre>
        </div>
      </div>

      <div className="measure-rule" />

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onPickDifferent}
          className="btn btn-ghost text-xs"
        >
          Pick a different run
        </button>
        <button
          type="button"
          onClick={onRunAgain}
          className="btn btn-primary"
          disabled={running}
          data-testid="test-node-run-again"
        >
          {running ? 'Running…' : 'Run again'}
        </button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function findById(nodes: SolderNode[], id: string): SolderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.branches) {
      for (const arr of Object.values(n.branches)) {
        const sub = findById(arr, id);
        if (sub) return sub;
      }
    }
  }
  return null;
}

function prettyJson(v: unknown): string {
  if (v === undefined) return '(no output)';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Relative-time copy ("12s ago", "3m ago", "2h ago") for run timestamps.
 * Mirrors the helper in `code-output-panel.tsx` so the picker rows and
 * the editor's persistent output panel speak the same time language.
 * Accepts ISO strings (what the API returns) or epoch ms.
 */
function relativeTime(input: string | number | null | undefined): string {
  if (input == null) return '—';
  const ts = typeof input === 'string' ? Date.parse(input) : input;
  if (!Number.isFinite(ts)) return '—';
  const ms = Math.max(0, Date.now() - ts);
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Type stub so `ResultPhase` can be typed without importing the inline
// shape twice. Never invoked.
function setResultStub(
  _r: {
    ok: boolean;
    kind: string;
    duration_ms: number;
    output?: unknown;
    error?: string;
    error_kind?: string | null;
  } | null
) {
  void _r;
}
