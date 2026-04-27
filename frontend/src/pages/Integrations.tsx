import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, type Integration, type Run } from '@/api/client';
import { IntegrationRowSkeleton } from '@/components/Skeleton';
import PageHeader from '@/components/PageHeader';
import EmptyFrame from '@/components/EmptyFrame';

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function statusChipTone(status: string | undefined): string {
  switch (status) {
    case 'active':
      return 'chip-success';
    case 'failed':
      return 'chip-danger';
    case 'success':
      return 'chip-success';
    case 'running':
      return 'chip-info';
    case 'disabled':
    case 'draft':
    default:
      return 'chip-neutral';
  }
}

export default function Integrations() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id') ?? '';

  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  // Detail pane: lazily fetch the selected integration's recent runs so
  // the list view doesn't pay the cost up front.
  const [detailRuns, setDetailRuns] = useState<Run[]>([]);
  const [detailRunsLoading, setDetailRunsLoading] = useState(false);

  async function loadIntegrations() {
    setLoading(true);
    try {
      const data = await api.listIntegrations();
      setIntegrations(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadIntegrations();
  }, []);

  // When the selection changes, fetch that integration's run history. We pull
  // the full list and slice on the client because /api/runs already supports
  // an integration_id filter and the per-integration row count is bounded.
  useEffect(() => {
    if (!selectedId) {
      setDetailRuns([]);
      return;
    }
    let cancelled = false;
    setDetailRunsLoading(true);
    (async () => {
      try {
        const runs = await api.listRuns(selectedId);
        if (!cancelled) setDetailRuns(runs);
      } catch {
        if (!cancelled) setDetailRuns([]);
      } finally {
        if (!cancelled) setDetailRunsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this integration?')) return;
    try {
      await api.deleteIntegration(id);
      // If the deleted row was the selected one, drop the selection so the
      // detail pane doesn't keep showing a stale ghost.
      if (id === selectedId) setParams({});
      await loadIntegrations();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete integration');
    }
  }

  function handleOpen(id: string) {
    navigate(`/integrations/${id}`);
  }

  function selectIntegration(id: string) {
    setParams({ id });
  }

  const visible = useMemo(
    () =>
      showDeleted
        ? integrations
        : integrations.filter(
            (i) => i.status !== 'disabled' && i.is_active !== false
          ),
    [integrations, showDeleted]
  );

  const main = useMemo(() => visible.filter((i) => i.is_library !== true), [visible]);
  const library = useMemo(() => visible.filter((i) => i.is_library === true), [visible]);

  const selected = useMemo(
    () => integrations.find((i) => i.id === selectedId) ?? null,
    [integrations, selectedId]
  );

  const deletedCount = useMemo(
    () =>
      integrations.filter(
        (i) => i.status === 'disabled' || i.is_active === false
      ).length,
    [integrations]
  );

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        eyebrow="integrations"
        title="Integrations"
        description="Standalone flows and reusable subprocesses. Pick a row to inspect; open in the Builder to edit."
        action={
          <Link to="/integrations/new" className="btn btn-primary">
            New Integration
          </Link>
        }
      />

      {error && (
        <div className="alert alert-danger mb-6 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            className="underline underline-offset-2 hover:no-underline"
            onClick={() => setError('')}
          >
            Dismiss
          </button>
        </div>
      )}

      {deletedCount > 0 && (
        <div className="mb-4 alert alert-info flex items-center justify-between gap-3 font-mono">
          <span>
            {deletedCount} deleted {deletedCount === 1 ? 'row' : 'rows'} hidden
          </span>
          <button
            type="button"
            className="text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50 transition-colors underline-offset-2 hover:underline"
            onClick={() => setShowDeleted((v) => !v)}
            data-testid="toggle-show-deleted"
          >
            {showDeleted ? 'hide deleted' : 'show deleted'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3" data-testid="integrations-skeleton">
          <IntegrationRowSkeleton />
          <IntegrationRowSkeleton />
          <IntegrationRowSkeleton />
        </div>
      ) : integrations.length === 0 ? (
        <EmptyFrame
          label="state · empty"
          glyph="◇"
          title="No integrations yet"
          description="Build your first integration on the canvas. Solder wires up nodes, connections and triggers into a durable workflow."
          action={
            <Link to="/integrations/new" className="btn btn-primary">
              New Integration
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">
          <div className="min-w-0 space-y-6">
            <ListSection
              label="main"
              count={main.length}
              caption="standalone integrations"
              empty="No standalone integrations yet."
            >
              {main.map((i, idx) => (
                <IntegrationRow
                  key={i.id}
                  integration={i}
                  index={idx}
                  selected={selectedId === i.id}
                  onSelect={() => selectIntegration(i.id)}
                  onOpen={() => handleOpen(i.id)}
                  onDelete={() => handleDelete(i.id)}
                />
              ))}
            </ListSection>
            <ListSection
              label="library"
              count={library.length}
              caption="reusable subprocesses"
              empty='No subprocesses yet. Save an integration with the "Reusable subprocess" toggle on to make it callable from other integrations.'
            >
              {library.map((i, idx) => (
                <IntegrationRow
                  key={i.id}
                  integration={i}
                  index={idx}
                  selected={selectedId === i.id}
                  onSelect={() => selectIntegration(i.id)}
                  onOpen={() => handleOpen(i.id)}
                  onDelete={() => handleDelete(i.id)}
                />
              ))}
            </ListSection>
          </div>

          <aside className="lg:sticky lg:top-6 self-start min-w-0">
            {selected ? (
              <DetailPane
                integration={selected}
                runs={detailRuns}
                runsLoading={detailRunsLoading}
                onOpen={() => handleOpen(selected.id)}
                onDelete={() => handleDelete(selected.id)}
              />
            ) : (
              <EmptyFrame
                label="state · idle"
                glyph="·"
                compact
                fill
                title="Pick an integration"
                description="Select a row to preview its trigger, node count, and recent runs."
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

interface ListSectionProps {
  label: string;
  count: number;
  caption: string;
  empty: string;
  children: React.ReactNode;
}

function ListSection({ label, count, caption, empty, children }: ListSectionProps) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="eyebrow">{label}</span>
        <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
          {String(count).padStart(2, '0')}
        </span>
        <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600">
          · {caption}
        </span>
      </div>
      {count === 0 ? (
        <p className="text-sm text-surface-500 dark:text-surface-400 py-4">{empty}</p>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </section>
  );
}

interface IntegrationRowProps {
  integration: Integration;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
  /**
   * Index within the rendered list. Drives the per-row stagger delay
   * so the list fans in top-to-bottom on mount — same pattern Dashboard
   * uses on its OPERATING strip, applied here for consistency.
   */
  index?: number;
}

function IntegrationRow({
  integration,
  selected,
  onSelect,
  onOpen,
  onDelete,
  index = 0
}: IntegrationRowProps) {
  const nodeCount = integration.config?.nodes?.length ?? 0;
  const triggerType = integration.trigger?.type ?? 'manual';
  const status = integration.status ?? 'draft';
  const isDeleted =
    integration.status === 'disabled' || integration.is_active === false;
  return (
    <motion.div
      role="button"
      tabIndex={0}
      data-testid={`integration-row-${integration.id}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut', delay: 0.03 * index }}
      className={`card p-4 flex items-center justify-between gap-4 cursor-pointer transition-shadow hover:shadow-md ${
        selected ? 'ring-1 ring-primary-400 dark:ring-primary-500/60' : ''
      } ${isDeleted ? 'opacity-60' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h3 className="text-base font-semibold text-surface-900 truncate dark:text-surface-50">
            {integration.name}
          </h3>
          <span className={`chip ${statusChipTone(status)}`}>{status}</span>
          {integration.is_library ? (
            <span className="chip chip-accent">subprocess</span>
          ) : (
            <span className="chip chip-neutral">{triggerType}</span>
          )}
          {isDeleted && <span className="chip chip-danger">deleted</span>}
        </div>
        {integration.description && (
          <p className="text-sm text-surface-600 mb-1 line-clamp-1 dark:text-surface-300">
            {integration.description}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-surface-500 font-mono dark:text-surface-400 tabular-nums">
          <span>
            {nodeCount} node{nodeCount === 1 ? '' : 's'}
          </span>
          <span className="text-surface-300 dark:text-surface-600">·</span>
          <span>updated {formatRelative(integration.updated_at)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          data-testid={`integration-open-${integration.id}`}
          className="btn btn-secondary"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          Open
        </button>
        <button
          type="button"
          aria-label="Delete integration"
          data-testid={`integration-delete-${integration.id}`}
          className="btn-icon hover:text-red-500 dark:hover:text-red-400"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
      </div>
    </motion.div>
  );
}

interface DetailPaneProps {
  integration: Integration;
  runs: Run[];
  runsLoading: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

function DetailPane({ integration, runs, runsLoading, onOpen, onDelete }: DetailPaneProps) {
  const status = integration.status ?? 'draft';
  const triggerType = integration.trigger?.type ?? 'manual';
  const nodeCount = integration.config?.nodes?.length ?? 0;
  const recent = runs.slice(0, 5);
  const successRate = runs.length
    ? Math.round(
        (runs.filter((r) => r.status === 'success').length / runs.length) * 100
      )
    : null;

  return (
    <div className="card p-4 space-y-4" data-testid="integration-detail">
      <div>
        <p className="eyebrow mb-1">
          integration · {integration.id.slice(0, 8)}
        </p>
        <h2 className="text-lg font-semibold dark:text-surface-50 truncate">
          {integration.name}
        </h2>
        {integration.description && (
          <p className="text-sm text-surface-600 dark:text-surface-300 mt-1 line-clamp-3">
            {integration.description}
          </p>
        )}
        <div className="flex items-center flex-wrap gap-1.5 mt-2">
          <span className={`chip ${statusChipTone(status)}`}>{status}</span>
          {integration.is_library ? (
            <span className="chip chip-accent">subprocess</span>
          ) : (
            <span className="chip chip-neutral">{triggerType}</span>
          )}
        </div>
      </div>

      <div className="measure-rule" aria-hidden="true" />

      <div>
        <p className="eyebrow mb-2">composition</p>
        <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
          <dt className="text-surface-500 dark:text-surface-400">nodes</dt>
          <dd className="font-mono tabular-nums text-surface-900 dark:text-surface-100 text-right">
            {nodeCount}
          </dd>
          <dt className="text-surface-500 dark:text-surface-400">trigger</dt>
          <dd className="font-mono text-surface-900 dark:text-surface-100 text-right">
            {triggerType}
          </dd>
          <dt className="text-surface-500 dark:text-surface-400">updated</dt>
          <dd className="font-mono tabular-nums text-surface-900 dark:text-surface-100 text-right">
            {formatRelative(integration.updated_at)}
          </dd>
          {successRate !== null && (
            <>
              <dt className="text-surface-500 dark:text-surface-400">pass rate</dt>
              <dd className="font-mono tabular-nums text-surface-900 dark:text-surface-100 text-right">
                {successRate}%
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="measure-rule" aria-hidden="true" />

      <div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="eyebrow">recent runs</span>
          <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
            {String(runs.length).padStart(2, '0')}
          </span>
        </div>
        {runsLoading ? (
          <p className="text-sm text-surface-500 dark:text-surface-400 py-2">
            Loading…
          </p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-surface-500 dark:text-surface-400 py-2">
            Nothing has run yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {recent.map((run) => (
              <li
                key={run.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <Link
                  to={`/runs?integration_id=${integration.id}`}
                  className="font-mono text-xs text-surface-500 dark:text-surface-400 hover:text-primary-600 dark:hover:text-primary-400 tabular-nums"
                  title={new Date(run.created_at).toLocaleString()}
                >
                  {run.id.slice(0, 8)}
                </Link>
                <span className="text-xs text-surface-500 dark:text-surface-400 tabular-nums">
                  {formatRelative(run.created_at)}
                </span>
                <span className={`chip ${statusChipTone(run.status)}`}>
                  {run.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        {runs.length > 0 && (
          <Link
            to={`/runs?integration_id=${integration.id}`}
            className="block mt-3 text-xs font-mono uppercase tracking-[0.15em] text-primary-600 dark:text-primary-400 hover:underline"
          >
            see all runs ↗
          </Link>
        )}
      </div>

      <div className="measure-rule" aria-hidden="true" />

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary flex-1"
          onClick={onOpen}
          data-testid="integration-detail-open"
        >
          Open in Builder
        </button>
        <button
          type="button"
          aria-label="Delete integration"
          className="btn-icon hover:text-red-500 dark:hover:text-red-400"
          onClick={onDelete}
          data-testid="integration-detail-delete"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
