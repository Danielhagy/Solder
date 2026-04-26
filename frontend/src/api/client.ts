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
    )
};
