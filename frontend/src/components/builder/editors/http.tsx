import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

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

export default function HttpEditor({ node, set }: EditorProps) {
  const pagination = (node.config.pagination as PaginationCfg | undefined) ?? { mode: 'none' };
  const mode = pagination.mode ?? 'none';
  const patch = (partial: Partial<PaginationCfg>) =>
    set('pagination', { ...pagination, ...partial });

  return (
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
        <ReferenceField
          nodeId={node.id}
          value={(node.config.url as string) || ''}
          onChange={(next) => set('url', next)}
          placeholder="https://api.example.com/endpoint"
          singleLine
          ariaLabel="HTTP URL"
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
                <ReferenceField
                  nodeId={node.id}
                  value={pagination.cursor_path ?? '$.next_cursor'}
                  onChange={(next) => patch({ cursor_path: next })}
                  placeholder="$.next_cursor"
                  singleLine
                  ariaLabel="Cursor path"
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
                <ReferenceField
                  nodeId={node.id}
                  value={pagination.items_path ?? '$'}
                  onChange={(next) => patch({ items_path: next })}
                  placeholder="$.data"
                  singleLine
                  ariaLabel="Items path"
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
    </>
  );
}
