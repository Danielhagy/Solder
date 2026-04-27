import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  api,
  brandLogoUrl,
  type Connection,
  type Connector,
  type ConnectionType,
} from '@/api/client';
import PageHeader from '@/components/PageHeader';
import EmptyFrame from '@/components/EmptyFrame';
import Select from '@/components/Select';

/**
 * Connections — atelier-wall of brand tiles, one per stored connection.
 *
 * Each tile renders the connector's Brandfetch logo (when `brand_domain`
 * is set) and the user-chosen label. Secrets never round-trip; this page
 * only ever sees `(id, connector_id, label, timestamps)`. Authoring a new
 * connection opens a modal that POSTs plaintext secrets to
 * `/api/connections`, where the backend immediately encrypts and stores
 * them at rest (FullSpec § 12 Q1).
 *
 * The visual point of view: dense, grid-ish but slightly off-axis tiles —
 * a wall of identity, not a list. Empty rail-corner ornaments via
 * `frame-corners` keep it editorial rather than dashboardy.
 */
export default function Connections() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

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

  async function handleDelete(id: string, label: string) {
    if (!confirm(`Delete connection "${label}"? This won't unbind it from any integration that references it.`)) return;
    try {
      await api.deleteConnection(id);
      setConnections((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        eyebrow="connections"
        title="Connections"
        description="Authored once, bound by alias to many integrations. Secrets are encrypted at rest."
        action={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowCreate(true)}
            data-testid="connection-new"
          >
            + New connection
          </button>
        }
      />

      {error && <div className="alert alert-danger mb-4">{error}</div>}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-40 animate-pulse" />
          ))}
        </div>
      ) : connections.length === 0 ? (
        <EmptyFrame
          label="state · empty"
          glyph="◇"
          title="No connections yet"
          description="A connection bundles a connector and a credential set. Author one here, then reference it from any integration's connection rail under whatever alias suits the flow ('crm', 'billing', 'primary')."
        />
      ) : (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          data-testid="connections-grid"
        >
          {connections.map((conn, i) => {
            // Custom connections (no connector_id) intentionally have no
            // connector lookup — the tile falls back to a typographic mark
            // and the connection's `auth_scheme` for the eyebrow.
            const connector = conn.connector_id
              ? connectorById.get(conn.connector_id)
              : undefined;
            return (
              <motion.div
                key={conn.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: Math.min(i, 6) * 0.02 }}
              >
                <ConnectionTile
                  connection={conn}
                  connector={connector}
                  onDelete={() => handleDelete(conn.id, conn.label)}
                />
              </motion.div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateConnectionModal
          connectors={connectors}
          onClose={() => setShowCreate(false)}
          onCreated={(c) => {
            setConnections((prev) => [...prev, c]);
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}

function ConnectionTile({
  connection,
  connector,
  onDelete,
}: {
  connection: Connection;
  connector: Connector | undefined;
  onDelete: () => void;
}) {
  const logo = connector ? brandLogoUrl(connector.brand_domain) : null;
  // Custom connections fall back to the auth_scheme as the eyebrow
  // service label (e.g. "Bearer Token", "Basic Auth") since there's
  // no Connector to read a display name from.
  const display = connector?.display_name ?? schemeDisplayName(connection.auth_scheme);

  return (
    <div
      className="card p-4 flex flex-col gap-3 group relative"
      data-testid={`connection-tile-${connection.id}`}
    >
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 flex-shrink-0 rounded-md overflow-hidden ring-1 ring-surface-200 dark:ring-surface-800 bg-white grid place-items-center">
          {logo ? (
            <img
              src={logo}
              alt=""
              className="h-10 w-10 object-contain"
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <span className="font-display text-lg text-surface-700 dark:text-surface-300">
              {display.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="eyebrow">{display}</div>
          <div className="font-medium text-surface-900 dark:text-surface-50 truncate">
            {connection.label}
          </div>
          <div className="text-[11px] font-mono text-surface-400 dark:text-surface-500 truncate">
            {connection.auth_scheme}
            {(connector?.base_url || connection.base_url) && (
              <> · {connector?.base_url ?? connection.base_url}</>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-surface-100 dark:border-surface-800">
        <span className="text-[11px] font-mono text-surface-400 dark:text-surface-500">
          {new Date(connection.created_at).toLocaleDateString()}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-surface-500 hover:text-rose-600 dark:hover:text-rose-400"
          data-testid={`connection-delete-${connection.id}`}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** Human-friendly label for an auth scheme id — used by the tile eyebrow
 *  when the connection is custom (no Connector display name to read). */
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

type Mode = 'builtin' | 'custom';

/**
 * CreateConnectionModal — two-mode authoring.
 *
 *   Built-in   pick one of the registered connectors (Zip, HubSpot, …);
 *              auth scheme is inherited from the connector definition.
 *   Custom     no connector — pick one of the five primitive connection
 *              types (bearer / api_key_header / api_key_query / basic /
 *              oauth2_cc) and fill in its declared fields. Useful when
 *              Solder doesn't ship a connector for the service the user
 *              needs to talk to.
 *
 * The form for either mode is generated from the same `ConnectionType`
 * shape returned by `GET /api/connection-types`. For built-in mode we
 * resolve the relevant type from `connector.auth_scheme`; for custom we
 * let the user pick. This keeps the auth-scheme catalog as a single
 * source of truth on the backend — adding a new scheme there auto-
 * surfaces here without a frontend change.
 */
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

  // Fetch the connection-type catalog once on mount. The catalog drives
  // both the custom-mode picker and the dynamic field rendering.
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

  // Active scheme: derived from connector for built-in mode, picked
  // directly for custom mode. Falls back to bearer when the catalog is
  // still loading or the connector pins an exotic scheme not in the
  // catalog (treated as a misconfig).
  const activeScheme = useMemo(() => {
    const target =
      mode === 'builtin' ? connector?.auth_scheme ?? 'bearer' : customSchemeId;
    return types.find((t) => t.id === target);
  }, [mode, connector, customSchemeId, types]);

  // When the active scheme changes, prime its fields with their declared
  // defaults (and keep any value the user already typed for fields that
  // are shared across schemes — e.g. a secret pasted as `key` survives
  // a switch from api_key_header to api_key_query).
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
    // Split user input into secret/config buckets per the scheme's
    // declaration. Server validates required fields again — this is
    // a UX-only pre-check.
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

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-surface-950/40 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        className="card w-full max-w-lg p-5 space-y-4 dark:bg-surface-900 max-h-[90vh] overflow-y-auto solder-scroll-thin"
        data-testid="connection-create-modal"
      >
        <div>
          <div className="eyebrow">new connection</div>
          <div className="font-display text-lg text-surface-900 dark:text-surface-50">
            Author a new connection
          </div>
        </div>

        {/* Mode toggle: built-in connector vs custom service. */}
        <div className="flex items-center rounded-md bg-surface-100 p-1 dark:bg-surface-900/60 w-full">
          <ModeButton active={mode === 'builtin'} onClick={() => setMode('builtin')} testid="connection-mode-builtin">
            Built-in connector
          </ModeButton>
          <ModeButton active={mode === 'custom'} onClick={() => setMode('custom')} testid="connection-mode-custom">
            Custom service
          </ModeButton>
        </div>

        {mode === 'builtin' ? (
          <label className="block">
            <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
              Connector
            </span>
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
              <p className="text-[11px] font-mono text-surface-400 mt-1 dark:text-surface-500">
                {connector.base_url} · scheme {connector.auth_scheme}
              </p>
            )}
          </label>
        ) : (
          <label className="block">
            <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
              Connection type
            </span>
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
              <p className="text-xs text-surface-500 mt-1.5 dark:text-surface-400">
                {activeScheme.description}
              </p>
            )}
          </label>
        )}

        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Label
          </span>
          <input
            type="text"
            className="input w-full"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder={
              mode === 'builtin'
                ? 'e.g. Zip — sandbox tenant'
                : 'e.g. Acme CRM — production'
            }
            data-testid="connection-label"
            autoFocus
          />
        </label>

        {/* Custom mode: optional base URL. Built-in inherits from the connector. */}
        {mode === 'custom' && (
          <label className="block">
            <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
              Base URL <span className="text-[11px] font-mono text-surface-400">(optional)</span>
            </span>
            <input
              type="url"
              className="input w-full font-mono text-sm"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
              placeholder="https://api.example.com"
              data-testid="connection-base-url"
            />
          </label>
        )}

        {/* Dynamic field rendering driven by the active scheme. */}
        {activeScheme && activeScheme.fields.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-surface-100 dark:border-surface-800">
            {activeScheme.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
                  {f.label}
                  {!f.required && (
                    <span className="text-[11px] font-mono text-surface-400 ml-1.5">(optional)</span>
                  )}
                </span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  className="input w-full font-mono text-sm"
                  value={values[f.key] ?? ''}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.currentTarget.value }))
                  }
                  placeholder={f.placeholder ?? f.default ?? ''}
                  data-testid={`connection-field-${f.key}`}
                  autoComplete={f.secret ? 'new-password' : 'off'}
                />
                {f.help && (
                  <p className="text-[11px] text-surface-500 mt-1 dark:text-surface-400">{f.help}</p>
                )}
              </label>
            ))}
            <p className="text-[11px] text-surface-500 dark:text-surface-400">
              Secret fields are encrypted at rest with AES-256-GCM (per-host key, mode 0600) and never round-trip back.
            </p>
          </div>
        )}

        {error && <div className="alert alert-danger text-xs">{error}</div>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              submitting ||
              !activeScheme ||
              (mode === 'builtin' && connectors.length === 0)
            }
            data-testid="connection-submit"
          >
            {submitting ? 'Creating…' : 'Create connection'}
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
      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
        active
          ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-surface-50'
          : 'text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50'
      }`}
    >
      {children}
    </button>
  );
}
