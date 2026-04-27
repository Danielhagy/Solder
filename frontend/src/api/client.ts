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

export interface Connection {
  id: string;
  connector_id: string | null;
  label: string;
  auth_scheme: string;
  base_url: string | null;
  config_json: Record<string, unknown>;
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

  listConnectionTypes: () => request<ConnectionType[]>('/connection-types'),

  // ── Per-node test runner ──
  testNode: (data: { node: Record<string, unknown>; input_data?: unknown }) =>
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
