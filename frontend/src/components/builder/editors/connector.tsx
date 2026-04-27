import { useEffect, useState } from 'react';
import { lookupCatalog } from '@/catalog';
import { useIntegrationStore } from '@/stores/integration';
import Select from '@/components/Select';
import type { EditorProps } from './_shared';

interface DiscoverableEndpoint {
  path: string;
  method: string;
  entity_type: string;
}

interface ConnectorSummary {
  id: string;
  name: string;
  display_name: string;
  base_url: string;
  auth_scheme: string;
  discoverable_endpoints: DiscoverableEndpoint[];
}

interface ConnectionSummary {
  id: string;
  connector_id: string;
  label: string;
}

/**
 * Editor for connector-bound nodes (`kind: 'zip' | 'hubspot' | …`). One
 * palette node per connector; the specific operation is chosen here.
 *
 * Three controls in order:
 *   1. Operation — populated from `connector.discoverable_endpoints`.
 *      Selecting an operation writes `node.action` plus
 *      `node.config.endpoint.{path, method, entity_type}` together so
 *      the workflow's connector dispatch path can route the call.
 *   2. Connection — picked from `/api/connections?connector_id=…`. Falls
 *      back to a free-text id input when no connections exist for this
 *      connector yet (so the editor still works pre-Connections-page).
 *   3. Pagination override — collapsed details block; the catalog ships
 *      sensible defaults per connector (HubSpot cursor, Zip none).
 */
export default function ConnectorEditor({ node, set }: EditorProps) {
  const meta = lookupCatalog(node.kind, node.action);
  const connectorName = meta.requiresConnector ?? node.kind;
  const endpoint = (node.config.endpoint as
    | { path?: string; method?: string; entity_type?: string }
    | undefined) ?? {};

  const [connector, setConnector] = useState<ConnectorSummary | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve the connector + its connections. Both endpoints are local —
  // failures fall through to the free-text fallback.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const cRes = await fetch('/api/connectors');
        if (!cRes.ok) throw new Error(`connectors: ${cRes.status}`);
        const list: ConnectorSummary[] = await cRes.json();
        const found = list.find((c) => c.name === connectorName) ?? null;
        if (!alive) return;
        setConnector(found);
        if (found) {
          const connRes = await fetch(
            `/api/connections?connector_id=${encodeURIComponent(found.id)}`
          );
          if (!connRes.ok) throw new Error(`connections: ${connRes.status}`);
          const conns: ConnectionSummary[] = await connRes.json();
          if (!alive) return;
          setConnections(conns);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load connector');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [connectorName]);

  const connectionId = (node.config.credential_id as string) || '';
  const knownConn = connections.find((c) => c.id === connectionId);
  const operations = connector?.discoverable_endpoints ?? [];
  // Operation key encodes both axes so a connector can offer multiple
  // methods on the same path without collision (e.g. GET vs POST /contacts).
  const opKey = (op: DiscoverableEndpoint) => `${op.method}|${op.path}`;
  const currentOp = operations.find(
    (op) => op.path === endpoint.path && op.method === (endpoint.method ?? 'GET')
  );

  // The shared `set` helper only writes into `node.config`. The Operation
  // picker also needs to flip `node.action` (top-level field) so step
  // records and the run drawer show a meaningful node_type. Reach into
  // the store directly for that one field.
  const updateNode = useIntegrationStore((s) => s.updateNode);

  function handleOperationChange(key: string) {
    const op = operations.find((o) => opKey(o) === key);
    if (!op) return;
    // Derive the action from entity_type — `vendor` → `list_vendors`,
    // `purchase_order` → `list_purchase_orders`, etc. Falls back to the
    // path tail so non-standard entity types still produce a usable action.
    const tail = op.path.replace(/\/$/, '').split('/').pop() ?? 'op';
    const action = op.entity_type
      ? `list_${op.entity_type}s`
      : `list_${tail}`;
    updateNode(node.id, { action });
    set('endpoint', {
      path: op.path,
      method: op.method,
      entity_type: op.entity_type
    });
  }

  return (
    <div className="space-y-3">
      {/* Endpoint card — read-only summary of what this node calls. */}
      <div className="card p-3 space-y-1">
        <div className="flex items-center gap-2">
          <span className="eyebrow">{connector?.display_name ?? connectorName}</span>
          {connector && (
            <span className="text-[11px] font-mono text-surface-400 dark:text-surface-500 truncate">
              {connector.base_url}
            </span>
          )}
        </div>
        <div className="font-mono text-sm text-surface-800 dark:text-surface-200">
          {endpoint.path ? (
            <>
              <span className="text-surface-500 dark:text-surface-400">{endpoint.method ?? 'GET'}</span>{' '}
              {endpoint.path}
            </>
          ) : (
            <span className="text-surface-400 dark:text-surface-500 italic">
              no operation selected
            </span>
          )}
        </div>
        {endpoint.entity_type && (
          <div className="text-[11px] font-mono text-surface-400 dark:text-surface-500">
            returns array of <span className="text-surface-600 dark:text-surface-300">{endpoint.entity_type}</span>
          </div>
        )}
      </div>

      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Operation
        </span>
        <Select
          value={currentOp ? opKey(currentOp) : ''}
          onChange={handleOperationChange}
          options={operations.map((op) => ({
            value: opKey(op),
            label: `${op.method} ${op.path}`,
            caption: op.entity_type || undefined,
          }))}
          placeholder={
            loading
              ? 'Loading operations…'
              : operations.length
                ? 'Pick an operation'
                : 'No operations exposed by this connector'
          }
          disabled={!operations.length}
          width="100%"
          ariaLabel="Operation"
          testid="connector-operation"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          What this node does. Each entry is a discoverable endpoint on{' '}
          {connector?.display_name ?? connectorName}.
        </p>
      </label>

      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Connection
        </span>
        {connections.length > 0 ? (
          <Select
            value={connectionId}
            onChange={(v) => set('credential_id', v)}
            options={connections.map((c) => ({ value: c.id, label: c.label }))}
            placeholder={loading ? 'Loading…' : 'Pick a connection'}
            width="100%"
            ariaLabel="Connection"
            testid="connector-credential"
          />
        ) : (
          <input
            type="text"
            className="input w-full font-mono text-sm"
            value={connectionId}
            placeholder={
              loading
                ? 'Loading connections…'
                : connector
                  ? 'No connections yet — paste an id'
                  : 'Connector not found'
            }
            onChange={(e) => set('credential_id', e.currentTarget.value)}
            data-testid="connector-credential"
          />
        )}
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          {connections.length > 0
            ? `${connections.length} connection${connections.length === 1 ? '' : 's'} available for ${connectorName}.`
            : 'Author one in the Connections tab, or paste an id directly.'}
        </p>
        {connectionId && !knownConn && connections.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-300 mt-1">
            Connection id not found in this connector's list — runtime will 401.
          </p>
        )}
      </label>

      {error && <div className="alert alert-danger text-xs">{error}</div>}

      <PaginationOverride node={node} set={set} />
    </div>
  );
}

type PaginationCfg = {
  mode?: 'none' | 'page' | 'cursor' | 'link-header';
  page_param?: string;
  page_start?: number;
  cursor_path?: string;
  cursor_param?: string;
  items_path?: string;
  max_pages?: number;
  stop_on_empty?: boolean;
};

/**
 * Compact pagination override — connector ops default to no pagination
 * because the discoverable endpoints are already lists. Most users won't
 * touch this; the few that need to (`max_pages` for safety) get a
 * collapsed details block instead of the full http.request pagination
 * monster.
 */
function PaginationOverride({ node, set }: EditorProps) {
  const pagination = (node.config.pagination as PaginationCfg | undefined) ?? { mode: 'none' };
  const mode = pagination.mode ?? 'none';
  const patch = (partial: Partial<PaginationCfg>) =>
    set('pagination', { ...pagination, ...partial });

  return (
    <details className="pt-1">
      <summary className="text-sm font-medium cursor-pointer select-none text-surface-700 dark:text-surface-200">
        Pagination
        <span className="ml-2 text-[10px] font-mono text-surface-400 dark:text-surface-500">
          {mode === 'none' ? 'off' : mode}
        </span>
      </summary>
      <div className="mt-3 space-y-3 pl-2 border-l-2 border-surface-200 dark:border-surface-800">
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Mode</span>
          <Select
            value={mode}
            onChange={(v) => patch({ mode: v as PaginationCfg['mode'] })}
            options={[
              { value: 'none', label: 'None (single page)' },
              { value: 'page', label: 'Page number' },
              { value: 'cursor', label: 'Cursor' },
              { value: 'link-header', label: 'Link header' },
            ]}
            width="100%"
            ariaLabel="Pagination mode"
          />
        </label>
        {mode !== 'none' && (
          <label className="block">
            <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
              Max pages
            </span>
            <input
              type="number"
              className="input w-full font-mono text-sm"
              value={pagination.max_pages ?? 100}
              onChange={(e) => patch({ max_pages: Number(e.currentTarget.value) || 1 })}
            />
            <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
              Hard cap on iteration to keep runaway calls in check.
            </p>
          </label>
        )}
      </div>
    </details>
  );
}
