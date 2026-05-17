/*
 * useHttpTestRunner — fires the per-node Test API for an HTTP node and
 * exposes a small state machine ({status, result, error, durationMs}) the
 * ResponseDrawer renders against.
 *
 * Wraps `api.testNode` so the editor can present a single button that says
 * "run this request right now and show me what comes back" — the existing
 * TestNodeOverlay portal modal is still the canonical multi-step flow,
 * but for HTTP that flow is heavier than necessary once the editor knows
 * how to render a response inline.
 */
import { useCallback, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { HttpLastTest, HttpRequestConfig } from './http.types';

export type HttpTestStatus = 'idle' | 'running' | 'done' | 'error';

export interface HttpTestState {
  status: HttpTestStatus;
  /** Server-returned envelope: status_code, headers, body, request_url,
   *  request_headers. `headers` are the response headers (what the server
   *  sent us); `request_headers` are the headers Solder put on the wire,
   *  with secrets pre-masked by the backend. */
  result: {
    status_code: number;
    headers: Record<string, string>;
    body: unknown;
    request_url?: string;
    request_headers?: Array<[string, string]>;
  } | null;
  error: string | null;
  durationMs: number;
}

const initialState: HttpTestState = {
  status: 'idle',
  result: null,
  error: null,
  durationMs: 0,
};

/** Truncate large body previews so the response snapshot doesn't bloat
 *  node.config beyond a useful size. 32KB matches the spec. */
const BODY_PREVIEW_MAX = 32 * 1024;

export function bodyToPreview(body: unknown): { preview: string; truncated: boolean } {
  let str: string;
  try {
    str = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  } catch {
    str = String(body);
  }
  if (str.length <= BODY_PREVIEW_MAX) return { preview: str, truncated: false };
  return { preview: str.slice(0, BODY_PREVIEW_MAX) + '\n…(truncated)', truncated: true };
}

export interface UseHttpTestRunnerArgs {
  nodeId: string;
  kind: string;
  action: string;
  cfg: HttpRequestConfig;
  integrationId?: string | null;
  onLastTest?: (snapshot: HttpLastTest) => void;
}

export function useHttpTestRunner({
  nodeId,
  kind,
  action,
  cfg,
  integrationId,
  onLastTest,
}: UseHttpTestRunnerArgs) {
  const [state, setState] = useState<HttpTestState>(initialState);
  const inflight = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setState({ status: 'running', result: null, error: null, durationMs: 0 });
    const started = performance.now();
    try {
      const res = await api.testNode({
        node: {
          id: nodeId,
          kind,
          action,
          config: cfg,
        },
        integration_id: integrationId ?? undefined,
      });
      if (ctrl.signal.aborted) return;
      const durationMs = Math.round(performance.now() - started);
      if (!res.ok) {
        setState({
          status: 'error',
          result: null,
          error: res.error || `Test failed (${res.error_kind ?? 'unknown'})`,
          durationMs,
        });
        return;
      }
      const out = res.output as
        | {
            status_code?: number;
            headers?: Record<string, string>;
            body?: unknown;
            request_url?: string;
            request_headers?: Array<[string, string]>;
          }
        | undefined;
      const status_code = out?.status_code ?? 0;
      const headers = out?.headers ?? {};
      const body = out?.body;
      const request_url = out?.request_url;
      const request_headers = out?.request_headers;
      setState({
        status: 'done',
        result: { status_code, headers, body, request_url, request_headers },
        error: null,
        durationMs,
      });
      const preview = bodyToPreview(body);
      onLastTest?.({
        at: new Date().toISOString(),
        status: status_code,
        statusText: status_code >= 200 && status_code < 300 ? 'OK' : 'fail',
        durationMs,
        requestUrl: request_url ?? '',
        requestHeadersMasked: [],
        responseHeaders: Object.entries(headers),
        bodyPreview: preview.preview,
        bodyTruncated: preview.truncated,
      });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setState({
        status: 'error',
        result: null,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Math.round(performance.now() - started),
      });
    }
  }, [nodeId, kind, action, cfg, integrationId, onLastTest]);

  const cancel = useCallback(() => {
    inflight.current?.abort();
    inflight.current = null;
    setState((s) => (s.status === 'running' ? { ...s, status: 'idle' } : s));
  }, []);

  return { state, run, cancel };
}
