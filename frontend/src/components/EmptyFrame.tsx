import type { ReactNode } from 'react';

/**
 * Industrial empty-state.
 *
 * Replaces the generic-SaaS "icon + 'no_X.yet' eyebrow + headline + CTA"
 * pattern with a framed measurement card. Four corner brackets surround a
 * small glyph plate; the title/description sit beneath, paced like a label
 * sheet rather than a marketing block.
 *
 * Use for both list-page empty states (no integrations / runs / specs) and
 * detail-pane empty states (nothing selected). For the detail variant, pass
 * `compact` so the card doesn't dominate.
 */
interface EmptyFrameProps {
  /** Mono uppercase status label, e.g. `state · empty`. */
  label: string;
  /** Single decorative glyph rendered inside the framed plate. */
  glyph?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Tighter padding for in-pane empty states. */
  compact?: boolean;
  /** Reach the full available height of the parent — useful in detail panes. */
  fill?: boolean;
}

export default function EmptyFrame({
  label,
  glyph = '◇',
  title,
  description,
  action,
  compact = false,
  fill = false
}: EmptyFrameProps) {
  return (
    <div
      className={`card text-center ${compact ? 'p-10' : 'p-16'} ${
        fill ? 'min-h-[60vh] flex flex-col items-center justify-center' : ''
      }`}
    >
      <div className="frame-corners relative inline-block mb-5">
        <span className="corner corner-tl" aria-hidden="true" />
        <span className="corner corner-tr" aria-hidden="true" />
        <span className="corner corner-bl" aria-hidden="true" />
        <span className="corner corner-br" aria-hidden="true" />
        <div
          className={`inline-flex items-center justify-center rounded-md bg-surface-50 ring-1 ring-surface-200 dark:bg-surface-900 dark:ring-surface-800 ${
            compact ? 'w-10 h-10 text-base' : 'w-12 h-12 text-lg'
          }`}
        >
          <span className="text-surface-400 dark:text-surface-500" aria-hidden="true">
            {glyph}
          </span>
        </div>
      </div>
      <p className="eyebrow mb-1">{label}</p>
      <h2
        className={`font-semibold text-surface-900 dark:text-surface-50 ${
          compact ? 'text-base mb-1' : 'text-lg mb-2'
        }`}
      >
        {title}
      </h2>
      {description && (
        <p className="text-sm text-surface-500 max-w-sm mx-auto dark:text-surface-400">
          {description}
        </p>
      )}
      {action && <div className="mt-6 inline-flex items-center justify-center">{action}</div>}
    </div>
  );
}
