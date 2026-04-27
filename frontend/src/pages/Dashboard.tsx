import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, type Integration, type Run } from '@/api/client';
import { useEnvironmentStore } from '@/stores/environment';
import PageHeader from '@/components/PageHeader';
import EmptyFrame from '@/components/EmptyFrame';
import { IntegrationRowSkeleton } from '@/components/Skeleton';

function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return 'Burning the midnight oil';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return '—';
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
    case 'success':
    case 'active':
      return 'chip-success';
    case 'failed':
      return 'chip-danger';
    case 'running':
      return 'chip-info';
    default:
      return 'chip-neutral';
  }
}

/**
 * Dashboard — workbench landing surface. Three layers:
 *
 *   NOW         — integrations whose next move is yours (cards, asymmetric)
 *   OPERATING   — live integrations and recent run signal (list, dense)
 *   AT A GLANCE — system-health strip sealed by measure-rules (CAD callout)
 *
 * The composition is deliberately not a card grid. Whitespace and the
 * measure-rule dividers sell the drafting-paper direction. Embers cameo lives
 * behind the NOW strip, low-intensity, no parallax (vs full Builder canvas).
 */
export default function Dashboard() {
  const env = useEnvironmentStore((s) => s.environment);

  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [ints, rs] = await Promise.all([
          api.listIntegrations(),
          api.listRuns()
        ]);
        if (cancelled) return;
        setIntegrations(ints);
        setRuns(rs);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load workbench');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const lastRunByIntegration = useMemo(() => {
    const m = new Map<string, Run>();
    for (const r of runs) {
      const prev = m.get(r.integration_id);
      if (!prev || new Date(r.created_at) > new Date(prev.created_at)) {
        m.set(r.integration_id, r);
      }
    }
    return m;
  }, [runs]);

  const live = useMemo(
    () =>
      integrations.filter(
        (i) => i.is_active !== false && i.status !== 'disabled' && i.is_library !== true
      ),
    [integrations]
  );

  const drafts = useMemo(
    () =>
      live.filter(
        (i) => (i.status ?? 'draft') === 'draft' && (i.config?.nodes?.length ?? 0) === 0
      ),
    [live]
  );

  const operating = useMemo(
    () =>
      live
        .filter((i) => !drafts.includes(i))
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        ),
    [live, drafts]
  );

  // Naive "needs you" heuristic for now: drafts with no nodes are hidden in the
  // dedicated drafts rail; Now strip surfaces nothing until intent/discovery
  // phases land. Empty state communicates that intent.
  const needsAttention: Integration[] = [];

  const today = new Date();
  const todayLabel = today.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  });

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        eyebrow={`workbench · ${todayLabel}`}
        title={`${greeting(today)}.`}
        description={
          <>
            You're operating in{' '}
            <span
              className={`chip ${
                env === 'production' ? 'chip-warn' : 'chip-info'
              }`}
            >
              env · {env === 'production' ? 'prod' : 'sandbox'}
            </span>
            . The environment switcher in the header changes this for every
            integration that hasn't overridden it.
          </>
        }
        action={
          <Link
            to="/integrations/new"
            className="btn btn-primary"
            data-testid="dashboard-new-integration"
          >
            + New Integration
          </Link>
        }
      />

      {error && (
        <div className="alert alert-danger mb-6">{error}</div>
      )}

      {/* NOW strip ------------------------------------------------------- */}
      <section className="mb-10 relative">
        <NowStripBackdrop />
        <div className="relative">
          <div className="flex items-baseline gap-2 mb-3">
            <span className="eyebrow">now</span>
            <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
              {String(needsAttention.length).padStart(2, '0')}
            </span>
            <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600">
              · waiting on you
            </span>
          </div>

          {needsAttention.length === 0 ? (
            <div className="card p-8 text-center bg-white/60 dark:bg-surface-900/60 backdrop-blur-sm">
              <p className="eyebrow mb-1">state · clear</p>
              <p className="text-base font-semibold text-surface-900 dark:text-surface-50">
                Nothing waiting on you.
              </p>
              <p className="mt-1 text-sm text-surface-500 dark:text-surface-400 max-w-sm mx-auto">
                Once intent capture and discovery phases land, integrations
                that need a confirmation will surface here.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {/* OPERATING + DRAFTS --------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 items-start">
        <section className="min-w-0">
          <div className="flex items-baseline justify-between mb-3">
            <div className="flex items-baseline gap-2">
              <span className="eyebrow">operating</span>
              <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
                {String(operating.length).padStart(2, '0')}
              </span>
              <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600">
                · live integrations
              </span>
            </div>
            <Link
              to="/integrations"
              className="text-[11px] font-mono uppercase tracking-[0.15em] text-surface-500 hover:text-primary-600 dark:text-surface-400 dark:hover:text-primary-400"
            >
              see all ↗
            </Link>
          </div>

          {loading ? (
            <div className="space-y-2">
              <IntegrationRowSkeleton />
              <IntegrationRowSkeleton />
              <IntegrationRowSkeleton />
            </div>
          ) : operating.length === 0 ? (
            <EmptyFrame
              label="state · empty"
              glyph="◇"
              title="No integrations running yet"
              description="Build your first one. Solder will spin up a mock-engine you can iterate against, then flip live when you're ready."
              action={
                <Link to="/integrations/new" className="btn btn-primary">
                  New Integration
                </Link>
              }
            />
          ) : (
            <ol className="space-y-1.5" data-testid="dashboard-operating">
              {operating.slice(0, 6).map((it, idx) => (
                <OperatingRow
                  key={it.id}
                  integration={it}
                  lastRun={lastRunByIntegration.get(it.id) ?? null}
                  index={idx}
                />
              ))}
            </ol>
          )}
        </section>

        <aside className="lg:sticky lg:top-6 self-start min-w-0">
          <div className="flex items-baseline justify-between mb-3">
            <div className="flex items-baseline gap-2">
              <span className="eyebrow">drafts</span>
              <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
                {String(drafts.length).padStart(2, '0')}
              </span>
            </div>
          </div>

          {loading ? (
            <div className="space-y-2">
              <IntegrationRowSkeleton />
              <IntegrationRowSkeleton />
            </div>
          ) : drafts.length === 0 ? (
            <div className="card p-4">
              <p className="eyebrow mb-1">state · idle</p>
              <p className="text-sm text-surface-500 dark:text-surface-400">
                No drafts in progress.
              </p>
              <Link
                to="/integrations/new"
                className="mt-3 btn btn-secondary w-full"
                data-testid="dashboard-drafts-new"
              >
                + New integration
              </Link>
            </div>
          ) : (
            <div className="card p-3 space-y-1">
              {drafts.slice(0, 6).map((d) => (
                <Link
                  key={d.id}
                  to={`/integrations/${d.id}`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-50 dark:hover:bg-surface-800/60"
                >
                  <span aria-hidden="true" className="text-surface-300 dark:text-surface-600">◇</span>
                  <span className="text-sm text-surface-800 dark:text-surface-200 truncate">
                    {d.name || 'Untitled'}
                  </span>
                  <span className="ml-auto text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
                    {formatRelative(d.updated_at)}
                  </span>
                </Link>
              ))}
              <Link
                to="/integrations/new"
                className="mt-2 btn btn-secondary w-full"
              >
                + New integration
              </Link>
            </div>
          )}
        </aside>
      </div>

      {/* AT A GLANCE ---------------------------------------------------- */}
      <section className="mt-10">
        <div className="measure-rule mb-3" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 font-mono text-[11px] text-surface-500 dark:text-surface-400 tabular-nums">
          <Glance label="integrations" value={String(live.length).padStart(2, '0')} />
          <Glance label="drafts" value={String(drafts.length).padStart(2, '0')} />
          <Glance label="runs · 7d" value={String(runs.slice(0, 999).length).padStart(2, '0')} />
          <Glance
            label="failed · 7d"
            value={String(runs.filter((r) => r.status === 'failed').length).padStart(2, '0')}
            tone={
              runs.filter((r) => r.status === 'failed').length > 0 ? 'warn' : undefined
            }
          />
          <Glance label="test banks" value="—" muted />
          <Glance label="mock sessions live" value="—" muted />
        </div>
        <div className="measure-rule mt-3" aria-hidden="true" />
      </section>
    </div>
  );
}

interface OperatingRowProps {
  integration: Integration;
  lastRun: Run | null;
  index: number;
}

function OperatingRow({ integration, lastRun, index }: OperatingRowProps) {
  const status = lastRun?.status ?? integration.status ?? 'draft';
  const triggerType = integration.trigger?.type ?? 'manual';
  const nodeCount = integration.config?.nodes?.length ?? 0;
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut', delay: 0.03 * index }}
    >
      <Link
        to={`/integrations/${integration.id}`}
        className="card px-4 py-3 flex items-center gap-3 hover:shadow-md transition-shadow"
        data-testid={`dashboard-operating-row-${integration.id}`}
      >
        <span
          aria-hidden="true"
          className="font-mono text-[11px] text-surface-300 dark:text-surface-700 w-6 tabular-nums"
        >
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="text-sm font-semibold text-surface-900 dark:text-surface-50 truncate">
          {integration.name}
        </span>
        <span className="chip chip-neutral">{triggerType}</span>
        <span className="ml-auto flex items-center gap-3 flex-shrink-0">
          <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
            {nodeCount} node{nodeCount === 1 ? '' : 's'}
          </span>
          <span className="text-[11px] font-mono text-surface-400 dark:text-surface-600 tabular-nums">
            {lastRun ? formatRelative(lastRun.created_at) : 'never run'}
          </span>
          <span className={`chip ${statusChipTone(status)}`}>{status}</span>
        </span>
      </Link>
    </motion.li>
  );
}

interface GlanceProps {
  label: string;
  value: string;
  tone?: 'warn';
  muted?: boolean;
}

function Glance({ label, value, tone, muted }: GlanceProps) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-surface-400 dark:text-surface-600">{label}</span>
      <span
        className={
          tone === 'warn'
            ? 'text-amber-600 dark:text-amber-300'
            : muted
              ? 'text-surface-300 dark:text-surface-700'
              : 'text-surface-700 dark:text-surface-200'
        }
      >
        {value}
      </span>
    </span>
  );
}

/**
 * Faint atmospheric backdrop for the NOW strip — radial bloom + diagonal hatch.
 * Reads as the same atelier as the canvas without recreating EmberCanvas's
 * particle system here. Pure CSS, zero runtime cost.
 */
function NowStripBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -inset-x-2 -inset-y-3 rounded-2xl overflow-hidden"
      style={{
        background:
          'radial-gradient(ellipse 600px 200px at 30% 50%, rgb(14 165 233 / 0.06), transparent 70%)'
      }}
    />
  );
}
