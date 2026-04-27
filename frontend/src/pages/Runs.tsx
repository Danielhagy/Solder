import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, type Integration, type Run } from '@/api/client';
import { RunRowSkeleton } from '@/components/Skeleton';
import PageHeader from '@/components/PageHeader';
import EmptyFrame from '@/components/EmptyFrame';

interface StepRecord {
  node_id?: string;
  node_type?: string;
  stage?: number;
  status?: string;
  output?: unknown;
  error?: string;
  condition_result?: unknown;
}

function formatDate(s: string) {
  return new Date(s).toLocaleString();
}

function statusDiscColor(status: string) {
  switch (status) {
    case 'success':
      return 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300';
    case 'failed':
      return 'text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300';
    case 'skipped':
      return 'text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300';
    case 'running':
      return 'text-primary-700 bg-primary-50 dark:bg-primary-950/40 dark:text-primary-300';
    default:
      return 'text-surface-600 bg-surface-50 dark:bg-surface-800 dark:text-surface-300';
  }
}

function statusChipTone(status: string) {
  switch (status) {
    case 'success':
      return 'chip-success';
    case 'failed':
      return 'chip-danger';
    case 'skipped':
      return 'chip-warn';
    case 'running':
      return 'chip-info';
    default:
      return 'chip-neutral';
  }
}

function asStep(raw: unknown): StepRecord {
  if (raw && typeof raw === 'object') return raw as StepRecord;
  return {};
}

function shortId(id?: string) {
  if (!id) return '';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function StepBlock({ step, index, isLast }: { step: StepRecord; index: number; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const status = step.status ?? 'unknown';
  const hasDetails =
    step.output !== undefined || step.error !== undefined || step.condition_result !== undefined;

  return (
    <li
      className="flex gap-3"
      data-testid={`step-${index}`}
    >
      <div className="flex flex-col items-center flex-shrink-0">
        <span
          className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-mono ${statusDiscColor(
            status
          )}`}
          title={status}
        >
          {status === 'success'
            ? '✓'
            : status === 'failed'
              ? '✕'
              : status === 'skipped'
                ? '·'
                : '…'}
        </span>
        {!isLast && <span className="flex-1 w-px bg-surface-200 dark:bg-surface-800 my-1" />}
      </div>
      <div className="flex-1 pb-4 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-sm text-surface-800 dark:text-surface-200">
            {step.node_type ?? 'unknown'}
          </span>
          {typeof step.stage === 'number' && (
            <span className="eyebrow">stage {step.stage}</span>
          )}
          <span className="text-xs font-mono text-surface-400 dark:text-surface-500">
            {shortId(step.node_id)}
          </span>
        </div>
        {step.error && (
          <pre className="mt-1 alert alert-danger text-xs whitespace-pre-wrap break-words font-mono overflow-auto max-h-40">
            {step.error}
          </pre>
        )}
        {hasDetails && !step.error && (
          <button
            type="button"
            className="mt-1 text-xs text-surface-500 hover:text-surface-900 dark:text-surface-400 dark:hover:text-surface-100"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'hide' : 'show'} output
          </button>
        )}
        {expanded && !step.error && (
          <pre className="mt-1 text-xs font-mono bg-surface-50 dark:bg-surface-900 text-surface-700 dark:text-surface-300 p-2 rounded overflow-auto max-h-60">
            {JSON.stringify(
              step.output ?? step.condition_result,
              null,
              2
            )}
          </pre>
        )}
      </div>
    </li>
  );
}

export default function Runs() {
  const [params, setParams] = useSearchParams();
  const integrationFilter = params.get('integration_id') ?? '';

  const [runs, setRuns] = useState<Run[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Run | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [runsData, integrationsData] = await Promise.all([
          api.listRuns(integrationFilter || undefined),
          api.listIntegrations()
        ]);
        if (cancelled) return;
        setRuns(runsData);
        setIntegrations(integrationsData);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load runs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [integrationFilter]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      try {
        const fresh = await api.getRun(selected.id);
        if (!cancelled) setSelected(fresh);
      } catch {
        // swallow: the cached row is still fine to render.
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of integrations) m.set(i.id, i.name);
    return m;
  }, [integrations]);

  const selectedIntegrationName = selected
    ? nameById.get(selected.integration_id) ?? selected.integration_id.slice(0, 8)
    : '';

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        eyebrow="runs"
        title="Runs"
        description="Last 100 executions across every integration. Pick a row for the per-step trace. Environment + error-corpus filters land alongside v1 phases."
        action={
          <div className="flex items-center gap-2">
            <label className="eyebrow">filter</label>
            <select
              className="input text-sm py-1.5"
              value={integrationFilter}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v) setParams({ integration_id: v });
                else setParams({});
                setSelected(null);
              }}
              data-testid="runs-filter"
            >
              <option value="">All integrations</option>
              {integrations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
        }
      />

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6" data-testid="runs-skeleton">
          <div className="space-y-3">
            <RunRowSkeleton />
            <RunRowSkeleton />
            <RunRowSkeleton />
            <RunRowSkeleton />
          </div>
          <div className="card p-12 text-center text-surface-400 dark:text-surface-500 min-w-0">
            Loading…
          </div>
        </div>
      ) : error ? (
        <div className="alert alert-danger">{error}</div>
      ) : runs.length === 0 ? (
        <EmptyFrame
          label="state · empty"
          glyph="◷"
          title="Nothing has run"
          description="Runs appear here after you build and execute an integration. Start with a blank canvas or ask the AI builder."
          action={
            <Link to="/integrations/new" className="btn btn-primary">
              Create an Integration
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
          <div className="space-y-3" data-testid="run-list">
            {runs.map((run, idx) => {
              const name =
                nameById.get(run.integration_id) ?? run.integration_id.slice(0, 8);
              return (
                <motion.button
                  key={run.id}
                  type="button"
                  className={`card p-4 w-full text-left hover:shadow-md transition-shadow ${
                    selected?.id === run.id ? 'ring-2 ring-primary-500' : ''
                  }`}
                  onClick={() => setSelected(run)}
                  data-testid={`run-row-${run.id}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut', delay: 0.03 * idx }}
                >
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <span className="text-sm font-medium text-surface-800 dark:text-surface-200 truncate">
                      {name}
                    </span>
                    <span className={`chip ${statusChipTone(run.status)}`}>
                      {run.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-surface-400 dark:text-surface-500">
                      {run.id.slice(0, 8)}
                    </span>
                    <span className="text-xs text-surface-500 dark:text-surface-400">
                      {formatDate(run.created_at)}
                    </span>
                  </div>
                </motion.button>
              );
            })}
          </div>

          <div className="min-w-0">
            {selected ? (
              <div className="card p-6 space-y-5" data-testid="run-detail">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="eyebrow mb-0.5">run · {selected.id.slice(0, 8)}</p>
                    <h2 className="text-lg font-semibold dark:text-surface-50">
                      {selectedIntegrationName}
                    </h2>
                    <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                      {formatDate(selected.created_at)}
                      {selected.completed_at && (
                        <>
                          {' · '}
                          completed {formatDate(selected.completed_at)}
                        </>
                      )}
                    </p>
                  </div>
                  <span className={`chip self-start ${statusChipTone(selected.status)}`}>
                    {selected.status}
                  </span>
                </div>

                {selected.error_message && (
                  <div>
                    <h3 className="eyebrow mb-1">error</h3>
                    <pre className="alert alert-danger text-sm whitespace-pre-wrap break-words font-mono overflow-auto">
                      {selected.error_message}
                    </pre>
                  </div>
                )}

                <div>
                  <h3 className="eyebrow mb-2">
                    steps {detailLoading && <span className="ml-1">(refreshing…)</span>}
                  </h3>
                  {selected.steps && selected.steps.length > 0 ? (
                    <ol className="space-y-0">
                      {selected.steps.map((raw, idx) => (
                        <StepBlock
                          key={idx}
                          step={asStep(raw)}
                          index={idx}
                          isLast={idx === (selected.steps?.length ?? 0) - 1}
                        />
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-surface-500 dark:text-surface-400">
                      No step records for this run.
                    </p>
                  )}
                </div>

                {selected.output_data !== undefined && selected.output_data !== null && (
                  <div>
                    <h3 className="eyebrow mb-1">final output</h3>
                    <pre className="text-sm bg-surface-50 p-2 rounded overflow-auto max-h-64 dark:bg-surface-900 dark:text-surface-200">
                      {JSON.stringify(selected.output_data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <EmptyFrame
                label="state · idle"
                glyph="·"
                compact
                fill
                title="Pick a run"
                description="Click a run on the left to replay every step it took, with timing and output."
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
