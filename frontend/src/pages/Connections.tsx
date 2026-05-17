import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  api,
  brandLogoUrl,
  type Connection,
  type Connector,
  type ConnectionType,
  type SandboxMode,
} from '@/api/client';
import Select from '@/components/Select';

// ----------------------------------------------------------------------------
// Connections — Phase 3 of the warm-skin rebuild.
//
// Visual template: Integrations.tsx (warm cream `.sol-canvas`, slim row list,
// 340px sticky detail pane). Functional template: the previous Connections
// page (preserved verbatim — connector picker, custom auth-scheme picker,
// dynamic field rendering, delete). Edit isn't wired up because the API layer
// doesn't yet expose `updateConnection`; flagged in the report.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Time helper — same shape as Integrations.tsx so list rows + detail pane
// agree on relative timestamps.
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Eyebrow — inline-styled to track `var(--surface-500)` regardless of whether
// the compiled `.eyebrow` class has been bumped for warm cream contrast.
// ----------------------------------------------------------------------------
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

/** Human-friendly label for an auth scheme id — used by the row eyebrow when
 *  the connection is custom (no Connector display name to read). */
function schemeDisplayName(id: string): string {
  switch (id) {
    case 'bearer':
      return 'Bearer Token';
    case 'api_key_header':
      return 'API Key';
    case 'api_key_query':
      return 'API Key';
    case 'basic':
      return 'Basic Auth';
    case 'oauth2_cc':
      return 'OAuth 2.0';
    default:
      return id;
  }
}

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------
export default function Connections() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id') ?? '';

  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [q, setQ] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const [cs, cn] = await Promise.all([api.listConnectors(), api.listConnections()]);
      setConnectors(cs);
      setConnections(cn);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load connections');
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

  // Sorted list (most-recently-created first), filtered by the search box.
  const sorted = useMemo(() => {
    const arr = [...connections].sort((a, b) => {
      const at = new Date(a.created_at).getTime();
      const bt = new Date(b.created_at).getTime();
      return bt - at;
    });
    const needle = q.trim().toLowerCase();
    if (!needle) return arr;
    return arr.filter((c) => {
      const connector = c.connector_id ? connectorById.get(c.connector_id) : undefined;
      const haystack = [
        c.label,
        c.auth_scheme,
        connector?.display_name ?? '',
        connector?.name ?? '',
        c.base_url ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [connections, connectorById, q]);

  const builtIn = useMemo(() => sorted.filter((c) => !!c.connector_id), [sorted]);
  const custom = useMemo(() => sorted.filter((c) => !c.connector_id), [sorted]);

  // Default selection — first built-in, else first custom.
  useEffect(() => {
    if (selectedId) return;
    const fallback = builtIn[0]?.id ?? custom[0]?.id;
    if (fallback) setParams({ id: fallback }, { replace: true });
  }, [selectedId, builtIn, custom, setParams]);

  const selected = useMemo(
    () => sorted.find((c) => c.id === selectedId) ?? null,
    [sorted, selectedId]
  );

  function selectConnection(id: string) {
    setParams({ id });
  }

  async function handleDelete(id: string, label: string) {
    if (
      !confirm(
        `Delete connection "${label}"? This won't unbind it from any integration that references it.`
      )
    )
      return;
    try {
      await api.deleteConnection(id);
      setConnections((prev) => prev.filter((c) => c.id !== id));
      if (id === selectedId) setParams({});
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const totalCount = connections.length;
  const customCount = connections.filter((c) => !c.connector_id).length;

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
      {/* HEADER */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(220px, 1fr) auto auto',
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
            Connections
          </h1>
        </div>

        {/* search */}
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
            placeholder="search connections, connectors, labels"
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
            data-testid="connection-search"
          />
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 9.5,
              color: 'var(--surface-500)',
              letterSpacing: '0.04em',
            }}
          >
            ⌘K
          </span>
        </div>

        {/* counter */}
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
            <span style={{ color: 'var(--surface-50)' }}>{totalCount}</span> connections ·{' '}
            <span style={{ color: 'var(--forge-400)' }}>{customCount} custom</span>
          </div>
          <div style={{ color: 'var(--surface-500)' }}>
            {connectors.length.toLocaleString()} connectors registered
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate(true)}
          data-testid="connection-new"
          className="solder-cta-forge"
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
          + New Connection
        </button>
      </div>

      {/* BODY */}
      {loading ? (
        <div data-testid="connections-skeleton">
          <Eyebrow>loading…</Eyebrow>
        </div>
      ) : connections.length === 0 ? (
        <EmptyState onCreate={() => setShowCreate(true)} />
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
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                fontSize: 13,
              }}
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 10.5,
                  background: 'transparent',
                  border: '1px solid var(--rose-400)',
                  color: 'var(--rose-500)',
                  padding: '4px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                dismiss
              </button>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 340px',
              gap: 28,
              alignItems: 'stretch',
            }}
          >
            {/* LEFT */}
            <div data-testid="connections-grid">
              {builtIn.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                      padding: '0 4px',
                    }}
                  >
                    <Eyebrow>BUILT-IN CONNECTORS — {builtIn.length}</Eyebrow>
                    <span
                      style={{
                        fontFamily: '"JetBrains Mono", monospace',
                        fontSize: 10,
                        color: 'var(--surface-500)',
                      }}
                    >
                      brandfetch · vendor catalogue
                    </span>
                  </div>
                  <div>
                    {builtIn.map((c, idx) => (
                      <ConnectionRow
                        key={c.id}
                        idx={idx}
                        connection={c}
                        connector={c.connector_id ? connectorById.get(c.connector_id) : undefined}
                        selected={selectedId === c.id}
                        onSelect={() => selectConnection(c.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {custom.length > 0 && (
                <div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                      padding: '0 4px',
                    }}
                  >
                    <Eyebrow>CUSTOM CONNECTIONS — {custom.length}</Eyebrow>
                    <span
                      style={{
                        fontFamily: '"JetBrains Mono", monospace',
                        fontSize: 10,
                        color: 'var(--surface-500)',
                      }}
                    >
                      auth-scheme · user-supplied base url
                    </span>
                  </div>
                  <div>
                    {custom.map((c, idx) => (
                      <ConnectionRow
                        key={c.id}
                        idx={idx}
                        connection={c}
                        connector={undefined}
                        selected={selectedId === c.id}
                        onSelect={() => selectConnection(c.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {builtIn.length === 0 && custom.length === 0 && (
                <p
                  style={{
                    fontSize: 13,
                    color: 'var(--surface-500)',
                    padding: '40px 4px',
                    fontFamily: 'Inter, system-ui, sans-serif',
                  }}
                >
                  No connections match “{q}”.
                </p>
              )}
            </div>

            {/* RIGHT — DETAIL PANE */}
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
              data-testid="connection-detail"
            >
              {selected ? (
                <DetailPane
                  connection={selected}
                  connector={
                    selected.connector_id ? connectorById.get(selected.connector_id) : undefined
                  }
                  onDelete={() => handleDelete(selected.id, selected.label)}
                  onBrowse={() => navigate('/connectors')}
                  onSandboxUpdated={(updated) =>
                    setConnections((prev) =>
                      prev.map((c) => (c.id === updated.id ? updated : c))
                    )
                  }
                />
              ) : (
                <div style={{ color: 'var(--surface-500)', fontSize: 13 }}>
                  <Eyebrow style={{ display: 'block', marginBottom: 8 }}>state · idle</Eyebrow>
                  Select a connection to inspect its connector, auth scheme, and metadata.
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      {showCreate && (
        <CreateConnectionModal
          connectors={connectors}
          onClose={() => setShowCreate(false)}
          onCreated={(c) => {
            setConnections((prev) => [...prev, c]);
            setShowCreate(false);
            setParams({ id: c.id });
          }}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Connection row — slim list item modelled on Integrations' OperatingRow.
// ----------------------------------------------------------------------------
function ConnectionRow({
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
  const display = connector?.display_name ?? schemeDisplayName(connection.auth_scheme);
  const baseUrl = connector?.base_url ?? connection.base_url ?? '';

  return (
    <div
      data-testid={`connection-tile-${connection.id}`}
      data-row-id={connection.id}
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

      {/* Mark — Brandfetch logo for built-ins, typographic mark for custom. */}
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
          {connector
            ? connector.display_name
            : (
                <>
                  <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                    {connection.auth_scheme}
                  </span>
                  {baseUrl && <> · {baseUrl}</>}
                </>
              )}
        </div>
      </div>

      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5,
          color: 'var(--surface-500)',
          whiteSpace: 'nowrap',
        }}
      >
        {connection.connector_id ? (
          <span style={{ color: 'var(--primary-400)' }}>built-in</span>
        ) : (
          <span style={{ color: 'var(--forge-400)' }}>custom</span>
        )}
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
        updated
        <br />
        {formatRelative(connection.updated_at)}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Detail pane
// ----------------------------------------------------------------------------
function DetailPane({
  connection,
  connector,
  onDelete,
  onBrowse,
  onSandboxUpdated,
}: {
  connection: Connection;
  connector: Connector | undefined;
  onDelete: () => void;
  onBrowse: () => void;
  onSandboxUpdated: (next: Connection) => void;
}) {
  const logo = connector ? brandLogoUrl(connector.brand_domain) : null;
  const display = connector?.display_name ?? schemeDisplayName(connection.auth_scheme);
  const baseUrl = connector?.base_url ?? connection.base_url ?? null;
  const configKeyCount = Object.keys(connection.config_json ?? {}).length;
  const [showSandboxModal, setShowSandboxModal] = useState(false);

  // Best-effort sandbox/prod hint from the label or base URL — the
  // Connection model itself doesn't carry an environment field.
  const envHint = (() => {
    const hay = `${connection.label} ${baseUrl ?? ''}`.toLowerCase();
    if (/sandbox|sbx|staging|stage|dev/.test(hay)) return 'vendor sandbox';
    if (/prod|live/.test(hay)) return 'vendor production';
    return null;
  })();

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
        <Eyebrow>CONNECTION · {connection.id.slice(0, 8)}</Eyebrow>
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
        {connector ? (
          <>
            Bound to <strong style={{ color: 'var(--surface-100)' }}>{connector.display_name}</strong>{' '}
            via <code style={{ fontFamily: '"JetBrains Mono", monospace' }}>{connection.auth_scheme}</code>.
          </>
        ) : (
          <>
            Custom service authored against{' '}
            <code style={{ fontFamily: '"JetBrains Mono", monospace' }}>{connection.auth_scheme}</code>.
          </>
        )}
        {envHint && (
          <>
            {' '}
            <span style={{ color: 'var(--forge-400)' }}>{envHint}</span>.
          </>
        )}
      </div>

      {/* COMPOSITION */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid var(--rule)',
        }}
      >
        <Eyebrow style={{ display: 'block', marginBottom: 8 }}>COMPOSITION</Eyebrow>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            rowGap: 6,
            fontSize: 12.5,
            margin: 0,
          }}
        >
          <dt style={{ color: 'var(--surface-400)' }}>connector</dt>
          <dd
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              color: 'var(--surface-100)',
              margin: 0,
              maxWidth: 200,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'right',
            }}
          >
            {connector ? connector.name : '—'}
          </dd>

          <dt style={{ color: 'var(--surface-400)' }}>auth scheme</dt>
          <dd
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              color: 'var(--surface-100)',
              margin: 0,
              textAlign: 'right',
            }}
          >
            {connection.auth_scheme}
          </dd>

          {baseUrl && (
            <>
              <dt style={{ color: 'var(--surface-400)' }}>base url</dt>
              <dd
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  color: 'var(--surface-100)',
                  margin: 0,
                  maxWidth: 200,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textAlign: 'right',
                }}
                title={baseUrl}
              >
                {baseUrl}
              </dd>
            </>
          )}

          <dt style={{ color: 'var(--surface-400)' }}>config keys</dt>
          <dd
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              color: 'var(--surface-100)',
              margin: 0,
              textAlign: 'right',
            }}
          >
            {configKeyCount}
          </dd>

          <dt style={{ color: 'var(--surface-400)' }}>secrets</dt>
          <dd
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              color: 'var(--emerald-400)',
              margin: 0,
              textAlign: 'right',
            }}
            title="Encrypted at rest with AES-256-GCM (per-host key, mode 0600). Never round-tripped."
          >
            encrypted
          </dd>

          <dt style={{ color: 'var(--surface-400)' }}>updated</dt>
          <dd
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              color: 'var(--surface-100)',
              margin: 0,
              textAlign: 'right',
            }}
          >
            {formatRelative(connection.updated_at)}
          </dd>

          <dt style={{ color: 'var(--surface-400)' }}>created</dt>
          <dd
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              color: 'var(--surface-100)',
              margin: 0,
              textAlign: 'right',
            }}
          >
            {formatRelative(connection.created_at)}
          </dd>
        </dl>
      </div>

      {/* SANDBOX — Sandboxes v1. Each connection picks how it's served
          when an integration runs in environment='sandbox'. */}
      <SandboxSection
        connection={connection}
        onConfigure={() => setShowSandboxModal(true)}
      />

      {showSandboxModal && (
        <SandboxModal
          connection={connection}
          connector={connector}
          onClose={() => setShowSandboxModal(false)}
          onUpdated={(updated) => {
            onSandboxUpdated(updated);
            setShowSandboxModal(false);
          }}
        />
      )}

      {/* ACTIONS — Edit isn't here because the API layer doesn't yet expose
          updateConnection. Browse jumps to the connector catalogue, which is
          the closest existing affordance for adjusting metadata. */}
      <div
        style={{
          marginTop: 'auto',
          paddingTop: 16,
          display: 'flex',
          gap: 8,
          alignItems: 'stretch',
        }}
      >
        <button
          type="button"
          data-testid="connection-detail-browse"
          onClick={onBrowse}
          className="solder-cta-forge"
          style={{
            flex: 1,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '9px 12px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Browse Connectors
        </button>
        <button
          type="button"
          aria-label="Delete connection"
          data-testid={`connection-delete-${connection.id}`}
          onClick={onDelete}
          style={{
            width: 36,
            background: 'transparent',
            border: '1px solid var(--surface-700)',
            color: 'var(--surface-400)',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
          }}
        >
          ✕
        </button>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// Empty state
// ----------------------------------------------------------------------------
function EmptyState({ onCreate }: { onCreate: () => void }) {
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
        ◇
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
        No connections yet
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
        A connection bundles a connector and a credential set. Author one here, then reference it
        from any integration's connection rail under whatever alias suits the flow ("crm",
        "billing", "primary"). Secrets are encrypted at rest.
      </p>
      <button
        type="button"
        onClick={onCreate}
        data-testid="connection-empty-create"
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
        + New Connection
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------------
// CreateConnectionModal — preserved verbatim functionally; modal chrome
// restyled to warm cream surface tokens.
//
//   Built-in   pick one of the registered connectors (Zip, HubSpot, …);
//              auth scheme is inherited from the connector definition.
//   Custom     no connector — pick one of the primitive connection types
//              (bearer / api_key_header / api_key_query / basic / oauth2_cc)
//              and fill in its declared fields.
//
// The form for either mode is generated from the same `ConnectionType`
// shape returned by `GET /api/connection-types`. The catalog is the single
// source of truth — adding a new scheme on the backend auto-surfaces here
// with no frontend change.
// ----------------------------------------------------------------------------
type Mode = 'builtin' | 'custom';

function CreateConnectionModal({
  connectors,
  onClose,
  onCreated,
}: {
  connectors: Connector[];
  onClose: () => void;
  onCreated: (c: Connection) => void;
}) {
  const [mode, setMode] = useState<Mode>('builtin');
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? '');
  const [customSchemeId, setCustomSchemeId] = useState<string>('bearer');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [types, setTypes] = useState<ConnectionType[]>([]);
  const [typesLoading, setTypesLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .listConnectionTypes()
      .then((ts) => {
        if (alive) setTypes(ts);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load connection types');
      })
      .finally(() => {
        if (alive) setTypesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const connector = connectors.find((c) => c.id === connectorId);

  const activeScheme = useMemo(() => {
    const target =
      mode === 'builtin' ? connector?.auth_scheme ?? 'bearer' : customSchemeId;
    return types.find((t) => t.id === target);
  }, [mode, connector, customSchemeId, types]);

  useEffect(() => {
    if (!activeScheme) return;
    setValues((prev) => {
      const next: Record<string, string> = {};
      for (const f of activeScheme.fields) {
        next[f.key] = prev[f.key] ?? f.default ?? '';
      }
      return next;
    });
  }, [activeScheme]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!label.trim()) {
      setError('Give the connection a label');
      return;
    }
    if (!activeScheme) {
      setError('Pick a connection type');
      return;
    }
    if (mode === 'builtin' && !connectorId) {
      setError('Pick a connector');
      return;
    }
    const secrets: Record<string, unknown> = {};
    const config: Record<string, unknown> = {};
    for (const f of activeScheme.fields) {
      const v = (values[f.key] ?? '').trim();
      if (f.required && !v && !f.default) {
        setError(`${f.label} is required`);
        return;
      }
      if (!v) continue;
      if (f.secret) secrets[f.key] = v;
      else config[f.key] = v;
    }

    setSubmitting(true);
    try {
      const created = await api.createConnection({
        label: label.trim(),
        connector_id: mode === 'builtin' ? connectorId : null,
        auth_scheme: activeScheme.id,
        base_url: baseUrl.trim() || null,
        secrets,
        config,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  // ---------- shared input/label styles (mode-aware tokens) ----------
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    background: 'var(--container-fill)',
    border: '1px solid var(--rule)',
    borderRadius: 4,
    color: 'var(--surface-50)',
    fontSize: 13,
    fontFamily: 'Inter, system-ui, sans-serif',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const monoInputStyle: React.CSSProperties = {
    ...inputStyle,
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 12.5,
  };

  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'var(--surface-500)',
    marginBottom: 6,
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        background: 'rgb(0 0 0 / 0.55)',
        backdropFilter: 'blur(2px)',
        padding: 16,
      }}
      data-testid="connection-modal-backdrop"
    >
      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        data-testid="connection-create-modal"
        style={{
          width: '100%',
          maxWidth: 540,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--surface-900)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 18px 48px rgb(0 0 0 / 0.4)',
          color: 'var(--surface-50)',
        }}
      >
        <div>
          <Eyebrow style={{ display: 'block', marginBottom: 6 }}>NEW CONNECTION</Eyebrow>
          <div
            style={{
              fontFamily: '"Space Grotesk", Inter, sans-serif',
              fontSize: 20,
              fontWeight: 600,
              color: 'var(--surface-50)',
              letterSpacing: '-0.018em',
              lineHeight: 1.2,
            }}
          >
            Author a new connection
          </div>
          <div
            style={{
              height: 2,
              width: 28,
              background: 'var(--forge-500)',
              borderRadius: 1,
              marginTop: 8,
              boxShadow: '0 0 6px rgb(194 65 12 / 0.4)',
            }}
          />
        </div>

        {/* Mode toggle — pill buttons. */}
        <div
          style={{
            display: 'flex',
            padding: 3,
            background: 'var(--container-glaze)',
            border: '1px solid var(--rule)',
            borderRadius: 6,
            gap: 3,
          }}
        >
          <ModeButton
            active={mode === 'builtin'}
            onClick={() => setMode('builtin')}
            testid="connection-mode-builtin"
          >
            Built-in connector
          </ModeButton>
          <ModeButton
            active={mode === 'custom'}
            onClick={() => setMode('custom')}
            testid="connection-mode-custom"
          >
            Custom service
          </ModeButton>
        </div>

        {mode === 'builtin' ? (
          <label style={{ display: 'block' }}>
            <span style={fieldLabelStyle}>Connector</span>
            <Select
              value={connectorId}
              onChange={setConnectorId}
              options={connectors.map((c) => ({
                value: c.id,
                label: c.display_name,
                caption: c.auth_scheme,
              }))}
              placeholder={
                connectors.length === 0 ? 'No connectors registered' : 'Pick a connector'
              }
              width="100%"
              ariaLabel="Connector"
              testid="connection-connector"
            />
            {connector && (
              <p
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11,
                  color: 'var(--surface-500)',
                  marginTop: 6,
                  marginBottom: 0,
                }}
              >
                {connector.base_url} · scheme {connector.auth_scheme}
              </p>
            )}
          </label>
        ) : (
          <label style={{ display: 'block' }}>
            <span style={fieldLabelStyle}>Connection type</span>
            <Select
              value={customSchemeId}
              onChange={setCustomSchemeId}
              options={types.map((t) => ({
                value: t.id,
                label: t.label,
                description: t.description,
              }))}
              placeholder={typesLoading ? 'Loading…' : 'Pick a connection type'}
              disabled={typesLoading}
              width="100%"
              ariaLabel="Connection type"
              testid="connection-type"
            />
            {activeScheme && (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--surface-500)',
                  marginTop: 6,
                  marginBottom: 0,
                  lineHeight: 1.5,
                }}
              >
                {activeScheme.description}
              </p>
            )}
          </label>
        )}

        <label style={{ display: 'block' }}>
          <span style={fieldLabelStyle}>Label</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder={
              mode === 'builtin'
                ? 'e.g. Zip — sandbox tenant'
                : 'e.g. Acme CRM — production'
            }
            data-testid="connection-label"
            autoFocus
            style={inputStyle}
          />
        </label>

        {mode === 'custom' && (
          <label style={{ display: 'block' }}>
            <span style={fieldLabelStyle}>
              Base URL{' '}
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 9.5,
                  color: 'var(--surface-500)',
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                (optional)
              </span>
            </span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
              placeholder="https://api.example.com"
              data-testid="connection-base-url"
              style={monoInputStyle}
            />
          </label>
        )}

        {/* Dynamic field rendering driven by the active scheme. */}
        {activeScheme && activeScheme.fields.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--rule)',
            }}
          >
            {activeScheme.fields.map((f) => (
              <label key={f.key} style={{ display: 'block' }}>
                <span style={fieldLabelStyle}>
                  {f.label}
                  {!f.required && (
                    <span
                      style={{
                        fontFamily: '"JetBrains Mono", monospace',
                        fontSize: 9.5,
                        color: 'var(--surface-500)',
                        marginLeft: 6,
                        textTransform: 'none',
                        letterSpacing: 0,
                      }}
                    >
                      (optional)
                    </span>
                  )}
                </span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={values[f.key] ?? ''}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.currentTarget.value }))
                  }
                  placeholder={f.placeholder ?? f.default ?? ''}
                  data-testid={`connection-field-${f.key}`}
                  autoComplete={f.secret ? 'new-password' : 'off'}
                  style={monoInputStyle}
                />
                {f.help && (
                  <p
                    style={{
                      fontSize: 11,
                      color: 'var(--surface-500)',
                      marginTop: 4,
                      marginBottom: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {f.help}
                  </p>
                )}
              </label>
            ))}
            <p
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10.5,
                color: 'var(--surface-500)',
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              Secret fields are encrypted at rest with AES-256-GCM (per-host key, mode 0600) and
              never round-trip back.
            </p>
          </div>
        )}

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

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            paddingTop: 4,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
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
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              submitting ||
              !activeScheme ||
              (mode === 'builtin' && connectors.length === 0)
            }
            data-testid="connection-submit"
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: 'var(--forge-500)',
              color: '#FFF7EE',
              border: '1px solid var(--forge-500)',
              padding: '9px 14px',
              borderRadius: 4,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              boxShadow: '0 0 14px rgb(194 65 12 / 0.35)',
              opacity:
                submitting ||
                !activeScheme ||
                (mode === 'builtin' && connectors.length === 0)
                  ? 0.6
                  : 1,
            }}
          >
            {submitting ? 'Creating…' : 'Create Connection'}
          </button>
        </div>
      </motion.form>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      style={{
        flex: 1,
        padding: '7px 12px',
        fontSize: 12.5,
        fontFamily: 'Inter, system-ui, sans-serif',
        fontWeight: active ? 600 : 500,
        background: active ? 'rgb(194 65 12 / 0.10)' : 'transparent',
        color: active ? 'var(--forge-400)' : 'var(--surface-400)',
        border: active ? '1px solid var(--forge-500)' : '1px solid transparent',
        borderRadius: 4,
        cursor: 'pointer',
        boxShadow: 'none',
        transition: 'background 120ms, color 120ms',
      }}
    >
      {children}
    </button>
  );
}

// ----------------------------------------------------------------------------
// Sandbox section — inline summary on the detail pane. The actual edit
// surface lives in `SandboxModal` (below) so this stays compact.
// ----------------------------------------------------------------------------
function SandboxSection({
  connection,
  onConfigure,
}: {
  connection: Connection;
  onConfigure: () => void;
}) {
  const mode = connection.sandbox_mode;
  const pillColor =
    mode === 'vendor'
      ? 'var(--primary-400)'
      : mode === 'synthetic'
      ? 'var(--forge-400)'
      : 'var(--surface-500)';
  const label =
    mode === 'vendor'
      ? 'vendor sandbox'
      : mode === 'synthetic'
      ? 'synthetic mock-db'
      : 'no sandbox';

  const synthCfg = mode === 'synthetic' ? connection.sandbox_config : null;
  const lastPrimed =
    typeof synthCfg?.last_primed_at === 'string' ? synthCfg.last_primed_at : null;
  const kbOptIn = synthCfg?.kb_opt_in === true;

  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 14,
        borderTop: '1px solid var(--rule)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Eyebrow>SANDBOX</Eyebrow>
        <button
          type="button"
          onClick={onConfigure}
          data-testid="connection-configure-sandbox"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: 'transparent',
            color: 'var(--forge-500)',
            border: '1px solid var(--forge-500)',
            padding: '4px 8px',
            borderRadius: 3,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          {mode === 'none' ? 'Configure' : 'Edit'}
        </button>
      </div>
      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 12,
          color: pillColor,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {mode === 'synthetic' && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--surface-400)',
            lineHeight: 1.5,
          }}
        >
          {lastPrimed
            ? `Last primed ${formatRelative(lastPrimed)}.`
            : 'Not yet primed — visit Sandboxes to run the active probe.'}
          {' · '}
          KB contribution {kbOptIn ? 'on' : 'off'}.
        </div>
      )}
      {mode === 'vendor' && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--surface-400)',
            lineHeight: 1.5,
          }}
        >
          Vendor sandbox creds set. Sandbox runs route to{' '}
          {(connection.sandbox_config?.base_url as string) || 'vendor sandbox'}.
        </div>
      )}
      {mode === 'none' && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--surface-500)',
            lineHeight: 1.5,
          }}
        >
          Sandbox runs against this connection error out until a mode is set.
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sandbox modal — three-mode picker. Vendor mode renders the connection's
// auth-scheme fields (same shape as production creds) to collect the
// vendor sandbox secrets; everything is encrypted on receipt.
// ----------------------------------------------------------------------------
function SandboxModal({
  connection,
  connector,
  onClose,
  onUpdated,
}: {
  connection: Connection;
  connector: Connector | undefined;
  onClose: () => void;
  onUpdated: (next: Connection) => void;
}) {
  const [mode, setMode] = useState<SandboxMode>(connection.sandbox_mode);
  const [vendorBaseUrl, setVendorBaseUrl] = useState<string>(
    typeof connection.sandbox_config?.base_url === 'string'
      ? (connection.sandbox_config.base_url as string)
      : connector?.base_url ?? ''
  );
  const [vendorSecrets, setVendorSecrets] = useState<Record<string, string>>({});
  const [kbOptIn, setKbOptIn] = useState<boolean>(
    connection.sandbox_config?.kb_opt_in !== false
  );
  const [types, setTypes] = useState<ConnectionType[]>([]);
  const [typesLoading, setTypesLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .listConnectionTypes()
      .then((ts) => {
        if (alive) setTypes(ts);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load schemes');
      })
      .finally(() => {
        if (alive) setTypesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const scheme = useMemo(
    () => types.find((t) => t.id === connection.auth_scheme) ?? null,
    [types, connection.auth_scheme]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'vendor') {
      if (!scheme) {
        setError('Auth scheme not yet loaded');
        return;
      }
      // Validate required secret fields (mirrors create-connection logic).
      for (const f of scheme.fields) {
        if (f.required && f.secret) {
          const v = (vendorSecrets[f.key] ?? '').trim();
          if (!v) {
            setError(`${f.label} is required for vendor sandbox`);
            return;
          }
        }
      }
    }
    const trimmedSecrets: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vendorSecrets)) {
      const t = v.trim();
      if (t) trimmedSecrets[k] = t;
    }

    setSubmitting(true);
    try {
      const updated = await api.updateConnectionSandbox(connection.id, {
        mode,
        vendor_base_url: vendorBaseUrl.trim() || null,
        vendor_secrets: mode === 'vendor' ? trimmedSecrets : undefined,
        kb_opt_in: mode === 'synthetic' ? kbOptIn : undefined,
      });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    background: 'var(--container-fill)',
    border: '1px solid var(--rule)',
    borderRadius: 4,
    color: 'var(--surface-50)',
    fontSize: 13,
    fontFamily: 'Inter, system-ui, sans-serif',
    outline: 'none',
    boxSizing: 'border-box',
  };
  const monoInputStyle: React.CSSProperties = {
    ...inputStyle,
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 12.5,
  };
  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'var(--surface-500)',
    marginBottom: 6,
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        background: 'rgb(0 0 0 / 0.55)',
        backdropFilter: 'blur(2px)',
        padding: 16,
      }}
      data-testid="sandbox-modal-backdrop"
    >
      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        data-testid="sandbox-modal"
        style={{
          width: '100%',
          maxWidth: 540,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--surface-900)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 18px 48px rgb(0 0 0 / 0.4)',
          color: 'var(--surface-50)',
        }}
      >
        <div>
          <Eyebrow style={{ display: 'block', marginBottom: 6 }}>SANDBOX MODE</Eyebrow>
          <div
            style={{
              fontFamily: '"Space Grotesk", Inter, sans-serif',
              fontSize: 20,
              fontWeight: 600,
              color: 'var(--surface-50)',
              letterSpacing: '-0.018em',
              lineHeight: 1.2,
            }}
          >
            Configure sandbox for {connection.label}
          </div>
          <div
            style={{
              height: 2,
              width: 28,
              background: 'var(--forge-500)',
              borderRadius: 1,
              marginTop: 8,
              boxShadow: '0 0 6px rgb(194 65 12 / 0.4)',
            }}
          />
        </div>

        {/* Three-mode picker — radio cards. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ModeCard
            active={mode === 'none'}
            onClick={() => setMode('none')}
            title="None"
            caption="Sandbox runs against this connection error out until a mode is set."
            testid="sandbox-mode-none"
          />
          <ModeCard
            active={mode === 'vendor'}
            onClick={() => setMode('vendor')}
            title="Vendor sandbox"
            caption="Use vendor-provided sandbox creds. Mock-engine bypassed; real sandbox API receives the calls."
            testid="sandbox-mode-vendor"
          />
          <ModeCard
            active={mode === 'synthetic'}
            onClick={() => setMode('synthetic')}
            title="Synthetic mock-db"
            caption="Mock-engine serves data primed from OpenAPI + read-only active probe + observed traffic."
            testid="sandbox-mode-synthetic"
          />
        </div>

        {/* Per-mode body. */}
        {mode === 'vendor' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--rule)',
            }}
          >
            <label style={{ display: 'block' }}>
              <span style={fieldLabelStyle}>
                Vendor sandbox base URL{' '}
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 9.5,
                    color: 'var(--surface-500)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  (optional)
                </span>
              </span>
              <input
                type="url"
                value={vendorBaseUrl}
                onChange={(e) => setVendorBaseUrl(e.currentTarget.value)}
                placeholder="https://sandbox.api.example.com"
                data-testid="sandbox-vendor-base-url"
                style={monoInputStyle}
              />
            </label>
            {typesLoading ? (
              <div style={{ fontSize: 12, color: 'var(--surface-500)' }}>
                Loading auth scheme…
              </div>
            ) : scheme ? (
              scheme.fields
                .filter((f) => f.secret)
                .map((f) => (
                  <label key={f.key} style={{ display: 'block' }}>
                    <span style={fieldLabelStyle}>
                      {f.label}
                      {!f.required && (
                        <span
                          style={{
                            fontFamily: '"JetBrains Mono", monospace',
                            fontSize: 9.5,
                            color: 'var(--surface-500)',
                            marginLeft: 6,
                            textTransform: 'none',
                            letterSpacing: 0,
                          }}
                        >
                          (optional)
                        </span>
                      )}
                    </span>
                    <input
                      type="password"
                      value={vendorSecrets[f.key] ?? ''}
                      onChange={(e) =>
                        setVendorSecrets((prev) => ({
                          ...prev,
                          [f.key]: e.currentTarget.value,
                        }))
                      }
                      placeholder={f.placeholder ?? ''}
                      data-testid={`sandbox-vendor-${f.key}`}
                      autoComplete="new-password"
                      style={monoInputStyle}
                    />
                  </label>
                ))
            ) : (
              <div style={{ fontSize: 12, color: 'var(--rose-500)' }}>
                Couldn't resolve auth scheme {connection.auth_scheme} — vendor mode unavailable.
              </div>
            )}
            <p
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10.5,
                color: 'var(--surface-500)',
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              Encrypted at rest with the same per-host key as production secrets.
            </p>
          </div>
        )}

        {mode === 'synthetic' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--rule)',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={kbOptIn}
                onChange={(e) => setKbOptIn(e.currentTarget.checked)}
                data-testid="sandbox-kb-opt-in"
                style={{ marginTop: 3 }}
              />
              <span style={{ fontSize: 12.5, color: 'var(--surface-50)', lineHeight: 1.5 }}>
                <strong>Contribute shape data to connector knowledge base.</strong>
                <br />
                <span style={{ color: 'var(--surface-400)', fontSize: 11.5 }}>
                  Schemas + error patterns only — never raw response bodies. Custom (non-canonical)
                  fields stay local. Cross-customer KB lands in v2; this preference takes effect
                  then.
                </span>
              </span>
            </label>
            <p
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10.5,
                color: 'var(--surface-500)',
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              Once saved, head to Sandboxes to run the active probe and watch endpoint coverage
              fill in.
            </p>
          </div>
        )}

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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
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
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            data-testid="sandbox-submit"
            className="solder-cta-forge"
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '9px 14px',
              borderRadius: 4,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Saving…' : 'Save sandbox'}
          </button>
        </div>
      </motion.form>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  caption,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  caption: string;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        background: active ? 'rgb(194 65 12 / 0.10)' : 'transparent',
        border: active ? '1px solid var(--forge-500)' : '1px solid var(--rule)',
        borderRadius: 6,
        cursor: 'pointer',
        boxShadow: active ? '0 0 0 2px rgb(194 65 12 / 0.15)' : 'none',
      }}
    >
      <div
        style={{
          fontFamily: '"Space Grotesk", Inter, sans-serif',
          fontSize: 13.5,
          fontWeight: 600,
          color: active ? 'var(--forge-400)' : 'var(--surface-50)',
          marginBottom: 2,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--surface-400)',
          lineHeight: 1.5,
        }}
      >
        {caption}
      </div>
    </button>
  );
}
