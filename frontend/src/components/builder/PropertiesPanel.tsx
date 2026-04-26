import { useEffect, useState } from 'react';
import { useIntegrationStore, selectedNode as selectSelected, groupByStage, type SolderNode } from '@/stores/integration';
import { lookupCatalog } from '@/catalog';
import { api, type Integration } from '@/api/client';

function ProcessCallEditor({ node, set }: { node: SolderNode; set: (k: string, v: unknown) => void }) {
  const [subprocesses, setSubprocesses] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const targetId = (node.config.target_id as string) || '';
  const mode = (node.config.mode as string) || 'once';
  const over = (node.config.over as string) || '$.items';

  useEffect(() => {
    let alive = true;
    api
      .listSubprocesses()
      .then((list) => {
        if (alive) setSubprocesses(list);
      })
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Subprocess
        </span>
        <select
          className="input w-full"
          value={targetId}
          onChange={(e) => {
            const id = e.currentTarget.value;
            const picked = subprocesses.find((s) => s.id === id);
            set('target_id', id);
            set('target_name', picked?.name ?? '');
          }}
          disabled={loading}
          data-testid="process-call-target"
        >
          <option value="">{loading ? 'Loading…' : 'Pick a subprocess'}</option>
          {subprocesses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {!loading && subprocesses.length === 0 && (
          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
            No subprocesses yet. Save an integration with the "Library" toggle on to reuse it here.
          </p>
        )}
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Mode</span>
        <select
          className="input w-full"
          value={mode}
          onChange={(e) => set('mode', e.currentTarget.value)}
        >
          <option value="once">Run once</option>
          <option value="for-each">Run for each item</option>
        </select>
      </label>
      {mode === 'for-each' && (
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Iterate over
          </span>
          <input
            type="text"
            className="input w-full font-mono text-sm"
            value={over}
            placeholder="$.items"
            onChange={(e) => set('over', e.currentTarget.value)}
          />
          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
            JSONPath to an array. Each item is passed as input to the subprocess.
          </p>
        </label>
      )}
    </div>
  );
}

export default function PropertiesPanel() {
  const node = useIntegrationStore(selectSelected);
  const nodes = useIntegrationStore((s) => s.nodes);
  const updateNode = useIntegrationStore((s) => s.updateNode);
  const updateNodeConfig = useIntegrationStore((s) => s.updateNodeConfig);
  const removeNode = useIntegrationStore((s) => s.removeNode);

  if (!node) {
    const stages = groupByStage(nodes);
    return (
      <aside className="w-80 bg-white border-l border-surface-200 shadow-[inset_1px_0_0_0_rgb(244_244_245)] flex flex-col dark:bg-surface-950 dark:border-surface-800">
        {nodes.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div className="max-w-[240px]">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-surface-50 ring-1 ring-surface-200 mb-3 dark:bg-surface-800 dark:ring-surface-700">
                <span className="text-surface-400 text-sm dark:text-surface-500">◎</span>
              </div>
              <p className="eyebrow mb-1">no_selection</p>
              <p className="text-sm text-surface-600 dark:text-surface-300">Select a node to edit its properties</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 pt-3 pb-3 bg-surface-50/50 border-b border-surface-200 dark:bg-surface-900/50 dark:border-surface-800">
              <div className="flex items-baseline justify-between">
                <h3 className="font-semibold text-sm text-surface-900 dark:text-surface-50">Run Plan</h3>
                <span className="text-[10px] font-mono text-surface-400 dark:text-surface-500 tabular-nums">
                  {stages.length} {stages.length === 1 ? 'stage' : 'stages'}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {stages.map((group) => (
                <div
                  key={group.stage}
                  className="rounded-lg border border-surface-200 bg-surface-50/50 p-2.5 dark:border-surface-800 dark:bg-surface-900/50"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
                      {String(group.stage).padStart(2, '0')}
                    </span>
                    {group.nodes.length > 1 && (
                      <span className="eyebrow">{group.nodes.length} parallel</span>
                    )}
                  </div>
                  <div className="space-y-1">
                    {group.nodes.map((n) => {
                      const meta = lookupCatalog(n.kind, n.action);
                      return (
                        <div key={n.id} className="flex items-center gap-2 text-sm">
                          <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] ring-1 ${meta.chip}`}>
                            {meta.icon}
                          </span>
                          <span className="truncate text-surface-800 dark:text-surface-200">{meta.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    );
  }

  const set = (key: string, value: unknown) => updateNodeConfig(node.id, { [key]: value });
  const key = `${node.kind}.${node.action}`;
  const meta = lookupCatalog(node.kind, node.action);
  // Shortform identifier — first segment of the uuid is enough to disambiguate
  // and reads cleanly in the mono caption row.
  const shortId = node.id.length > 8 ? node.id.slice(0, 8) : node.id;

  return (
    <aside className="w-80 bg-white border-l border-surface-200 shadow-[inset_1px_0_0_0_rgb(244_244_245)] flex flex-col dark:bg-surface-950 dark:border-surface-800">
      {/* Header — mirrors RunDrawer's chrome so the right-rail keeps a
          consistent shape whether the user is editing a node or watching a run. */}
      <div className="px-4 pt-3 pb-3 bg-surface-50/50 border-b border-surface-200 dark:bg-surface-900/50 dark:border-surface-800">
        <p className="eyebrow mb-0.5">
          stage {String(node.stage).padStart(2, '0')} · {node.kind}
        </p>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center justify-center h-6 w-6 rounded-md text-xs leading-none ring-1 ${meta.chip}`}
            aria-hidden="true"
          >
            {meta.icon}
          </span>
          <h3 className="font-semibold text-sm dark:text-surface-50 truncate">
            {meta.label}
          </h3>
          <span className="ml-auto text-[10px] font-mono text-surface-400 dark:text-surface-500 tabular-nums">
            {shortId}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {key === 'http.request' ? (
          <>
            <label className="block">
              <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Method</span>
              <select
                className="input w-full"
                value={(node.config.method as string) || 'GET'}
                onChange={(e) => set('method', e.currentTarget.value)}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">URL</span>
              <input
                type="text"
                className="input w-full"
                value={(node.config.url as string) || ''}
                placeholder="https://api.example.com/endpoint"
                onChange={(e) => set('url', e.currentTarget.value)}
              />
            </label>
            <label className="block">
              <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Body (JSON)</span>
              <textarea
                className="input w-full h-24 font-mono text-sm"
                defaultValue={
                  node.config.body ? JSON.stringify(node.config.body, null, 2) : ''
                }
                placeholder={'{"key": "value"}'}
                onBlur={(e) => {
                  const text = e.currentTarget.value.trim();
                  if (!text) {
                    set('body', null);
                    return;
                  }
                  try {
                    set('body', JSON.parse(text));
                  } catch {
                    /* keep previous value until valid JSON */
                  }
                }}
              />
            </label>
            {(() => {
              type PaginationCfg = {
                mode?: 'none' | 'page' | 'cursor' | 'link-header';
                page_param?: string;
                page_start?: number;
                page_size_param?: string;
                page_size?: number;
                cursor_path?: string;
                cursor_param?: string;
                items_path?: string;
                max_pages?: number;
                stop_on_empty?: boolean;
              };
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
                      <select
                        className="input w-full"
                        value={mode}
                        onChange={(e) => patch({ mode: e.currentTarget.value as PaginationCfg['mode'] })}
                      >
                        <option value="none">None</option>
                        <option value="page">Page number</option>
                        <option value="cursor">Cursor (body token)</option>
                        <option value="link-header">Link header (RFC 5988)</option>
                      </select>
                    </label>
                    {mode === 'page' && (
                      <>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Page param</span>
                          <input
                            type="text"
                            className="input w-full font-mono text-sm"
                            value={pagination.page_param ?? 'page'}
                            placeholder="page"
                            onChange={(e) => patch({ page_param: e.currentTarget.value })}
                          />
                        </label>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Start at</span>
                          <input
                            type="number"
                            className="input w-full font-mono text-sm"
                            value={pagination.page_start ?? 1}
                            onChange={(e) => patch({ page_start: Number(e.currentTarget.value) || 0 })}
                          />
                        </label>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
                            Page-size param
                            <span className="ml-2 text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500">
                              optional
                            </span>
                          </span>
                          <input
                            type="text"
                            className="input w-full font-mono text-sm"
                            value={pagination.page_size_param ?? ''}
                            placeholder="per_page"
                            onChange={(e) => patch({ page_size_param: e.currentTarget.value })}
                          />
                        </label>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
                            Page size
                            <span className="ml-2 text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500">
                              optional
                            </span>
                          </span>
                          <input
                            type="number"
                            className="input w-full font-mono text-sm"
                            value={pagination.page_size ?? 0}
                            onChange={(e) => patch({ page_size: Number(e.currentTarget.value) || 0 })}
                          />
                          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
                            Used to detect a short last page; leave at 0 to skip.
                          </p>
                        </label>
                      </>
                    )}
                    {mode === 'cursor' && (
                      <>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Cursor path</span>
                          <input
                            type="text"
                            className="input w-full font-mono text-sm"
                            value={pagination.cursor_path ?? '$.next_cursor'}
                            placeholder="$.next_cursor"
                            onChange={(e) => patch({ cursor_path: e.currentTarget.value })}
                          />
                          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
                            JSONPath to the cursor in each response body.
                          </p>
                        </label>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Cursor query param</span>
                          <input
                            type="text"
                            className="input w-full font-mono text-sm"
                            value={pagination.cursor_param ?? 'cursor'}
                            placeholder="cursor"
                            onChange={(e) => patch({ cursor_param: e.currentTarget.value })}
                          />
                        </label>
                      </>
                    )}
                    {mode === 'link-header' && (
                      <p className="text-xs text-surface-500 dark:text-surface-400">
                        Follows the <span className="font-mono">Link</span> header&apos;s <span className="font-mono">rel=&quot;next&quot;</span> URL
                        automatically.
                      </p>
                    )}
                    {mode !== 'none' && (
                      <>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Items path</span>
                          <input
                            type="text"
                            className="input w-full font-mono text-sm"
                            value={pagination.items_path ?? '$'}
                            placeholder="$.data"
                            onChange={(e) => patch({ items_path: e.currentTarget.value })}
                          />
                          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
                            Where the array lives in each response. <span className="font-mono">$</span> = whole body.
                          </p>
                        </label>
                        <label className="block">
                          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Max pages</span>
                          <input
                            type="number"
                            className="input w-full font-mono text-sm"
                            value={pagination.max_pages ?? 100}
                            onChange={(e) => patch({ max_pages: Number(e.currentTarget.value) || 1 })}
                          />
                        </label>
                        <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
                          <input
                            type="checkbox"
                            checked={pagination.stop_on_empty ?? true}
                            onChange={(e) => patch({ stop_on_empty: e.currentTarget.checked })}
                          />
                          Stop on empty page
                        </label>
                      </>
                    )}
                  </div>
                </details>
              );
            })()}
          </>
        ) : key === 'transform.map' ? (
          <label className="block">
            <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Expression</span>
            <textarea
              className="input w-full h-32 font-mono text-sm"
              value={(node.config.expression as string) || ''}
              placeholder="$.data.items"
              onChange={(e) => set('expression', e.currentTarget.value)}
            />
            <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
              JSONPath (e.g. $.data.items) or template syntax
            </p>
          </label>
        ) : key === 'logic.if' ? (
          <label className="block">
            <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Condition</span>
            <textarea
              className="input w-full h-24 font-mono text-sm"
              value={(node.config.expression as string) || ''}
              placeholder='$.status == "success"'
              onChange={(e) => set('expression', e.currentTarget.value)}
            />
            <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
              Supports ==, !=, &gt;, &lt;, &gt;=, &lt;=, in, not in
            </p>
          </label>
        ) : key === 'output.passthrough' ? (
          <label className="block">
            <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Output Mapping</span>
            <textarea
              className="input w-full h-32 font-mono text-sm"
              defaultValue={JSON.stringify(node.config.mapping ?? {}, null, 2)}
              placeholder={'{"result": "$.data"}'}
              onBlur={(e) => {
                try {
                  set('mapping', JSON.parse(e.currentTarget.value));
                } catch {
                  /* ignore invalid JSON */
                }
              }}
            />
          </label>
        ) : key === 'process.call' ? (
          <ProcessCallEditor node={node} set={set} />
        ) : (
          <p className="text-sm text-surface-500 dark:text-surface-400">No editor for {key}.</p>
        )}

        <div className="pt-4 border-t border-surface-200 dark:border-surface-800">
          <label className="block">
            <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
              When
              <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500">optional</span>
            </span>
            <input
              type="text"
              className="input w-full font-mono text-sm"
              value={(node.when as string) || ''}
              placeholder='$.status == "success"'
              onChange={(e) => updateNode(node.id, { when: e.currentTarget.value || undefined })}
            />
            <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
              If set, this node only runs when the expression is truthy. JSONPath (e.g.{' '}
              <span className="font-mono">$.field</span>) with ==, !=, &gt;, &lt;, &gt;=, &lt;=, in, not in.
            </p>
          </label>
        </div>
      </div>

      <div className="p-4 border-t border-surface-200 dark:border-surface-800">
        <button
          type="button"
          className="btn btn-ghost text-red-600 w-full dark:text-red-400"
          onClick={() => removeNode(node.id)}
        >
          Delete Node
        </button>
      </div>
    </aside>
  );
}
