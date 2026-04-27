import { useMemo } from 'react';
import {
  branchCaption,
  containerHeadline,
  defaultContainerLabel,
  loopReduceCaption,
  lookupCatalog,
  resolveBranches
} from '@/catalog';
import {
  useIntegrationStore,
  type FocusSegment,
  type SolderNode
} from '@/stores/integration';

/**
 * Persistent context panel rendered in the sidebar slot whenever the user
 * has stepped into a container. Solves the "I forgot what I'm inside of"
 * problem: once you step into a Loop body or Branch arm, the parent's
 * predicate / iteration source is offscreen, and at one level deeper the
 * outer ancestor is gone too.
 *
 * The panel walks the focus path top-down, rendering one card per ancestor:
 *   - the container's title (auto-derived or user-authored)
 *   - the catalog kind chip
 *   - the headline (predicate / iter source / target name)
 *   - which arm we're inside (TRUE / FALSE / BODY)
 *   - branch caption when relevant ("if $.status == 'approved'", "else")
 *   - loop reduce caption when relevant ("→ collects each output")
 * Clicking an ancestor card returns focus to that depth (jumping out of
 * deeper nests in one move). The deepest entry is the container we're
 * currently inside; it's marked CURRENT and isn't clickable.
 */
export default function NestedContextPanel() {
  const focusPath = useIntegrationStore((s) => s.focusPath);
  const rootNodes = useIntegrationStore((s) => s.nodes);
  const setFocusPath = useIntegrationStore((s) => s.setFocusPath);

  const trail = useMemo(
    () => resolveTrail(rootNodes, focusPath),
    [rootNodes, focusPath]
  );

  if (focusPath.length === 0) return null;

  return (
    <div
      data-testid="nested-context-panel"
      className="px-4 pt-3 pb-3 border-b border-surface-200 dark:border-surface-800 bg-surface-50/40 dark:bg-surface-900/40"
    >
      {/*
       * The eyebrow-only context label. The "back to main" link that
       * used to sit on this row was easy to miss — it's been promoted
       * to a clearer affordance in the topbar (see Builder.tsx). The
       * trail entries below remain click-to-jump-back to any specific
       * level, so this panel still owns the "navigate to a particular
       * ancestor" interaction.
       */}
      <div className="flex items-baseline justify-between mb-2">
        <span className="eyebrow">context</span>
      </div>
      <ol className="space-y-1.5" data-testid="nested-context-trail">
        {trail.map((step, i) => {
          const isCurrent = i === trail.length - 1;
          const meta = lookupCatalog(step.parent.kind, step.parent.action);
          const headline = containerHeadline(step.parent);
          const reduce = loopReduceCaption(step.parent);
          // For a Branch's TRUE arm the caption is "if {expr}" — same string
          // as the parent headline. Suppress to avoid showing it twice.
          const rawCaption = branchCaption(step.parent, step.branchKey);
          const caption = rawCaption && rawCaption !== headline ? rawCaption : null;
          const title =
            step.parent.label?.trim() ||
            defaultContainerLabel(step.parent) ||
            meta.label;
          const Body = (
            <>
              <div className="flex items-center gap-1.5 min-w-0 mb-0.5">
                <span
                  className={`inline-flex items-center justify-center h-4 w-4 rounded text-[10px] leading-none ring-1 ${meta.chip}`}
                  aria-hidden="true"
                >
                  {meta.icon}
                </span>
                <span className="text-sm font-medium truncate text-surface-900 dark:text-surface-50">
                  {title}
                </span>
                <span className="eyebrow shrink-0 ml-auto">{step.branchLabel}</span>
              </div>
              {headline && (
                <div className="font-mono text-[11px] text-surface-500 dark:text-surface-400 truncate">
                  {headline}
                </div>
              )}
              {caption && (
                <div className="font-mono text-[10px] text-surface-500 dark:text-surface-400 truncate">
                  {caption}
                </div>
              )}
              {reduce && (
                <div className="font-mono text-[10px] text-surface-400 dark:text-surface-500 truncate">
                  {reduce}
                </div>
              )}
            </>
          );
          return (
            <li
              key={`${step.parent.id}-${step.branchKey}`}
              data-testid={`nested-context-step-${i}`}
              data-current={isCurrent || undefined}
            >
              {isCurrent ? (
                <div className="rounded-md p-2 bg-primary-50/60 dark:bg-primary-500/10 ring-1 ring-primary-200 dark:ring-primary-500/40">
                  {Body}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setFocusPath(focusPath.slice(0, i + 1))}
                  className="w-full text-left rounded-md p-2 bg-white dark:bg-surface-900/60 ring-1 ring-surface-200 dark:ring-surface-800 hover:ring-primary-300 dark:hover:ring-primary-500/40 transition-colors"
                  title="Return focus to this level"
                >
                  {Body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface TrailEntry {
  parent: SolderNode;
  branchKey: string;
  branchLabel: string;
}

function resolveTrail(rootNodes: SolderNode[], path: FocusSegment[]): TrailEntry[] {
  const trail: TrailEntry[] = [];
  let cur = rootNodes;
  for (const seg of path) {
    const parent = cur.find((n) => n.id === seg.parentId);
    if (!parent || !parent.branches) return trail;
    // resolveBranches handles dynamic Switch cases — for non-switch kinds
    // it falls back to the catalog's static containerBranches. The kind
    // label itself is resolved per-step at render time, not here.
    const branchEntry = resolveBranches(parent)?.find((b) => b.key === seg.branchKey);
    trail.push({
      parent,
      branchKey: seg.branchKey,
      branchLabel: branchEntry?.label ?? seg.branchKey.toUpperCase()
    });
    cur = parent.branches[seg.branchKey] ?? [];
  }
  return trail;
}
