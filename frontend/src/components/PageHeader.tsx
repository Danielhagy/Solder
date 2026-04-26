import type { ReactNode } from 'react';

/**
 * Shared page header — eyebrow + title + right-side action slot. Used by
 * Integrations, History, Docs so spacing and alignment can't drift.
 *
 * Sealed at the bottom by a `measure-rule` hairline (with vertical ticks at
 * each end). The rule reads as a CAD dimension line, which sets the
 * blueprint/industrial tone before any content lands underneath.
 */
interface PageHeaderProps {
  eyebrow: string;
  title: string;
  action?: ReactNode;
  /** Small caption under the title (optional). */
  description?: ReactNode;
}

export default function PageHeader({
  eyebrow,
  title,
  action,
  description
}: PageHeaderProps) {
  return (
    <div className="mb-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="eyebrow mb-1">{eyebrow}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-surface-900 dark:text-surface-50">
            {title}
          </h1>
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {description && (
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-3 max-w-xl">
          {description}
        </p>
      )}
      <div className="measure-rule mt-5" aria-hidden="true" />
    </div>
  );
}
