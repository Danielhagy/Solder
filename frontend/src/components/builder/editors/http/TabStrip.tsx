/*
 * TabStrip — Params / Headers / Body / Auth / Settings tabs for the HTTP
 * editor. Mirrors the SANDBOX_TABS styling in Sandboxes.tsx: forge-tinted
 * underline for active, count badge to surface non-empty state, dim +
 * aria-disabled for method-incompatible tabs (e.g. Body on GET).
 */
import type { HttpMethod } from './http.types';

export type HttpTabId = 'params' | 'headers' | 'body' | 'auth' | 'settings';

export interface HttpTabState {
  id: HttpTabId;
  label: string;
  /** Numeric count to show as badge (e.g. number of enabled params). 0 hidden. */
  count?: number;
  /** True = render a forge dot on the tab (used by Body when content is
   *  stashed under a method that hides it). */
  hasStashed?: boolean;
  /** True = disabled for this method; tab is greyed + aria-disabled. */
  disabled?: boolean;
  /** Tooltip explaining a disabled state. */
  disabledReason?: string;
}

interface Props {
  tabs: HttpTabState[];
  active: HttpTabId;
  onSelect: (id: HttpTabId) => void;
}

export default function TabStrip({ tabs, active, onSelect }: Props) {
  return (
    <div
      className="flex gap-0.5 border-b"
      style={{ borderColor: 'var(--rule)' }}
      role="tablist"
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={t.disabled || undefined}
            disabled={t.disabled}
            title={t.disabled ? t.disabledReason : undefined}
            onClick={() => !t.disabled && onSelect(t.id)}
            data-testid={`http-tab-${t.id}`}
            className={[
              'px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.08em] inline-flex items-center gap-1.5',
              'border-b-2 transition-colors -mb-px',
              isActive
                ? 'border-forge-500 text-forge-500 dark:text-forge-400'
                : t.disabled
                  ? 'border-transparent text-surface-300 dark:text-surface-700 cursor-not-allowed'
                  : 'border-transparent text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200',
            ].join(' ')}
          >
            <span>{t.label}</span>
            {!t.disabled && t.count !== undefined && t.count > 0 && (
              <span className="text-surface-400 dark:text-surface-500 normal-case tracking-normal text-[10px]">
                ({t.count})
              </span>
            )}
            {t.disabled && t.hasStashed && (
              <span
                aria-hidden="true"
                className="inline-block w-1.5 h-1.5 rounded-full bg-forge-500"
                title="Has saved content from a previous method"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Compute per-method enable / disable state for the tab strip. */
export function methodTabsFor(
  method: HttpMethod,
  counts: { params: number; headers: number; bodyEmpty: boolean; hasStashedBody: boolean },
): HttpTabState[] {
  const bodyHidden =
    method === 'GET' || method === 'HEAD' || method === 'DELETE';
  return [
    {
      id: 'params',
      label: 'Params',
      count: counts.params,
    },
    {
      id: 'headers',
      label: 'Headers',
      count: counts.headers,
    },
    {
      id: 'body',
      label: 'Body',
      disabled: bodyHidden,
      disabledReason:
        method === 'GET'
          ? 'GET requests don\'t send a body. Switch method to POST/PUT/PATCH to enable.'
          : method === 'HEAD'
            ? 'HEAD requests must not have a body.'
            : 'DELETE requests typically don\'t have a body. Use the Raw mode if your vendor requires it.',
      hasStashed: counts.hasStashedBody,
    },
    { id: 'auth', label: 'Auth' },
    { id: 'settings', label: 'Settings' },
  ];
}
