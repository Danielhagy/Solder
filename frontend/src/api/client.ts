const API_BASE = '/api';

export interface Integration {
  id: string;
  name: string;
  description?: string;
  config: IntegrationConfig;
  is_active: boolean;
  is_library?: boolean;
  status?: string;
  trigger?: { type: string; [k: string]: unknown };
  /**
   * 'sandbox' routes connector ops to Solder's local mock-engine with
   * synthesised test data. 'production' routes through the chosen
   * Connection's real credentials + base_url — vendor sandbox vs vendor
   * prod is encoded in the Connection's label/base_url, not here.
   */
  environment?: 'sandbox' | 'production';
  created_at: string;
  updated_at: string;
  /**
   * ISO timestamp set when the integration was soft-deleted via DELETE
   * /api/integrations/{id}. Null/undefined for live rows. The backend
   * hard-purges these after 30 days (provided no Run rows still
   * reference them). UI can render "deleted X ago" off this field.
   */
  deleted_at?: string | null;
}

export interface Run {
  id: string;
  integration_id: string;
  status: string;
  input_data?: unknown;
  output_data?: unknown;
  error_message?: string;
  steps: unknown[];
  started_at?: string;
  completed_at?: string;
  created_at: string;
}

export interface OpenAPISpec {
  id: string;
  name: string;
  url?: string;
  version: string;
  spec_json: unknown;
  parsed_markdown?: string;
  created_at: string;
}

export interface IntegrationConfig {
  nodes: unknown[];
  variables: Record<string, unknown>;
  // Optional for legacy payloads — new integrations don't emit this.
  connections?: unknown[];
}

export interface IntegrationVersion {
  id: string;
  integration_id: string;
  version_number: number;
  name: string;
  description?: string;
  config: IntegrationConfig;
  trigger: { type: string; [k: string]: unknown };
  is_library: boolean;
  change_summary: string;
  created_at: string;
}

export interface DiscoverableEndpoint {
  path: string;
  method: string;
  entity_type: string;
}

export interface Connector {
  id: string;
  name: string;
  display_name: string;
  auth_scheme: string;
  base_url: string;
  brand_domain: string | null;
  description?: string | null;
  discoverable_endpoints: DiscoverableEndpoint[];
  metadata_json: Record<string, unknown>;
}

export type SandboxMode = 'none' | 'vendor' | 'synthetic';

export interface Connection {
  id: string;
  connector_id: string | null;
  label: string;
  auth_scheme: string;
  base_url: string | null;
  config_json: Record<string, unknown>;
  /** Sandboxes v1: how this connection is served when an integration
   *  runs in `environment='sandbox'`. */
  sandbox_mode: SandboxMode;
  /** Per-mode payload. For 'vendor': `{ base_url, creds_set: bool }`
   *  (encrypted creds redacted at the API layer). For 'synthetic':
   *  `{ kb_opt_in, last_primed_at, endpoints: { <path>: {...} } }`. */
  sandbox_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConnectionTypeField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  default?: string | null;
  placeholder?: string | null;
  help?: string | null;
}

export interface ConnectionType {
  id: string;
  label: string;
  description: string;
  fields: ConnectionTypeField[];
}


async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }));
    throw new Error(error.detail || 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  listIntegrations: () => request<Integration[]>('/integrations'),
  listSubprocesses: async () => {
    // Backend doesn't yet filter by is_library on the list endpoint; filter here.
    const all = await request<Integration[]>('/integrations');
    return all.filter((i) => i.is_library === true);
  },
  getIntegration: (id: string) => request<Integration>(`/integrations/${id}`),
  createIntegration: (data: {
    name: string;
    description?: string;
    config: IntegrationConfig;
    trigger?: { type: string; [k: string]: unknown };
    is_library?: boolean;
    environment?: 'sandbox' | 'production';
  }) =>
    request<Integration>('/integrations', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  updateIntegration: (
    id: string,
    data: Partial<Integration> & { trigger?: { type: string; [k: string]: unknown } }
  ) =>
    request<Integration>(`/integrations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),
  deleteIntegration: (id: string) => request<void>(`/integrations/${id}`, { method: 'DELETE' }),

  listVersions: (integrationId: string) =>
    request<IntegrationVersion[]>(`/integrations/${integrationId}/versions`),
  restoreVersion: (integrationId: string, versionNumber: number) =>
    request<Integration>(`/integrations/${integrationId}/versions/${versionNumber}/restore`, {
      method: 'POST'
    }),

  listRuns: (integrationId?: string) => {
    const params = integrationId ? `?integration_id=${integrationId}` : '';
    return request<Run[]>(`/runs${params}`);
  },
  getRun: (id: string) => request<Run>(`/runs/${id}`),
  createRun: (integrationId: string, inputData?: unknown) =>
    request<Run>('/runs', {
      method: 'POST',
      body: JSON.stringify({ integration_id: integrationId, input_data: inputData })
    }),
  executeRun: (id: string) => request<Run>(`/runs/${id}/execute`, { method: 'POST' }),

  listOpenAPISpecs: () => request<OpenAPISpec[]>('/openapi'),
  getOpenAPISpec: (id: string) => request<OpenAPISpec>(`/openapi/${id}`),
  fetchOpenAPISpec: (url: string, name: string) =>
    request<OpenAPISpec>(
      `/openapi/fetch?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
      { method: 'POST' }
    ),
  uploadOpenAPISpec: async (name: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(
      `${API_BASE}/openapi/upload?name=${encodeURIComponent(name)}`,
      { method: 'POST', body: formData }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: 'Upload failed' }));
      throw new Error(err.detail || 'Upload failed');
    }
    return response.json() as Promise<OpenAPISpec>;
  },
  deleteOpenAPISpec: (id: string) => request<void>(`/openapi/${id}`, { method: 'DELETE' }),
  /** Flat per-operation listing for the "+ Sandbox from Spec" wizard.
   *  One entry per (method, path) — drives the endpoint checklist
   *  without re-parsing megabyte specs on the client. */
  listSpecEndpoints: (specId: string) =>
    request<{
      spec_id: string;
      name: string;
      version: string;
      endpoints: Array<{
        method: string;
        path: string;
        operation_id: string | null;
        summary: string;
        tags: string[];
        deprecated: boolean;
      }>;
      tags: string[];
      total: number;
    }>(`/openapi/${specId}/endpoints`),

  buildWithAI: (description: string, openApiSpecId?: string, existingIntegrationId?: string) =>
    request<{ integration_config: IntegrationConfig; explanation: string; suggested_name: string }>(
      '/agents/build',
      {
        method: 'POST',
        body: JSON.stringify({
          description,
          openapi_spec_id: openApiSpecId,
          existing_integration_id: existingIntegrationId
        })
      }
    ),
  testWithAI: (integrationId: string, testInput?: unknown) =>
    request<{ success: boolean; output?: unknown; error?: string; suggestions: string[] }>(
      '/agents/test',
      {
        method: 'POST',
        body: JSON.stringify({ integration_id: integrationId, test_input: testInput })
      }
    ),

  // ── Connectors / Connections / IntegrationConnections (Slice 2.5) ──
  listConnectors: () => request<Connector[]>('/connectors'),
  listConnections: (connectorId?: string) => {
    const q = connectorId ? `?connector_id=${encodeURIComponent(connectorId)}` : '';
    return request<Connection[]>(`/connections${q}`);
  },
  createConnection: (data: {
    label: string;
    connector_id?: string | null;
    auth_scheme?: string;
    base_url?: string | null;
    secrets?: Record<string, unknown>;
    config?: Record<string, unknown>;
  }) =>
    request<Connection>('/connections', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  deleteConnection: (id: string) => request<void>(`/connections/${id}`, { method: 'DELETE' }),
  /** Set or clear a connection's sandbox config (Sandboxes v1).
   *  - `mode: 'none'` clears any prior config.
   *  - `mode: 'vendor'` requires `vendor_secrets` (encrypted on receipt);
   *    `vendor_base_url` is optional.
   *  - `mode: 'synthetic'` initialises priming state; `kb_opt_in` controls
   *    cross-customer KB contribution (defaults true server-side). */
  updateConnectionSandbox: (
    id: string,
    body: {
      mode: SandboxMode;
      vendor_base_url?: string | null;
      vendor_secrets?: Record<string, unknown>;
      kb_opt_in?: boolean;
    }
  ) =>
    request<Connection>(`/connections/${id}/sandbox`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Sandboxes v1 OpenAPI ingest. Connection must be in `synthetic` mode.
   *  Body accepts either `{spec_json}` (paste) or `{openapi_spec_id}`
   *  (reference a stored spec row). Returns a summary the UI can show. */
  ingestOpenAPIIntoSandbox: (
    id: string,
    body: {
      spec_json?: unknown;
      openapi_spec_id?: string;
      /** Optional `"METHOD /path"` allowlist — when set, only those
       *  operations land in the connection's mock spec. Stashed on
       *  `sandbox_config.endpoint_allowlist` for round-tripping. */
      endpoint_allowlist?: string[];
    }
  ) =>
    request<{
      routes_added: number;
      entities_seeded: number;
      endpoints_seen: number;
      skipped: string[];
    }>(`/connections/${id}/sandbox/ingest-openapi`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Sandboxes v1 AI-synthesised records. Persists `count` records of
   *  `entity_type` into the connection's TestBank. Falls back to a
   *  deterministic generator when Anthropic is unavailable. */
  synthesizeSandboxRecords: (
    id: string,
    body: { entity_type: string; count?: number; variant?: 'full' | 'half' | 'minimal' }
  ) =>
    request<{
      created: number;
      used_fallback: boolean;
      error: string | null;
      examples: Record<string, unknown>[];
    }>(`/connections/${id}/sandbox/synthesize`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Sandboxes v1 bank summary — per-entity-type record counts + schema. */
  getSandboxBank: (id: string) =>
    request<{
      entity_types: Array<{ name: string; count: number; schema_keys: string[] }>;
      total: number;
      schema: Record<string, Record<string, unknown>>;
    }>(`/connections/${id}/sandbox/bank`),
  /** Sandboxes v1 errors tab — corpus + observed audit aggregation. */
  getSandboxErrors: (id: string) =>
    request<{
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
    }>(`/connections/${id}/sandbox/errors`),
  /** Sandboxes v1 active probe — read-only against prod creds. */
  primeSandbox: (id: string) =>
    request<{
      endpoints_probed: number;
      successes: number;
      failures: number;
      sample_count_total: number;
      outcomes: Array<{
        path: string;
        method: string;
        success: boolean;
        sample_count: number;
        fields_observed: number;
        error: string | null;
      }>;
    }>(`/connections/${id}/sandbox/prime`, { method: 'POST' }),

  listConnectionTypes: () => request<ConnectionType[]>('/connection-types'),

  // ── Per-node test runner ──
  testNode: (data: {
    node: Record<string, unknown>;
    input_data?: unknown;
    /** Required for http.request tests that bind a Connection — the test
     *  path uses the integration's environment (sandbox vs production)
     *  to decide whether to route through the mock-engine or hit prod. */
    integration_id?: string;
  }) =>
    request<{
      ok: boolean;
      kind: string;
      duration_ms: number;
      output?: unknown;
      error?: string;
      error_kind?: string | null;
      stdout?: string | null;
    }>('/nodes/test', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  getReplayInput: (runId: string, nodeId: string) =>
    request<{
      run_id: string;
      node_id: string;
      found: boolean;
      input_data?: unknown;
      note?: string | null;
    }>(`/nodes/replay-input?run_id=${encodeURIComponent(runId)}&node_id=${encodeURIComponent(nodeId)}`),
  /** List runs filtered to those where the given node actually executed
   *  (matched by `node_id` inside the run's `steps` JSONB array). Used by
   *  the Test overlay's picker so the user only sees usable replay
   *  candidates. */
  listRunsForNode: (integrationId: string, nodeId: string, limit = 50) =>
    request<
      Array<{
        id: string;
        integration_id: string;
        status: string;
        started_at?: string | null;
        completed_at?: string | null;
        created_at: string;
      }>
    >(
      `/nodes/runs?integration_id=${encodeURIComponent(integrationId)}&node_id=${encodeURIComponent(
        nodeId
      )}&limit=${limit}`
    ),
  /** Fetch the actual output a step produced in a past run. When
   *  `runId` is omitted, returns the most-recent SUCCESSFUL output —
   *  used by the reference picker to drive runtime-aware schema
   *  inference (see `lib/infer-schema.ts`). */
  getNodeOutput: (integrationId: string, nodeId: string, runId?: string) => {
    const qs = new URLSearchParams({
      integration_id: integrationId,
      node_id: nodeId,
    });
    if (runId) qs.set('run_id', runId);
    return request<{
      integration_id: string;
      node_id: string;
      found: boolean;
      run_id?: string | null;
      finished_at?: string | null;
      status?: string | null;
      output?: unknown;
      note?: string | null;
    }>(`/nodes/output?${qs.toString()}`);
  }
};

/** Brandfetch CDN URL for a connector's logo. Falls back to null when the
 * connector has no public brand domain. */
export function brandLogoUrl(brandDomain: string | null | undefined): string | null {
  if (!brandDomain) return null;
  return `https://cdn.brandfetch.io/${brandDomain}`;
}
