/**
 * Shimmer skeleton blocks used by list pages while data is loading.
 * Shaped to roughly match the final row layouts so there's no layout shift
 * when the real content lands.
 */

interface SkeletonProps {
  className?: string;
}

function Bar({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded bg-surface-200/70 dark:bg-surface-800/70 ${className}`}
    />
  );
}

/** Card matching the Integrations list row shape. */
export function IntegrationRowSkeleton() {
  return (
    <div className="card p-4 flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <Bar className="h-5 w-40" />
          <Bar className="h-4 w-14" />
          <Bar className="h-4 w-16" />
        </div>
        <Bar className="h-3 w-2/3" />
        <Bar className="h-3 w-32" />
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Bar className="h-7 w-14" />
        <Bar className="h-7 w-14" />
      </div>
    </div>
  );
}

/** Card matching the run list row shape. */
export function RunRowSkeleton() {
  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <Bar className="h-4 w-32" />
        <Bar className="h-4 w-16" />
      </div>
      <div className="flex items-center justify-between">
        <Bar className="h-3 w-16" />
        <Bar className="h-3 w-28" />
      </div>
    </div>
  );
}

/** Card matching the Docs spec list row shape. */
export function SpecRowSkeleton() {
  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <Bar className="h-4 w-36" />
        <Bar className="h-4 w-4" />
      </div>
      <Bar className="h-3 w-10" />
    </div>
  );
}
