/*
 * HTTP node editor — v2.
 *
 * Replaces the original `editors/http.tsx`. Reads `node.config` through
 * `migrateLegacyConfig` so legacy integrations render in the new editor
 * without a destructive write; only edits the user makes get persisted in
 * v2 shape.
 *
 * Layout (top to bottom):
 *   1. Method + URL bar (with live resolved-URL preview)
 *   2. Connection chip (with portal picker)
 *   3. Tab strip (Params / Headers / Body / Auth / Settings)
 *   4. Active tab body
 *   5. Footer with Test button (Cancel while running)
 *   6. Response drawer (after first Test; collapsible)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Connection } from '@/api/client';
import type { EditorProps } from '../_shared';
import ConnectionChip from './ConnectionChip';
import MethodUrlBar from './MethodUrlBar';
import ResponseDrawer from './ResponseDrawer';
import TabStrip, { methodTabsFor, type HttpTabId } from './TabStrip';
import {
  defaultHttpConfig,
  migrateLegacyConfig,
  type HttpAuth,
  type HttpBody,
  type HttpKvRow,
  type HttpMethod,
  type HttpPagination,
  type HttpRequestConfig,
  type HttpSettings,
} from './http.types';
import { useHttpTestRunner } from './useHttpTestRunner';
import ParamsTab from './tabs/ParamsTab';
import HeadersTab from './tabs/HeadersTab';
import BodyTab from './tabs/BodyTab';
import AuthTab from './tabs/AuthTab';
import SettingsTab from './tabs/SettingsTab';

const BODY_REQUIRED: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH']);

export default function HttpEditor({ node, set }: EditorProps) {
  const params = useParams<{ id?: string }>();
  const integrationId = params.id && params.id !== 'new' ? params.id : null;

  // Memoise the migrated config so re-renders don't re-walk it. Stored
  // value is the source of truth; we never write back the migrated shape
  // unprompted (avoids dirtying every legacy node on mount).
  const cfg = useMemo(() => migrateLegacyConfig(node.config), [node.config]);

  // Default tab keys off the method so GET lands on Params and POST on
  // Body — the most useful tab for each verb.
  const [tab, setTab] = useState<HttpTabId>(() =>
    BODY_REQUIRED.has(cfg.method) ? 'body' : 'params',
  );

  // Auto-bind the only available Connection for newly-minted nodes.
  // Triggers once per editor mount when:
  //   - no Connection is bound
  //   - the editor has only its default shape (empty URL, no headers, no params)
  // Anything else means the user has already shaped this node and we shouldn't
  // surprise them with an auto-bind.
  const autoBoundOnce = useRef(false);
  useEffect(() => {
    if (autoBoundOnce.current) return;
    if (cfg.connectionId) return;
    if (cfg.url || cfg.headers.length || cfg.params.length) return;
    autoBoundOnce.current = true;
    api
      .listConnections()
      .then((connections) => {
        if (connections.length !== 1) return;
        set('connectionId', connections[0].id);
      })
      .catch(() => {
        // Soft fail — auto-bind is best-effort; users can still pick manually.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull the bound Connection so we can render the resolved-URL preview
  // and the inherited-auth summary on the Headers + Auth tabs. Cached
  // until connectionId changes.
  const [boundConn, setBoundConn] = useState<Connection | null>(null);
  useEffect(() => {
    if (!cfg.connectionId) {
      setBoundConn(null);
      return;
    }
    let alive = true;
    api
      .listConnections()
      .then((rows) => {
        if (!alive) return;
        const found = rows.find((c) => c.id === cfg.connectionId) ?? null;
        setBoundConn(found);
      })
      .catch(() => {
        if (alive) setBoundConn(null);
      });
    return () => {
      alive = false;
    };
  }, [cfg.connectionId]);

  // Live resolved-URL preview.
  const enabledParams = useMemo(
    () => cfg.params.filter((r) => r.enabled !== false && r.key),
    [cfg.params],
  );
  const resolvedUrl = useMemo(() => {
    const isAbsolute = cfg.url.startsWith('http://') || cfg.url.startsWith('https://');
    let base: string;
    if (isAbsolute) {
      base = cfg.url;
    } else if (boundConn?.base_url) {
      const trimmed = boundConn.base_url.replace(/\/+$/, '');
      base = trimmed + (cfg.url.startsWith('/') ? cfg.url : `/${cfg.url}`);
    } else {
      base = cfg.url;
    }
    if (!enabledParams.length) return base;
    const q = enabledParams
      .map((r) => `${encodeURIComponent(r.key)}=${encodeURIComponent(r.value ?? '')}`)
      .join('&');
    return base.includes('?') ? `${base}&${q}` : `${base}?${q}`;
  }, [cfg.url, boundConn, enabledParams]);

  // URL validity hint — surfaces the "absolute URL or bind a Connection"
  // requirement without blocking the user mid-edit.
  const urlErrorHint = useMemo(() => {
    if (!cfg.url) return null;
    const isAbsolute = cfg.url.startsWith('http://') || cfg.url.startsWith('https://');
    if (isAbsolute) return null;
    if (!cfg.connectionId) {
      return 'Relative path needs a bound Connection. Bind one above or use an absolute URL.';
    }
    return null;
  }, [cfg.url, cfg.connectionId]);

  // Inherited-auth summary — for the Headers virtual row + Auth-tab subtitle.
  const inheritedAuthSummary = useMemo(() => {
    if (cfg.auth.mode !== 'inherit') return null;
    if (!boundConn) return null;
    const labelByScheme: Record<string, string> = {
      bearer: 'Bearer ••• ',
      api_key_header: 'API key (header) ',
      api_key_query: 'API key (query) ',
      basic: 'Basic ',
      oauth2_cc: 'OAuth2 client-credentials ',
    };
    const prefix = labelByScheme[boundConn.auth_scheme] ?? `${boundConn.auth_scheme} `;
    return `${prefix}via ${boundConn.label}`;
  }, [cfg.auth.mode, boundConn]);

  // Method-switch behaviour: when going GET→POST/PUT/PATCH from a "none"
  // body, default the body to JSON mode and auto-jump to the Body tab
  // (the spec's "Body required" gesture). Stashed body content is
  // preserved when going the other direction — see TabStrip's forge dot.
  function setMethod(next: HttpMethod) {
    set('method', next);
    if (BODY_REQUIRED.has(next) && cfg.body.mode === 'none') {
      set('body', { mode: 'json', contentType: 'application/json' });
      setTab('body');
    } else if (!BODY_REQUIRED.has(next) && tab === 'body') {
      setTab('params');
    }
  }

  // Tab counts + stashed-body indicator.
  const tabs = useMemo(
    () =>
      methodTabsFor(cfg.method, {
        params: enabledParams.length,
        headers: cfg.headers.filter((r) => r.enabled !== false && r.key).length,
        bodyEmpty: cfg.body.mode === 'none',
        hasStashedBody: cfg.body.mode !== 'none' && !BODY_REQUIRED.has(cfg.method),
      }),
    [cfg.method, enabledParams.length, cfg.headers, cfg.body.mode],
  );

  // Test runner.
  const runner = useHttpTestRunner({
    nodeId: node.id,
    kind: node.kind,
    action: node.action,
    cfg,
    integrationId,
    onLastTest: (snapshot) => set('lastTest', snapshot),
  });

  // Smart auto-test guard: don't fire if the URL is empty.
  const canTest = !!cfg.url;

  return (
    <div className="flex flex-col gap-3">
      <MethodUrlBar
        nodeId={node.id}
        method={cfg.method}
        onMethodChange={setMethod}
        url={cfg.url}
        onUrlChange={(url) => set('url', url)}
        resolvedUrl={resolvedUrl}
        errorHint={urlErrorHint}
      />

      <ConnectionChip
        connectionId={cfg.connectionId}
        onChange={(id) => set('connectionId', id)}
      />

      <div className="flex flex-col">
        <TabStrip tabs={tabs} active={tab} onSelect={setTab} />
        <div className="pt-3">
          {tab === 'params' && (
            <ParamsTab
              nodeId={node.id}
              rows={cfg.params}
              onChange={(rows: HttpKvRow[]) => set('params', rows)}
            />
          )}
          {tab === 'headers' && (
            <HeadersTab
              nodeId={node.id}
              rows={cfg.headers}
              onChange={(rows: HttpKvRow[]) => set('headers', rows)}
              inheritedAuthSummary={inheritedAuthSummary}
            />
          )}
          {tab === 'body' && !tabs.find((t) => t.id === 'body')?.disabled && (
            <BodyTab
              nodeId={node.id}
              body={cfg.body}
              onChange={(body: HttpBody) => set('body', body)}
            />
          )}
          {tab === 'auth' && (
            <AuthTab
              nodeId={node.id}
              auth={cfg.auth}
              inheritedSummary={inheritedAuthSummary}
              onChange={(auth: HttpAuth) => set('auth', auth)}
            />
          )}
          {tab === 'settings' && (
            <SettingsTab
              nodeId={node.id}
              method={cfg.method}
              settings={cfg.settings}
              pagination={cfg.pagination}
              onSettings={(s: HttpSettings) => set('settings', s)}
              onPagination={(p: HttpPagination) => set('pagination', p)}
            />
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-end gap-2 pt-2 border-t"
        style={{ borderColor: 'var(--rule)' }}
      >
        {runner.state.status === 'running' && (
          <button
            type="button"
            onClick={runner.cancel}
            className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-surface-500 hover:text-rose-500 dark:text-surface-400 dark:hover:text-rose-400 px-3 py-1.5 rounded border border-surface-300 dark:border-surface-700"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => runner.run()}
          disabled={!canTest || runner.state.status === 'running'}
          className="solder-cta-forge font-mono text-[10.5px] uppercase tracking-[0.08em] px-3 py-1.5 rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="http-test-request"
        >
          {runner.state.status === 'running' ? 'Testing…' : 'Test request'}
        </button>
      </div>

      <ResponseDrawer state={runner.state} method={cfg.method} />
    </div>
  );
}
