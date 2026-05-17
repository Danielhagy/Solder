/*
 * SettingsTab — request-level knobs (timeout, redirects, TLS, sandbox
 * override) PLUS the pagination block that used to live at the top of
 * the editor as a permanently-visible `<details>` panel.
 */
import Select from '@/components/Select';
import ReferenceField from '../../ReferenceField';
import type {
  HttpMethod,
  HttpPagination,
  HttpSandboxOverride,
  HttpSettings,
} from '../http.types';

const SANDBOX_OPTIONS = [
  { value: 'auto', label: 'Auto', caption: 'follow integration env' },
  { value: 'force-mock', label: 'Force mock', caption: 'use synthetic sandbox' },
  { value: 'force-real', label: 'Force real', caption: 'hit live API' },
];

const PAGINATION_MODE_OPTIONS = [
  { value: 'none', label: 'None', caption: 'single request' },
  { value: 'page', label: 'Page', caption: 'numeric ?page=N' },
  { value: 'cursor', label: 'Cursor', caption: 'token from body' },
  { value: 'link-header', label: 'Link header', caption: 'RFC 5988' },
];

interface Props {
  nodeId: string;
  method: HttpMethod;
  settings: HttpSettings;
  pagination: HttpPagination;
  onSettings: (next: HttpSettings) => void;
  onPagination: (next: HttpPagination) => void;
}

export default function SettingsTab({
  nodeId,
  method,
  settings,
  pagination,
  onSettings,
  onPagination,
}: Props) {
  function patchSettings(partial: Partial<HttpSettings>) {
    onSettings({ ...settings, ...partial });
  }
  function patchPagination(partial: Partial<HttpPagination>) {
    onPagination({ ...pagination, ...partial });
  }

  const paginationApplies = method === 'GET';

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400">
          Request
        </h3>
        <Row label="Timeout (seconds)">
          <input
            type="number"
            min={1}
            max={600}
            value={settings.timeoutSeconds}
            onChange={(e) =>
              patchSettings({
                timeoutSeconds: Math.max(1, Math.min(600, Number(e.currentTarget.value) || 30)),
              })
            }
            className="input w-24 font-mono text-xs py-1"
            data-testid="http-settings-timeout"
          />
        </Row>
        <Toggle
          checked={settings.followRedirects}
          onChange={(followRedirects) => patchSettings({ followRedirects })}
          label="Follow redirects (3xx)"
          testid="http-settings-follow-redirects"
        />
        <Toggle
          checked={settings.rejectUnauthorized}
          onChange={(rejectUnauthorized) => patchSettings({ rejectUnauthorized })}
          label="Verify TLS certificates"
          testid="http-settings-verify-tls"
        />
        <Row label="Sandbox routing">
          <Select
            value={settings.sandboxOverride}
            onChange={(v) =>
              patchSettings({ sandboxOverride: v as HttpSandboxOverride })
            }
            options={SANDBOX_OPTIONS}
            size="sm"
            ariaLabel="Sandbox override"
            testid="http-settings-sandbox"
            width="220px"
          />
        </Row>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400">
          Pagination
        </h3>
        {!paginationApplies ? (
          <p className="text-[11px] text-surface-500 dark:text-surface-400 italic">
            Pagination applies to GET requests only. The current method is{' '}
            <span className="font-mono">{method}</span>.
          </p>
        ) : (
          <>
            <Row label="Mode">
              <Select
                value={pagination.mode}
                onChange={(v) =>
                  patchPagination({ mode: v as HttpPagination['mode'] })
                }
                options={PAGINATION_MODE_OPTIONS}
                size="sm"
                ariaLabel="Pagination mode"
                testid="http-pagination-mode"
                width="220px"
              />
            </Row>
            {pagination.mode === 'page' && (
              <>
                <Row label="Page param">
                  <input
                    type="text"
                    value={pagination.page_param ?? 'page'}
                    onChange={(e) => patchPagination({ page_param: e.currentTarget.value })}
                    className="input w-40 font-mono text-xs py-1"
                  />
                </Row>
                <Row label="Start at">
                  <input
                    type="number"
                    value={pagination.page_start ?? 1}
                    onChange={(e) => patchPagination({ page_start: Number(e.currentTarget.value) || 0 })}
                    className="input w-20 font-mono text-xs py-1"
                  />
                </Row>
                <Row label="Page-size param">
                  <input
                    type="text"
                    value={pagination.page_size_param ?? ''}
                    onChange={(e) => patchPagination({ page_size_param: e.currentTarget.value })}
                    placeholder="per_page"
                    className="input w-40 font-mono text-xs py-1"
                  />
                </Row>
                <Row label="Page size">
                  <input
                    type="number"
                    value={pagination.page_size ?? 0}
                    onChange={(e) => patchPagination({ page_size: Number(e.currentTarget.value) || 0 })}
                    className="input w-20 font-mono text-xs py-1"
                  />
                </Row>
              </>
            )}
            {pagination.mode === 'cursor' && (
              <>
                <Row label="Cursor path">
                  <div className="flex-1 min-w-0">
                    <ReferenceField
                      nodeId={nodeId}
                      value={pagination.cursor_path ?? '$.next_cursor'}
                      onChange={(cursor_path) => patchPagination({ cursor_path })}
                      placeholder="$.next_cursor"
                      singleLine
                      ariaLabel="Cursor path"
                    />
                  </div>
                </Row>
                <Row label="Cursor query param">
                  <input
                    type="text"
                    value={pagination.cursor_param ?? 'cursor'}
                    onChange={(e) => patchPagination({ cursor_param: e.currentTarget.value })}
                    className="input w-40 font-mono text-xs py-1"
                  />
                </Row>
              </>
            )}
            {pagination.mode !== 'none' && (
              <>
                <Row label="Items path">
                  <div className="flex-1 min-w-0">
                    <ReferenceField
                      nodeId={nodeId}
                      value={pagination.items_path ?? '$'}
                      onChange={(items_path) => patchPagination({ items_path })}
                      placeholder="$.data"
                      singleLine
                      ariaLabel="Items path"
                    />
                  </div>
                </Row>
                <Row label="Max pages">
                  <input
                    type="number"
                    value={pagination.max_pages ?? 100}
                    onChange={(e) => patchPagination({ max_pages: Number(e.currentTarget.value) || 1 })}
                    className="input w-20 font-mono text-xs py-1"
                  />
                </Row>
                <Toggle
                  checked={pagination.stop_on_empty ?? true}
                  onChange={(stop_on_empty) => patchPagination({ stop_on_empty })}
                  label="Stop on empty page"
                  testid="http-pagination-stop-empty"
                />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400 w-36 flex-shrink-0">
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  testid,
}: {
  checked: boolean;
  onChange: (b: boolean) => void;
  label: string;
  testid?: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        data-testid={testid}
        className="accent-forge-500"
      />
      <span className="text-xs text-surface-700 dark:text-surface-200">{label}</span>
    </label>
  );
}
