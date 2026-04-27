import { useState } from 'react';
import { useTestResultStore } from '@/stores/test-results';

/**
 * Per-node test-output panel rendered under the Python source editor.
 * Reads from `useTestResultStore` keyed by `nodeId`, so it surfaces
 * whatever the most recent Test (modal or — eventually — inline)
 * produced for THIS node, and survives between modal dismissals.
 *
 * Three tabs:
 *   - Output  — `result` value, prettified.
 *   - Stdout  — captured `print()` output.
 *   - Error   — `error` + `error_kind` chip + (when parseable) the
 *               source line the traceback points at, with a
 *               click-to-copy line button. Errors highlight the tab.
 *
 * Hidden until a result lands. Once a result is present, stays
 * visible (collapsed by default if the user dismissed it) so you can
 * compare iterations.
 */

type Tab = 'output' | 'stdout' | 'error';

interface Props {
  nodeId: string;
}

export default function CodeOutputPanel({ nodeId }: Props) {
  const result = useTestResultStore((s) => s.byNodeId[nodeId]);
  const clearResult = useTestResultStore((s) => s.clearResult);
  const [tab, setTab] = useState<Tab>('output');
  const [collapsed, setCollapsed] = useState(false);

  // No result yet — render nothing. Editor's helper copy already tells
  // the user about the Test button; an empty panel here would be noise.
  if (!result) return null;

  const stdout = (result.stdout ?? '').trim();
  const hasStdout = stdout.length > 0;
  const hasError = !!result.error;
  // Auto-flip to the most relevant tab when a new result lands and the
  // current tab is empty. Errors always win.
  const effectiveTab = hasError && tab !== 'error' ? 'error' : tab;

  const toneRing =
    'ring-1 ring-surface-200/70 bg-surface-50/40 dark:ring-surface-800/70 dark:bg-surface-900/40';

  return (
    <div className={`mt-3 rounded-md ${toneRing} overflow-hidden`} data-testid="code-output-panel">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-surface-200/70 dark:border-surface-800/70">
        <StatusPip ok={result.ok} />
        <span className="text-[11px] font-mono text-surface-700 dark:text-surface-200">
          {result.ok ? 'success' : 'failed'}
        </span>
        <span className="text-[11px] font-mono text-surface-400 dark:text-surface-500">
          · {result.kind} · {result.duration_ms}ms
        </span>
        {result.source_run_id && (
          <span
            className="text-[10px] font-mono text-surface-400 dark:text-surface-500 truncate"
            title={`replayed from run ${result.source_run_id}`}
          >
            ↺ {result.source_run_id.slice(0, 8)}
          </span>
        )}
        <span className="text-[10px] font-mono text-surface-400 dark:text-surface-500 ml-auto">
          {relativeTime(result.finished_at)}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 text-[11px] leading-none px-1"
          aria-label={collapsed ? 'Expand output panel' : 'Collapse output panel'}
        >
          {collapsed ? '▾' : '▴'}
        </button>
        <button
          type="button"
          onClick={() => clearResult(nodeId)}
          className="text-surface-400 hover:text-rose-500 text-[12px] leading-none px-1"
          aria-label="Dismiss output panel"
          data-testid="code-output-clear"
        >
          ×
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="flex items-center gap-0 px-2 py-1 border-b border-surface-200/70 dark:border-surface-800/70 text-[11px] font-mono">
            <TabBtn
              active={effectiveTab === 'output'}
              onClick={() => setTab('output')}
              testid="code-output-tab-output"
            >
              Output
            </TabBtn>
            <TabBtn
              active={effectiveTab === 'stdout'}
              onClick={() => setTab('stdout')}
              dim={!hasStdout}
              testid="code-output-tab-stdout"
            >
              Stdout
              {hasStdout && (
                <span className="ml-1 text-[10px] tabular-nums text-surface-400 dark:text-surface-500">
                  ({stdout.split('\n').length})
                </span>
              )}
            </TabBtn>
            {hasError && (
              <TabBtn
                active={effectiveTab === 'error'}
                onClick={() => setTab('error')}
                tone="danger"
                testid="code-output-tab-error"
              >
                Error
                {result.error_kind && (
                  <span className="ml-1 text-[10px] tabular-nums">
                    ({result.error_kind})
                  </span>
                )}
              </TabBtn>
            )}
          </div>

          <div className="px-3 py-2 max-h-64 overflow-auto solder-scroll-thin">
            {effectiveTab === 'output' && <OutputBody value={result.output} />}
            {effectiveTab === 'stdout' && <StdoutBody text={stdout} />}
            {effectiveTab === 'error' && hasError && (
              <ErrorBody error={result.error ?? ''} kind={result.error_kind ?? null} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatusPip({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
        ok ? 'bg-emerald-500' : 'bg-rose-500'
      }`}
      aria-hidden="true"
    />
  );
}

function TabBtn({
  active,
  onClick,
  testid,
  children,
  tone,
  dim,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
  tone?: 'danger';
  dim?: boolean;
}) {
  const base = 'px-2 py-1 rounded-md transition-colors';
  const inactive = dim
    ? 'text-surface-400 dark:text-surface-600 hover:text-surface-600 dark:hover:text-surface-300'
    : 'text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50';
  const activeCls =
    tone === 'danger'
      ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/30'
      : 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-surface-50';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`${base} ${active ? activeCls : inactive}`}
    >
      {children}
    </button>
  );
}

function OutputBody({ value }: { value: unknown }) {
  if (value === undefined) {
    return (
      <p className="text-[11px] font-mono italic text-surface-400 dark:text-surface-500">
        no output (set <code className="not-italic">result</code> in the source)
      </p>
    );
  }
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-words text-surface-800 dark:text-surface-100">
      {prettyJson(value)}
    </pre>
  );
}

function StdoutBody({ text }: { text: string }) {
  if (!text) {
    return (
      <p className="text-[11px] font-mono italic text-surface-400 dark:text-surface-500">
        nothing printed
      </p>
    );
  }
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-words text-surface-700 dark:text-surface-200">
      {text}
    </pre>
  );
}

function ErrorBody({ error, kind }: { error: string; kind: string | null }) {
  // Try to surface the offending source line — Python tracebacks emit
  // `File "<sandbox>", line N` for in-script errors. When we find one,
  // render a small "line N" badge above the trace; clicking it copies
  // the line number to the clipboard so the user can paste-search in
  // CodeMirror (a future pass can wire this to a CM6 cursor jump).
  const lineMatch = error.match(/File "<sandbox>", line (\d+)/);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-mono">
        {kind && (
          <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/30">
            {kind}
          </span>
        )}
        {line !== null && (
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(String(line))}
            className="px-1.5 py-0.5 rounded bg-surface-100 text-surface-700 ring-1 ring-surface-200 hover:bg-surface-200 dark:bg-surface-800 dark:text-surface-200 dark:ring-surface-700"
            title="Copy line number"
          >
            line {line}
          </button>
        )}
      </div>
      <pre className="text-xs font-mono whitespace-pre-wrap break-words text-rose-700 dark:text-rose-200">
        {error}
      </pre>
    </div>
  );
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function relativeTime(ts: number): string {
  const ms = Math.max(0, Date.now() - ts);
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
