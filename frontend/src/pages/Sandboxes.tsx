import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  brandLogoUrl,
  type Connection,
  type Connector,
  type SandboxMode,
} from '@/api/client';
import { CreateSandboxWizard } from '@/components/sandboxes/CreateSandboxWizard';

// ----------------------------------------------------------------------------
// Sandboxes — Sandboxes v1 surface (formerly Mocks).
//
// Each user-authored Connection has its own sandbox: either vendor sandbox
// creds, or a synthesised mock DB primed from OpenAPI + active probe + observed
// traffic. This page is the per-connection control room.
//
// Layout: left rail = list of connections (mode pill, coverage hint, last
// primed). Right pane = selected sandbox detail with four tabs (Endpoints,
// Records, Scenarios, Errors). The tab content stubs out until tasks #5–#8
// land — but the structural shell is fully wired.
// ----------------------------------------------------------------------------

const SANDBOX_TABS = [
  { id: 'endpoints', label: 'Endpoints', caption: 'discovered routes + coverage' },
  { id: 'records', label: 'Records', caption: 'synthesised population, per entity' },
  { id: 'scenarios', label: 'Scenarios', caption: 'saved presets the integration can request' },
  { id: 'errors', label: 'Errors', caption: 'aggregated error corpus, real failures' },
] as const;

type TabId = (typeof SANDBOX_TABS)[number]['id'];

const eyebrowStyle: React.CSSProperties = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 10,
  letterSpacing: '0.14em',
  color: 'var(--surface-500)',
  textTransform: 'uppercase',
};

function Eyebrow({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return <span style={{ ...eyebrowStyle, ...style }}>{children}</span>;
}

function formatRelative(iso: string | undefined | null): string {
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

function modeStyle(mode: SandboxMode): { color: string; label: string } {
  if (mode === 'vendor') return { color: 'var(--primary-400)', label: 'vendor sandbox' };
  if (mode === 'synthetic') return { color: 'var(--forge-400)', label: 'synthetic mock-db' };
  return { color: 'var(--surface-500)', label: 'no sandbox' };
}

/** Pull the synthetic-mode coverage % from sandbox_config, if present. Falls
 *  back to null when the connection isn't synthetic or hasn't been primed. */
function coverageFor(connection: Connection): number | null {
  if (connection.sandbox_mode !== 'synthetic') return null;
  const endpoints = (connection.sandbox_config?.endpoints ?? {}) as Record<
    string,
    { coverage_pct?: number }
  >;
  const values = Object.values(endpoints).map((e) => e?.coverage_pct ?? 0);
  if (values.length === 0) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(avg);
}

function lastPrimedFor(connection: Connection): string | null {
  if (connection.sandbox_mode !== 'synthetic') return null;
  const v = connection.sandbox_config?.last_primed_at;
  return typeof v === 'string' ? v : null;
}

export default function Sandboxes() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id') ?? '';
  const tab = (params.get('tab') as TabId) || 'endpoints';

  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const [cs, cn] = await Promise.all([api.listConnectors(), api.listConnections()]);
      setConnectors(cs);
      setConnections(cn);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sandboxes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const connectorById = useMemo(() => {
    const m = new Map<string, Connector>();
    for (const c of connectors) m.set(c.id, c);
    return m;
  }, [connectors]);

  const sorted = useMemo(() => {
    const arr = [...connections].sort((a, b) => {
      // Synthetic + vendor sandboxes float to the top (more interesting),
      // then by recency.
      const rank: Record<SandboxMode, number> = { synthetic: 0, vendor: 1, none: 2 };
      const dr = rank[a.sandbox_mode] - rank[b.sandbox_mode];
      if (dr !== 0) return dr;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    const needle = q.trim().toLowerCase();
    if (!needle) return arr;
    return arr.filter((c) => {
      const connector = c.connector_id ? connectorById.get(c.connector_id) : undefined;
      const haystack = [c.label, connector?.display_name ?? '', connector?.name ?? '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [connections, connectorById, q]);

  // Default selection — first one with a sandbox configured, else first.
  useEffect(() => {
    if (selectedId) return;
    const fallback = sorted.find((c) => c.sandbox_mode !== 'none')?.id ?? sorted[0]?.id;
    if (fallback) setParams({ id: fallback, tab }, { replace: true });
  }, [selectedId, sorted, setParams, tab]);

  const selected = useMemo(
    () => sorted.find((c) => c.id === selectedId) ?? null,
    [sorted, selectedId]
  );

  function selectConnection(id: string) {
    setParams({ id, tab });
  }
  function selectTab(next: TabId) {
    if (selectedId) setParams({ id: selectedId, tab: next });
  }
  async function refreshConnection(id: string) {
    try {
      const all = await api.listConnections();
      setConnections(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh');
    }
  }

  const counts = useMemo(() => {
    const out = { synthetic: 0, vendor: 0, none: 0 };
    for (const c of connections) out[c.sandbox_mode] += 1;
    return out;
  }, [connections]);

  return (
    <div
      className="sol-canvas"
      style={{
        padding: '28px 32px',
        minHeight: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
        fontFamily: 'Inter, system-ui, sans-serif',
        borderRadius: 12,
        margin: '0 auto',
        maxWidth: 1400,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(220px, 1fr) auto auto auto',
          gap: 18,
          alignItems: 'center',
          paddingBottom: 18,
          marginBottom: 22,
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <div>
          <Eyebrow style={{ marginBottom: 6, display: 'block' }}>SOLDER · WORKBENCH</Eyebrow>
          <h1
            style={{
              fontFamily: '"Space Grotesk", Inter, sans-serif',
              fontSize: 28,
              fontWeight: 600,
              color: 'var(--surface-50)',
              letterSpacing: '-0.02em',
              margin: 0,
              lineHeight: 1,
            }}
          >
            Sandboxes
          </h1>
        </div>

        <div
          className="solder-search-shell"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderRadius: 6,
            width: '100%',
          }}
        >
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              color: 'var(--surface-400)',
            }}
          >
            /
          </span>
          <input
            placeholder="search sandboxes by connector or label"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: 13,
              color: 'var(--surface-100)',
            }}
            data-testid="sandboxes-search"
          />
        </div>

        <div
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            color: 'var(--surface-400)',
            textAlign: 'right',
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          }}
        >
          <div>
            <span style={{ color: 'var(--forge-400)' }}>{counts.synthetic} synthetic</span> ·{' '}
            <span style={{ color: 'var(--primary-400)' }}>{counts.vendor} vendor</span>
          </div>
          <div style={{ color: 'var(--surface-500)' }}>{counts.none} not configured</div>
        </div>

        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          data-testid="sandboxes-from-spec"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '7px 12px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
            background: 'transparent',
            color: 'var(--surface-100)',
            border: '1px solid var(--forge-400)',
          }}
        >
          + Sandbox from Spec
        </button>
        <button
          type="button"
          onClick={() => navigate('/connections')}
          className="solder-cta-forge"
          data-testid="sandboxes-author-connection"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '7px 12px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          + Author Connection
        </button>
      </div>
      <CreateSandboxWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={async (id) => {
          setWizardOpen(false);
          await refresh();
          setParams({ id, tab: 'endpoints' });
        }}
      />

      {loading ? (
        <div data-testid="sandboxes-skeleton">
          <Eyebrow>loading…</Eyebrow>
        </div>
      ) : connections.length === 0 ? (
        <EmptyState onAuthor={() => navigate('/connections')} />
      ) : (
        <>
          {error && (
            <div
              style={{
                marginBottom: 18,
                padding: '10px 14px',
                border: '1px solid var(--rose-400)',
                borderRadius: 6,
                background: 'rgb(179 58 58 / 0.08)',
                color: 'var(--rose-500)',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 420px',
              gap: 28,
              alignItems: 'stretch',
            }}
          >
            <div data-testid="sandboxes-list">
              <Eyebrow style={{ display: 'block', marginBottom: 6, padding: '0 4px' }}>
                CONNECTIONS — {sorted.length}
              </Eyebrow>
              {sorted.map((c, idx) => (
                <SandboxRow
                  key={c.id}
                  idx={idx}
                  connection={c}
                  connector={c.connector_id ? connectorById.get(c.connector_id) : undefined}
                  selected={selectedId === c.id}
                  onSelect={() => selectConnection(c.id)}
                />
              ))}
            </div>

            <aside
              style={{
                background: 'var(--container-fill)',
                padding: '20px 22px 22px',
                borderRadius: 8,
                border: '1px solid var(--rule)',
                display: 'flex',
                flexDirection: 'column',
                alignSelf: 'stretch',
                boxShadow:
                  '0 1px 0 var(--container-glaze) inset, 0 8px 24px var(--container-shadow)',
              }}
              data-testid="sandbox-detail"
            >
              {selected ? (
                <SandboxDetail
                  connection={selected}
                  connector={
                    selected.connector_id ? connectorById.get(selected.connector_id) : undefined
                  }
                  tab={tab}
                  onTab={selectTab}
                  onConfigure={() =>
                    navigate(`/connections?id=${encodeURIComponent(selected.id)}`)
                  }
                  onConnectionRefresh={() => refreshConnection(selected.id)}
                />
              ) : (
                <div style={{ color: 'var(--surface-500)', fontSize: 13 }}>
                  <Eyebrow style={{ display: 'block', marginBottom: 8 }}>state · idle</Eyebrow>
                  Select a connection to inspect its sandbox.
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// List row — slim line with connector logo, label, mode pill, coverage hint.
// ----------------------------------------------------------------------------
function SandboxRow({
  idx,
  connection,
  connector,
  selected,
  onSelect,
}: {
  idx: number;
  connection: Connection;
  connector: Connector | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const logo = connector ? brandLogoUrl(connector.brand_domain) : null;
  const display = connector?.display_name ?? connection.label;
  const mode = modeStyle(connection.sandbox_mode);
  const coverage = coverageFor(connection);

  return (
    <div
      data-testid={`sandbox-row-${connection.id}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 28px 1fr auto auto',
        gap: 12,
        alignItems: 'center',
        padding: '10px 8px',
        borderTop: idx === 0 ? '1px solid var(--rule)' : 'none',
        borderBottom: '1px solid var(--rule)',
        background: selected ? 'rgb(194 65 12 / 0.10)' : 'transparent',
        boxShadow: selected ? 'inset 3px 0 0 var(--forge-500)' : 'none',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10,
          color: 'var(--surface-600)',
        }}
      >
        {String(idx + 1).padStart(2, '0')}
      </span>

      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 4,
          background: 'var(--container-fill)',
          border: '1px solid var(--rule)',
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {logo ? (
          <img
            src={logo}
            alt=""
            style={{ width: 18, height: 18, objectFit: 'contain' }}
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: '"Space Grotesk", Inter, sans-serif',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--surface-500)',
            }}
          >
            {display.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: '"Space Grotesk", Inter, sans-serif',
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--surface-50)',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {connection.label}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--surface-400)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: 1,
          }}
        >
          {connector ? connector.display_name : connection.auth_scheme}
        </div>
      </div>

      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5,
          color: mode.color,
          whiteSpace: 'nowrap',
        }}
      >
        {mode.label}
      </div>

      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5,
          color: 'var(--surface-500)',
          textAlign: 'right',
          minWidth: 80,
          lineHeight: 1.4,
        }}
      >
        {coverage !== null ? (
          <>
            coverage
            <br />
            <span style={{ color: 'var(--surface-300)' }}>{coverage}%</span>
          </>
        ) : (
          <>
            updated
            <br />
            {formatRelative(connection.updated_at)}
          </>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Detail pane — header, mode controls, tab strip, tab body.
// ----------------------------------------------------------------------------
function SandboxDetail({
  connection,
  connector,
  tab,
  onTab,
  onConfigure,
  onConnectionRefresh,
}: {
  connection: Connection;
  connector: Connector | undefined;
  tab: TabId;
  onTab: (next: TabId) => void;
  onConfigure: () => void;
  onConnectionRefresh: () => void;
}) {
  const logo = connector ? brandLogoUrl(connector.brand_domain) : null;
  const display = connector?.display_name ?? connection.label;
  const mode = modeStyle(connection.sandbox_mode);
  const coverage = coverageFor(connection);
  const lastPrimed = lastPrimedFor(connection);
  const activeTab = SANDBOX_TABS.find((t) => t.id === tab) ?? SANDBOX_TABS[0];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 3,
            background: 'var(--container-fill)',
            border: '1px solid var(--rule)',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {logo ? (
            <img
              src={logo}
              alt=""
              style={{ width: 13, height: 13, objectFit: 'contain' }}
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <span
              style={{
                fontFamily: '"Space Grotesk", Inter, sans-serif',
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--surface-500)',
              }}
            >
              {display.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <Eyebrow>SANDBOX · {connection.id.slice(0, 8)}</Eyebrow>
      </div>

      <div
        style={{
          fontFamily: '"Space Grotesk", Inter, sans-serif',
          fontSize: 21,
          fontWeight: 600,
          color: 'var(--surface-50)',
          letterSpacing: '-0.018em',
          lineHeight: 1.15,
        }}
      >
        {connection.label}
      </div>
      <div
        style={{
          height: 2,
          width: 32,
          background: 'var(--forge-500)',
          borderRadius: 1,
          marginTop: 8,
          boxShadow: '0 0 8px rgb(194 65 12 / 0.45)',
        }}
      />

      <div
        style={{
          fontSize: 12.5,
          color: 'var(--surface-300)',
          marginTop: 10,
          lineHeight: 1.5,
        }}
      >
        Mode <span style={{ color: mode.color, fontWeight: 600 }}>{mode.label}</span>.{' '}
        {connection.sandbox_mode === 'synthetic' &&
          `Coverage ${coverage ?? 0}%, last primed ${formatRelative(lastPrimed)}.`}
        {connection.sandbox_mode === 'vendor' &&
          'Sandbox runs route to vendor sandbox creds; mock-engine bypassed.'}
        {connection.sandbox_mode === 'none' &&
          'No sandbox configured — pick a mode on the connection.'}
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={onConfigure}
          className="solder-cta-forge"
          data-testid="sandbox-configure"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '7px 12px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Configure mode
        </button>
        {connection.sandbox_mode === 'synthetic' && (
          <PrimeNowButton
            connection={connection}
            onPrimed={onConnectionRefresh}
          />
        )}
      </div>

      <div
        style={{
          marginTop: 18,
          paddingTop: 14,
          borderTop: '1px solid var(--rule)',
          display: 'flex',
          gap: 4,
          overflowX: 'auto',
        }}
      >
        {SANDBOX_TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              data-testid={`sandbox-tab-${t.id}`}
              style={{
                padding: '6px 10px',
                borderRadius: 4,
                border: '1px solid',
                borderColor: active ? 'var(--forge-500)' : 'transparent',
                background: active ? 'rgb(194 65 12 / 0.12)' : 'transparent',
                color: active ? 'var(--forge-400)' : 'var(--surface-400)',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10.5,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 6,
          fontSize: 11.5,
          color: 'var(--surface-500)',
          lineHeight: 1.5,
        }}
      >
        {activeTab.caption}
      </div>

      <div style={{ marginTop: 14, flex: 1, minHeight: 0 }}>
        <TabBody
          connection={connection}
          tab={tab}
          onConnectionRefresh={onConnectionRefresh}
        />
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// Prime Now button — runs the read-only active probe (task #6).
// ----------------------------------------------------------------------------
function PrimeNowButton({
  connection,
  onPrimed,
}: {
  connection: Connection;
  onPrimed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    successes: number;
    failures: number;
    sample_count_total: number;
  } | null>(null);

  async function handleClick() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.primeSandbox(connection.id);
      setResult({
        successes: r.successes,
        failures: r.failures,
        sample_count_total: r.sample_count_total,
      });
      onPrimed();
    } catch (e) {
      setResult({
        successes: 0,
        failures: -1,
        sample_count_total: 0,
      });
      // eslint-disable-next-line no-console
      console.error('prime failed', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        data-testid="sandbox-prime-now"
        title="Run the read-only active probe against the connection's prod creds."
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          padding: '7px 12px',
          borderRadius: 4,
          cursor: busy ? 'not-allowed' : 'pointer',
          fontWeight: 600,
          background: 'transparent',
          color: 'var(--forge-500)',
          border: '1px solid var(--forge-500)',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Priming…' : 'Prime now'}
      </button>
      {result && (
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            color:
              result.failures < 0
                ? 'var(--rose-500)'
                : result.failures > 0
                ? 'var(--surface-400)'
                : 'var(--emerald-400)',
          }}
          data-testid="sandbox-prime-result"
        >
          {result.failures < 0
            ? 'failed'
            : `${result.successes} ok · ${result.failures} fail · ${result.sample_count_total} samples`}
        </span>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Tab bodies — v1 stubs. Each turns on as the corresponding backend lands:
//   endpoints  → task #5 (OpenAPI ingest) + #6 (active probe)
//   records    → task #7 (synthesis)
//   scenarios  → later
//   errors     → task #8 (fold corpus into sandbox)
// ----------------------------------------------------------------------------
function TabBody({
  connection,
  tab,
  onConnectionRefresh,
}: {
  connection: Connection;
  tab: TabId;
  onConnectionRefresh: () => void;
}) {
  if (connection.sandbox_mode === 'none') {
    return (
      <Stub
        title="Sandbox mode not set"
        body="Pick `vendor` (route sandbox runs to vendor sandbox creds) or `synthetic` (mock-engine serves data primed from OpenAPI + active probe + observed traffic)."
      />
    );
  }
  if (connection.sandbox_mode === 'vendor') {
    return (
      <Stub
        title="Vendor sandbox"
        body="This connection routes sandbox runs to its vendor sandbox creds. The mock-engine isn't involved — Endpoints / Records / Scenarios / Errors only apply to synthetic mode."
      />
    );
  }
  if (tab === 'endpoints') {
    return (
      <EndpointsTab
        connection={connection}
        onConnectionRefresh={onConnectionRefresh}
      />
    );
  }
  if (tab === 'records') {
    return (
      <RecordsTab connection={connection} onConnectionRefresh={onConnectionRefresh} />
    );
  }
  if (tab === 'scenarios') {
    return (
      <Stub
        title="No scenarios yet"
        body="Scenarios are saved presets the integration can request via header. Each one pins a count, fill strategy, and field-level overrides — the runtime resolver picks one per call."
      />
    );
  }
  return (
    <ErrorsTab connection={connection} />
  );
}

// ----------------------------------------------------------------------------
// Endpoints tab — when populated, lists discovered routes with coverage %
// and provenance. When empty, surfaces the "Ingest OpenAPI" affordance.
// ----------------------------------------------------------------------------
function EndpointsTab({
  connection,
  onConnectionRefresh,
}: {
  connection: Connection;
  onConnectionRefresh: () => void;
}) {
  const [showIngest, setShowIngest] = useState(false);
  const endpoints = (connection.sandbox_config?.endpoints ?? {}) as Record<
    string,
    { coverage_pct?: number; last_observed_at?: string | null; sample_count?: number; source?: string }
  >;
  const entries = Object.entries(endpoints);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Eyebrow>{entries.length} endpoint{entries.length === 1 ? '' : 's'}</Eyebrow>
        <button
          type="button"
          onClick={() => setShowIngest(true)}
          className="solder-cta-forge"
          data-testid="sandbox-ingest-openapi"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '5px 10px',
            borderRadius: 3,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Ingest OpenAPI
        </button>
      </div>

      {entries.length === 0 ? (
        <Stub
          title="No endpoints scaffolded yet"
          body="Paste an OpenAPI spec via the button above to scaffold MockSpec routes + a starter TestBank. The active probe (next slice) will fill in coverage from observed traffic."
        />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {entries
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, info]) => (
              <div
                key={key}
                data-testid={`sandbox-endpoint-${key}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: 12,
                  padding: '8px 10px',
                  border: '1px solid var(--rule)',
                  borderRadius: 4,
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11.5,
                    color: 'var(--surface-100)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={key}
                >
                  {key}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10,
                    color: 'var(--surface-500)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {info.source ?? 'openapi'}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    color: 'var(--forge-400)',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {info.coverage_pct ?? 0}%
                </span>
              </div>
            ))}
        </div>
      )}

      {showIngest && (
        <IngestOpenAPIModal
          connection={connection}
          onClose={() => setShowIngest(false)}
          onIngested={() => {
            onConnectionRefresh();
            setShowIngest(false);
          }}
        />
      )}
    </div>
  );
}

function IngestOpenAPIModal({
  connection,
  onClose,
  onIngested,
}: {
  connection: Connection;
  onClose: () => void;
  onIngested: (summary: {
    routes_added: number;
    entities_seeded: number;
    endpoints_seen: number;
    skipped: string[];
  }) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<{
    routes_added: number;
    entities_seeded: number;
    endpoints_seen: number;
    skipped: string[];
  } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Spec must be valid JSON. (YAML conversion not yet supported in v1.)');
      return;
    }
    setBusy(true);
    try {
      const result = await api.ingestOpenAPIIntoSandbox(connection.id, {
        spec_json: parsed,
      });
      setSummary(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ingest failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'grid',
        placeItems: 'center',
        background: 'rgb(0 0 0 / 0.55)',
        backdropFilter: 'blur(2px)',
        padding: 16,
      }}
      data-testid="sandbox-ingest-modal"
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 620,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--surface-900)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          color: 'var(--surface-50)',
          boxShadow: '0 18px 48px rgb(0 0 0 / 0.4)',
        }}
      >
        <Eyebrow>INGEST OPENAPI</Eyebrow>
        <h2
          style={{
            fontFamily: '"Space Grotesk", Inter, sans-serif',
            fontSize: 19,
            fontWeight: 600,
            color: 'var(--surface-50)',
            margin: 0,
          }}
        >
          Scaffold sandbox from spec
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--surface-400)', margin: 0, lineHeight: 1.5 }}>
          Paste an OpenAPI 3.x JSON document. The ingest walks `paths`,
          classifies each operation, and seeds the MockSpec + TestBank.
          Idempotent — replaces any existing scaffold for this connection.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder='{"openapi":"3.0.0","info":{...},"paths":{...}}'
          data-testid="sandbox-ingest-textarea"
          rows={12}
          spellCheck={false}
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            padding: '10px 12px',
            background: 'var(--container-fill)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            color: 'var(--surface-50)',
            outline: 'none',
            resize: 'vertical',
          }}
        />

        {error && (
          <div
            style={{
              padding: '8px 12px',
              border: '1px solid var(--rose-400)',
              borderRadius: 4,
              background: 'rgb(179 58 58 / 0.08)',
              color: 'var(--rose-500)',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {summary && (
          <div
            style={{
              padding: '10px 12px',
              border: '1px solid var(--emerald-400)',
              borderRadius: 4,
              background: 'rgb(16 185 129 / 0.06)',
              color: 'var(--surface-50)',
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
            data-testid="sandbox-ingest-summary"
          >
            Ingested <strong>{summary.routes_added}</strong> routes,{' '}
            <strong>{summary.entities_seeded}</strong> example entities. Saw{' '}
            {summary.endpoints_seen} paths total.{' '}
            {summary.skipped.length > 0 && (
              <span style={{ color: 'var(--surface-400)' }}>
                Skipped {summary.skipped.length} (mostly PUT/PATCH/DELETE — those land in v2).
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {summary ? (
            <button
              type="button"
              onClick={() => onIngested(summary)}
              data-testid="sandbox-ingest-done"
              className="solder-cta-forge"
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10.5,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                padding: '9px 14px',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 10.5,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  background: 'transparent',
                  color: 'var(--surface-300)',
                  border: '1px solid var(--rule)',
                  padding: '9px 14px',
                  borderRadius: 4,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !text.trim()}
                data-testid="sandbox-ingest-submit"
                className="solder-cta-forge"
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 10.5,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  padding: '9px 14px',
                  borderRadius: 4,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                  opacity: busy || !text.trim() ? 0.6 : 1,
                }}
              >
                {busy ? 'Ingesting…' : 'Ingest spec'}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Records tab — synthesise records for a known entity type, persist to bank.
// ----------------------------------------------------------------------------
function RecordsTab({
  connection,
  onConnectionRefresh,
}: {
  connection: Connection;
  onConnectionRefresh: () => void;
}) {
  const [bank, setBank] = useState<{
    entity_types: Array<{ name: string; count: number; schema_keys: string[] }>;
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [entityType, setEntityType] = useState('');
  const [count, setCount] = useState(10);
  const [variant, setVariant] = useState<'full' | 'half' | 'minimal'>('full');
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{
    created: number;
    used_fallback: boolean;
    error: string | null;
    examples: Record<string, unknown>[];
  } | null>(null);

  async function refreshBank() {
    setLoading(true);
    setError('');
    try {
      const data = await api.getSandboxBank(connection.id);
      setBank(data);
      if (!entityType && data.entity_types.length > 0) {
        setEntityType(data.entity_types[0].name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load bank');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshBank();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  async function handleSynthesize(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!entityType.trim()) {
      setError('Pick an entity type');
      return;
    }
    setBusy(true);
    try {
      const result = await api.synthesizeSandboxRecords(connection.id, {
        entity_type: entityType.trim(),
        count,
        variant,
      });
      setLastResult(result);
      await refreshBank();
      onConnectionRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Synthesize failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Eyebrow>BANK SUMMARY</Eyebrow>
      {loading ? (
        <div style={{ fontSize: 12.5, color: 'var(--surface-500)' }}>Loading…</div>
      ) : bank && bank.entity_types.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {bank.entity_types.map((et) => (
            <div
              key={et.name}
              data-testid={`sandbox-entity-${et.name}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                padding: '8px 10px',
                border: '1px solid var(--rule)',
                borderRadius: 4,
                gap: 12,
                alignItems: 'center',
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 12,
                    color: 'var(--surface-100)',
                  }}
                >
                  {et.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--surface-500)' }}>
                  {et.schema_keys.length} schema fields
                </div>
              </div>
              <div
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11,
                  color: 'var(--forge-400)',
                  fontWeight: 600,
                }}
              >
                {et.count} record{et.count === 1 ? '' : 's'}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            fontSize: 12,
            color: 'var(--surface-500)',
            border: '1px dashed var(--surface-700)',
            borderRadius: 6,
            padding: 16,
            textAlign: 'center',
          }}
        >
          No entity types yet. Ingest an OpenAPI spec from the Endpoints tab first.
        </div>
      )}

      <Eyebrow style={{ marginTop: 10 }}>SYNTHESIZE RECORDS</Eyebrow>
      <form
        onSubmit={handleSynthesize}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 80px 100px auto',
          gap: 8,
          alignItems: 'flex-end',
        }}
      >
        <label>
          <div style={{ fontSize: 10, color: 'var(--surface-500)', marginBottom: 4, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Entity type
          </div>
          {bank && bank.entity_types.length > 0 ? (
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.currentTarget.value)}
              data-testid="synthesize-entity-type"
              style={{
                width: '100%',
                padding: '6px 8px',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                background: 'var(--surface-50)',
                border: '1px solid var(--surface-300)',
                borderRadius: 4,
                color: 'var(--surface-900)',
              }}
            >
              {bank.entity_types.map((et) => (
                <option key={et.name} value={et.name}>
                  {et.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={entityType}
              onChange={(e) => setEntityType(e.currentTarget.value)}
              placeholder="vendor"
              data-testid="synthesize-entity-type"
              style={{
                width: '100%',
                padding: '6px 8px',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                background: 'var(--surface-50)',
                border: '1px solid var(--surface-300)',
                borderRadius: 4,
                color: 'var(--surface-900)',
              }}
            />
          )}
        </label>
        <label>
          <div style={{ fontSize: 10, color: 'var(--surface-500)', marginBottom: 4, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Count
          </div>
          <input
            type="number"
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.currentTarget.value) || 1)))}
            data-testid="synthesize-count"
            style={{
              width: '100%',
              padding: '6px 8px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12,
              background: 'var(--surface-50)',
              border: '1px solid var(--surface-300)',
              borderRadius: 4,
              color: 'var(--surface-900)',
            }}
          />
        </label>
        <label>
          <div style={{ fontSize: 10, color: 'var(--surface-500)', marginBottom: 4, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Variant
          </div>
          <select
            value={variant}
            onChange={(e) => setVariant(e.currentTarget.value as 'full' | 'half' | 'minimal')}
            data-testid="synthesize-variant"
            style={{
              width: '100%',
              padding: '6px 8px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12,
              background: 'var(--surface-50)',
              border: '1px solid var(--surface-300)',
              borderRadius: 4,
              color: 'var(--surface-900)',
            }}
          >
            <option value="full">Full</option>
            <option value="half">Half</option>
            <option value="minimal">Minimal</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !entityType.trim()}
          data-testid="synthesize-submit"
          className="solder-cta-forge"
          style={{
            padding: '7px 14px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            borderRadius: 4,
            cursor: busy ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            opacity: busy || !entityType.trim() ? 0.6 : 1,
          }}
        >
          {busy ? 'Synth…' : 'Synthesize'}
        </button>
      </form>

      {error && (
        <div
          style={{
            padding: '8px 12px',
            border: '1px solid var(--rose-400)',
            borderRadius: 4,
            background: 'rgb(179 58 58 / 0.08)',
            color: 'var(--rose-500)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {lastResult && (
        <div
          style={{
            padding: '10px 12px',
            border: '1px solid var(--emerald-400)',
            borderRadius: 4,
            background: 'rgb(16 185 129 / 0.06)',
            fontSize: 12.5,
            color: 'var(--surface-50)',
            lineHeight: 1.6,
          }}
          data-testid="synthesize-result"
        >
          Created <strong>{lastResult.created}</strong> records.{' '}
          {lastResult.used_fallback && (
            <span style={{ color: 'var(--surface-400)' }}>
              Used deterministic fallback{lastResult.error ? ` (${lastResult.error})` : ''}.
            </span>
          )}
          {lastResult.examples.length > 0 && (
            <pre
              style={{
                marginTop: 8,
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                color: 'var(--surface-300)',
                background: 'rgb(0 0 0 / 0.2)',
                borderRadius: 4,
                padding: 8,
                maxHeight: 180,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(lastResult.examples[0], null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Errors tab — hand-curated corpus + observed responses (>= 400) from audits.
// ----------------------------------------------------------------------------
function ErrorsTab({ connection }: { connection: Connection }) {
  const [data, setData] = useState<{
    api_name: string | null;
    corpus: Array<{
      id: string;
      applies_to_routes?: string[];
      trigger?: Record<string, unknown>;
      response?: { status?: number; body?: unknown };
      explanation?: string;
    }>;
    observed: Array<{
      path: string;
      status: number;
      error_injected: string | null;
      count: number;
      last_seen: string | null;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getSandboxErrors(connection.id)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load errors');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connection.id]);

  if (loading) {
    return <div style={{ fontSize: 12.5, color: 'var(--surface-500)' }}>Loading…</div>;
  }
  if (error) {
    return (
      <div
        style={{
          padding: '8px 12px',
          border: '1px solid var(--rose-400)',
          borderRadius: 4,
          background: 'rgb(179 58 58 / 0.08)',
          color: 'var(--rose-500)',
          fontSize: 12,
        }}
      >
        {error}
      </div>
    );
  }
  if (!data) return null;

  const hasCorpus = data.corpus.length > 0;
  const hasObserved = data.observed.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <Eyebrow style={{ display: 'block', marginBottom: 6 }}>
          OBSERVED — {data.observed.length}
        </Eyebrow>
        {hasObserved ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.observed.map((o, idx) => (
              <div
                key={`${o.path}-${o.status}-${o.error_injected}-${idx}`}
                data-testid={`sandbox-observed-${idx}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr auto auto',
                  gap: 8,
                  padding: '8px 10px',
                  border: '1px solid var(--rule)',
                  borderRadius: 4,
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    color:
                      o.status >= 500
                        ? 'var(--rose-500)'
                        : 'var(--forge-400)',
                    fontWeight: 600,
                  }}
                >
                  {o.status}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11.5,
                    color: 'var(--surface-100)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={o.path}
                >
                  {o.path}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10.5,
                    color: 'var(--surface-500)',
                  }}
                  title={o.error_injected ?? 'real failure'}
                >
                  {o.error_injected ?? '—'}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    color: 'var(--forge-400)',
                    fontWeight: 600,
                  }}
                >
                  {o.count}×
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--surface-500)',
              border: '1px dashed var(--surface-700)',
              borderRadius: 4,
              padding: 12,
            }}
          >
            No 4xx/5xx responses observed yet. Run an integration against this connection to start
            populating the observed list.
          </div>
        )}
      </div>

      <div>
        <Eyebrow style={{ display: 'block', marginBottom: 6 }}>
          CORPUS — {data.corpus.length}{' '}
          {data.api_name && (
            <span style={{ color: 'var(--surface-600)' }}>
              ({data.api_name})
            </span>
          )}
        </Eyebrow>
        {hasCorpus ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.corpus.map((entry) => (
              <div
                key={entry.id}
                data-testid={`sandbox-corpus-${entry.id}`}
                style={{
                  padding: '10px 12px',
                  border: '1px solid var(--rule)',
                  borderRadius: 4,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 11.5,
                      color: 'var(--surface-100)',
                    }}
                  >
                    {entry.id}
                  </span>
                  {entry.response?.status !== undefined && (
                    <span
                      style={{
                        fontFamily: '"JetBrains Mono", monospace',
                        fontSize: 10.5,
                        color: 'var(--forge-400)',
                        fontWeight: 600,
                      }}
                    >
                      → {entry.response.status}
                    </span>
                  )}
                </div>
                {entry.applies_to_routes && entry.applies_to_routes.length > 0 && (
                  <div
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 10.5,
                      color: 'var(--surface-500)',
                      marginBottom: 4,
                    }}
                  >
                    {entry.applies_to_routes.join(', ')}
                  </div>
                )}
                {entry.explanation && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--surface-400)',
                      lineHeight: 1.5,
                    }}
                  >
                    {entry.explanation}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--surface-500)',
              border: '1px dashed var(--surface-700)',
              borderRadius: 4,
              padding: 12,
            }}
          >
            No hand-curated corpus available for {data.api_name ?? 'this connector'}. The observed
            list still aggregates real failures from runs.
          </div>
        )}
      </div>
    </div>
  );
}

function Stub({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        border: '1px dashed var(--surface-700)',
        borderRadius: 8,
        padding: '32px 24px',
        textAlign: 'center',
        background: 'rgb(255 255 255 / 0.02)',
      }}
    >
      <Eyebrow style={{ display: 'block', marginBottom: 8 }}>state · awaiting backend</Eyebrow>
      <h3
        style={{
          fontFamily: '"Space Grotesk", Inter, sans-serif',
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--surface-100)',
          margin: '0 0 6px',
        }}
      >
        {title}
      </h3>
      <p
        style={{
          fontSize: 12.5,
          color: 'var(--surface-400)',
          maxWidth: 440,
          margin: '0 auto',
          lineHeight: 1.5,
        }}
      >
        {body}
      </p>
    </div>
  );
}

function EmptyState({ onAuthor }: { onAuthor: () => void }) {
  return (
    <div
      style={{
        border: '1px dashed var(--surface-700)',
        borderRadius: 8,
        padding: '48px 32px',
        textAlign: 'center',
        background: 'var(--container-fill)',
      }}
    >
      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 18,
          color: 'var(--surface-500)',
          marginBottom: 12,
        }}
      >
        ⛁
      </div>
      <Eyebrow style={{ display: 'block', marginBottom: 6 }}>state · empty</Eyebrow>
      <h2
        style={{
          fontFamily: '"Space Grotesk", Inter, sans-serif',
          fontSize: 18,
          fontWeight: 600,
          color: 'var(--surface-50)',
          margin: '0 0 6px',
        }}
      >
        No connections to sandbox yet
      </h2>
      <p
        style={{
          fontSize: 13,
          color: 'var(--surface-400)',
          maxWidth: 460,
          margin: '0 auto 18px',
          lineHeight: 1.5,
        }}
      >
        Sandboxes are per-connection. Author a connection first; once it's saved
        you'll be able to attach a vendor sandbox or synthesise a mock DB from
        OpenAPI + observed traffic.
      </p>
      <button
        type="button"
        onClick={onAuthor}
        className="solder-cta-forge"
        data-testid="sandboxes-empty-author"
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          padding: '9px 14px',
          borderRadius: 4,
          cursor: 'pointer',
          fontWeight: 600,
        }}
      >
        Author Connection
      </button>
    </div>
  );
}
