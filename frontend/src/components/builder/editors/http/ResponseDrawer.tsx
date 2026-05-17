/*
 * ResponseDrawer — collapsible response panel that sits under the tab body
 * once a test has been run. Three sub-tabs: Body / Headers / cURL.
 * Status pill uses emerald (2xx) / forge (3xx) / rose (4xx,5xx) / surface
 * (transport-fail). The cURL sub-tab shows a one-liner the user can copy
 * into a terminal to reproduce the exact request the test fired.
 */
import { useMemo, useState } from 'react';
import { copyAsCurl } from './copyAsCurl';
import type { HttpTestState } from './useHttpTestRunner';

type SubTab = 'body' | 'headers' | 'curl';

interface Props {
  state: HttpTestState;
  /** Echo of what the test was asked to do — used to render the cURL line
   *  even before we have the server's resolved-URL echo. */
  method: string;
}

export default function ResponseDrawer({ state, method }: Props) {
  const [tab, setTab] = useState<SubTab>('body');
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  // All hooks above the early-return — React's rules of hooks demand the
  // same hook call count on every render. The drawer is idle on first
  // mount and becomes populated after Test fires; bailing before useMemo
  // would change the hook count and crash the editor.
  const status = state.result?.status_code ?? 0;
  const pill = pillFor(state, status);
  const url = state.result?.request_url ?? '';
  const curl = useMemo(() => {
    if (!state.result) return '';
    // Use the REQUEST headers Solder put on the wire (backend echoes them
    // back with secrets masked). Falling back to response headers would
    // produce a nonsensical "curl me back what the server sent" line.
    return copyAsCurl({
      method,
      url,
      headers: state.result.request_headers ?? [],
      body: undefined, // Test endpoint doesn't echo back the request body yet.
    });
  }, [state.result, method, url]);

  if (state.status === 'idle') return null;

  function copyToClipboard(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  return (
    <section
      data-testid="http-response-drawer"
      className="rounded-md border overflow-hidden"
      style={{ borderColor: 'var(--rule)', background: 'var(--container-glaze)' }}
    >
      <header
        className="flex items-center gap-3 px-3 py-2 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden="true"
          className={`transition-transform inline-block ${open ? 'rotate-90' : ''}`}
        >
          ▸
        </span>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ color: pill.color }}
        >
          {pill.label}
        </span>
        {state.status === 'running' ? (
          <span className="font-mono text-[10px] text-surface-500 dark:text-surface-400">
            running…
          </span>
        ) : (
          <>
            {state.status === 'done' && (
              <span className="font-mono text-[10px] text-surface-500 dark:text-surface-400">
                {state.durationMs}ms
              </span>
            )}
            {state.status === 'error' && state.error && (
              <span className="font-mono text-[10px] text-rose-500 dark:text-rose-400 truncate">
                {state.error}
              </span>
            )}
          </>
        )}
      </header>

      {open && state.result && (
        <div className="border-t" style={{ borderColor: 'var(--rule)' }}>
          <div className="flex border-b" style={{ borderColor: 'var(--rule)' }}>
            <SubTabBtn tab="body" active={tab} onClick={setTab} label="Body" />
            <SubTabBtn tab="headers" active={tab} onClick={setTab} label="Headers" />
            <SubTabBtn tab="curl" active={tab} onClick={setTab} label="cURL" />
            <div className="ml-auto flex items-center pr-2">
              <button
                type="button"
                onClick={() => {
                  if (tab === 'body') {
                    copyToClipboard(
                      typeof state.result?.body === 'string'
                        ? state.result.body
                        : JSON.stringify(state.result?.body, null, 2),
                    );
                  } else if (tab === 'headers') {
                    copyToClipboard(
                      Object.entries(state.result?.headers ?? {})
                        .map(([k, v]) => `${k}: ${v}`)
                        .join('\n'),
                    );
                  } else {
                    copyToClipboard(curl);
                  }
                }}
                className="font-mono text-[10px] uppercase tracking-[0.08em] text-surface-500 dark:text-surface-400 hover:text-forge-500 px-2 py-1"
                data-testid="http-response-copy"
              >
                {copied ? '✓ copied' : 'copy'}
              </button>
            </div>
          </div>

          <div className="p-3 max-h-72 overflow-auto solder-scroll-thin">
            {tab === 'body' && (
              <pre
                className="font-mono text-[11px] whitespace-pre-wrap break-words text-surface-900 dark:text-surface-50"
                data-testid="http-response-body"
              >
                {typeof state.result.body === 'string'
                  ? state.result.body
                  : JSON.stringify(state.result.body, null, 2)}
              </pre>
            )}
            {tab === 'headers' && (
              <div className="flex flex-col gap-0.5">
                {Object.entries(state.result.headers).map(([k, v]) => (
                  <div
                    key={k}
                    className="grid gap-3 font-mono text-[11px] text-surface-700 dark:text-surface-200"
                    style={{ gridTemplateColumns: 'auto 1fr' }}
                  >
                    <span className="text-surface-500 dark:text-surface-400">
                      {k}:
                    </span>
                    <span className="break-words">{v}</span>
                  </div>
                ))}
              </div>
            )}
            {tab === 'curl' && (
              <pre
                className="font-mono text-[11px] whitespace-pre-wrap break-all text-surface-900 dark:text-surface-50"
                data-testid="http-response-curl"
              >
                {curl}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SubTabBtn({
  tab,
  active,
  onClick,
  label,
}: {
  tab: SubTab;
  active: SubTab;
  onClick: (t: SubTab) => void;
  label: string;
}) {
  const isActive = tab === active;
  return (
    <button
      type="button"
      onClick={() => onClick(tab)}
      className={[
        'px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] border-b-2 -mb-px',
        isActive
          ? 'border-forge-500 text-forge-500 dark:text-forge-400'
          : 'border-transparent text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200',
      ].join(' ')}
      data-testid={`http-response-tab-${tab}`}
    >
      {label}
    </button>
  );
}

function pillFor(state: HttpTestState, status: number): { label: string; color: string } {
  if (state.status === 'running') return { label: 'running', color: 'var(--surface-500)' };
  if (state.status === 'error') return { label: 'failed', color: 'var(--rose-500)' };
  if (status === 0) return { label: 'transport error', color: 'var(--surface-500)' };
  const cls =
    status >= 500
      ? 'var(--rose-500)'
      : status >= 400
        ? 'var(--rose-500)'
        : status >= 300
          ? 'var(--forge-400)'
          : 'var(--emerald-400)';
  return { label: `response · ${status}`, color: cls };
}
