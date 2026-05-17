/*
 * HTTP editor — config shape v2 + lossless migration from v1.
 *
 * v1 (pre-rebuild) shape: { method, url, headers: dict, body: string|dict|null, pagination }.
 * v2 adds: connectionId, structured params[]/headers[] rows, body.mode discriminator
 * with json/form/template/graphql/raw branches, auth.mode override (default 'inherit'
 * routes through the bound Connection), settings.{timeout, redirects, verify,
 * sandboxOverride}, and a lastTest snapshot so the Response drawer rehydrates on
 * editor re-open.
 *
 * Migration is read-only: useMigratedConfig() in index.tsx memoises the v2 shape
 * for the editor; the v2 value is only written back to node.config on the next
 * user edit so we don't dirty every untouched legacy integration on mount.
 */

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

export const HTTP_METHODS: HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

export type HttpBodyMode =
  | 'none'
  | 'json'
  | 'form'
  | 'template'
  | 'graphql'
  | 'raw';

export type HttpAuthOverrideMode =
  | 'inherit'
  | 'none'
  | 'bearer'
  | 'basic'
  | 'api_key_header'
  | 'api_key_query';

export type HttpSandboxOverride = 'auto' | 'force-mock' | 'force-real';

export interface HttpKvRow {
  enabled: boolean;
  key: string;
  /** May contain `{{$.…}}` tokens; rendered via ReferenceField. */
  value: string;
  description?: string;
}

export interface HttpBody {
  mode: HttpBodyMode;
  json?: unknown;
  form?: HttpKvRow[];
  text?: string;
  graphqlVariables?: unknown;
  /** null = "let the backend pick the default for the mode". */
  contentType: string | null;
}

export interface HttpAuth {
  mode: HttpAuthOverrideMode;
  bearerToken?: string;
  basicUsername?: string;
  basicPassword?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
}

export interface HttpSettings {
  timeoutSeconds: number;
  followRedirects: boolean;
  rejectUnauthorized: boolean;
  sandboxOverride: HttpSandboxOverride;
}

export interface HttpPagination {
  mode: 'none' | 'page' | 'cursor' | 'link-header';
  page_param?: string;
  page_start?: number;
  page_size_param?: string;
  page_size?: number;
  cursor_path?: string;
  cursor_param?: string;
  items_path?: string;
  max_pages?: number;
  stop_on_empty?: boolean;
}

export interface HttpLastTest {
  at: string;
  status: number;
  statusText: string;
  durationMs: number;
  requestUrl: string;
  requestHeadersMasked: Array<[string, string]>;
  responseHeaders: Array<[string, string]>;
  bodyPreview: string;
  bodyTruncated: boolean;
  error?: string;
}

export interface HttpRequestConfig {
  schemaVersion: 2;
  connectionId: string | null;
  method: HttpMethod;
  url: string;
  params: HttpKvRow[];
  headers: HttpKvRow[];
  body: HttpBody;
  auth: HttpAuth;
  settings: HttpSettings;
  pagination: HttpPagination;
  lastTest?: HttpLastTest;
}

export const DEFAULT_PAGINATION: HttpPagination = {
  mode: 'none',
  page_param: 'page',
  page_start: 1,
  page_size_param: '',
  page_size: 0,
  cursor_path: '$.next_cursor',
  cursor_param: 'cursor',
  items_path: '$',
  max_pages: 100,
  stop_on_empty: true,
};

export const DEFAULT_SETTINGS: HttpSettings = {
  timeoutSeconds: 30,
  followRedirects: true,
  rejectUnauthorized: true,
  sandboxOverride: 'auto',
};

export function defaultHttpConfig(): HttpRequestConfig {
  return {
    schemaVersion: 2,
    connectionId: null,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none', contentType: null },
    auth: { mode: 'inherit' },
    settings: { ...DEFAULT_SETTINGS },
    pagination: { ...DEFAULT_PAGINATION },
  };
}

/** Headers that should NEVER round-trip into headers[] from a legacy dict —
 *  they belong on `auth` now and rendering them as user-editable headers
 *  would let two sources fight at request time. */
const RESERVED_HEADER_KEYS = new Set(['authorization', 'proxy-authorization']);

function clampMethod(m: unknown): HttpMethod {
  if (typeof m === 'string') {
    const up = m.toUpperCase() as HttpMethod;
    if (HTTP_METHODS.includes(up)) return up;
  }
  return 'GET';
}

/** Split a legacy URL into (path-or-origin, [query rows]). Preserves the
 *  fragment on the path side. `?` inside `{{$.…}}` tokens is left alone. */
export function splitUrlAndParams(url: string): {
  url: string;
  params: HttpKvRow[];
} {
  if (!url) return { url: '', params: [] };
  // Find the first `?` that isn't inside a `{{ … }}` token. Quick scan, not
  // worth pulling regex over.
  let depth = 0;
  let q = -1;
  for (let i = 0; i < url.length; i++) {
    const ch = url[i];
    if (ch === '{' && url[i + 1] === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' && url[i + 1] === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (ch === '?' && depth === 0) {
      q = i;
      break;
    }
  }
  if (q < 0) return { url, params: [] };
  const base = url.slice(0, q);
  const tail = url.slice(q + 1);
  // Preserve fragment on the URL side, not as a query row.
  const hashIdx = tail.indexOf('#');
  const queryStr = hashIdx >= 0 ? tail.slice(0, hashIdx) : tail;
  const frag = hashIdx >= 0 ? tail.slice(hashIdx) : '';
  if (!queryStr) return { url: base + frag, params: [] };
  const rows: HttpKvRow[] = queryStr
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        return { enabled: true, key: safeDecode(pair), value: '' };
      }
      return {
        enabled: true,
        key: safeDecode(pair.slice(0, eq)),
        value: safeDecode(pair.slice(eq + 1)),
      };
    });
  return { url: base + frag, params: rows };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function migrateLegacyHeaders(raw: unknown): HttpKvRow[] {
  if (Array.isArray(raw)) {
    // Already KV rows — pass through, sanitising shape.
    return raw
      .map((r) => {
        if (!r || typeof r !== 'object') return null;
        const row = r as Partial<HttpKvRow>;
        if (!row.key) return null;
        return {
          enabled: row.enabled !== false,
          key: String(row.key),
          value: typeof row.value === 'string' ? row.value : '',
          description:
            typeof row.description === 'string' ? row.description : undefined,
        } as HttpKvRow;
      })
      .filter((r): r is HttpKvRow => r !== null);
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([k]) => !RESERVED_HEADER_KEYS.has(k.toLowerCase()))
      .map(([k, v]) => ({
        enabled: true,
        key: k,
        value: typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v),
      }));
  }
  return [];
}

function migrateLegacyBody(raw: unknown): HttpBody {
  if (raw == null) return { mode: 'none', contentType: null };
  if (typeof raw === 'string') {
    return raw.trim()
      ? { mode: 'template', text: raw, contentType: 'application/json' }
      : { mode: 'none', contentType: null };
  }
  if (typeof raw === 'object') {
    return { mode: 'json', json: raw, contentType: 'application/json' };
  }
  // primitive: stringify into a template so nothing is lost.
  return {
    mode: 'template',
    text: JSON.stringify(raw),
    contentType: 'application/json',
  };
}

function migrateLegacyPagination(raw: unknown): HttpPagination {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PAGINATION };
  return { ...DEFAULT_PAGINATION, ...(raw as Partial<HttpPagination>) };
}

/** Lossless v1 → v2 migration. Idempotent on schemaVersion === 2. */
export function migrateLegacyConfig(raw: unknown): HttpRequestConfig {
  const base = defaultHttpConfig();
  if (!raw || typeof raw !== 'object') return base;
  const cfg = raw as Record<string, unknown>;

  if (cfg.schemaVersion === 2) {
    // Trust the stored value but fill any missing keys from defaults so an
    // editor written against the latest spec never sees `undefined`.
    return {
      ...base,
      ...(cfg as unknown as HttpRequestConfig),
      params: Array.isArray(cfg.params)
        ? ((cfg.params as unknown[]).filter(
            (r) => r && typeof r === 'object',
          ) as HttpKvRow[])
        : [],
      headers: Array.isArray(cfg.headers)
        ? ((cfg.headers as unknown[]).filter(
            (r) => r && typeof r === 'object',
          ) as HttpKvRow[])
        : [],
      body: { ...base.body, ...((cfg.body as HttpBody) ?? {}) },
      auth: { ...base.auth, ...((cfg.auth as HttpAuth) ?? {}) },
      settings: { ...base.settings, ...((cfg.settings as HttpSettings) ?? {}) },
      pagination: {
        ...base.pagination,
        ...((cfg.pagination as HttpPagination) ?? {}),
      },
    };
  }

  // v1 → v2.
  const { url: pathUrl, params } = splitUrlAndParams(
    typeof cfg.url === 'string' ? cfg.url : '',
  );

  return {
    schemaVersion: 2,
    connectionId:
      (typeof cfg.connectionId === 'string' && cfg.connectionId) ||
      (typeof cfg.credential_id === 'string' && (cfg.credential_id as string)) ||
      (typeof cfg.connection_id === 'string' && (cfg.connection_id as string)) ||
      null,
    method: clampMethod(cfg.method),
    url: pathUrl,
    params,
    headers: migrateLegacyHeaders(cfg.headers),
    body: migrateLegacyBody(cfg.body),
    auth: { mode: 'inherit' },
    settings: { ...DEFAULT_SETTINGS },
    pagination: migrateLegacyPagination(cfg.pagination),
  };
}
