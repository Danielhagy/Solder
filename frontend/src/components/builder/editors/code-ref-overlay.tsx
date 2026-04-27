import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useIntegrationStore,
  getReferenceableScope,
  type ReferenceableStep,
} from '@/stores/integration';
import { CATALOG, FALLBACK_REFERENCEABLE_OUTPUTS } from '@/catalog';
import { useStepSchema } from '@/lib/use-step-schema';
import type { InferredField } from '@/lib/infer-schema';

/**
 * RefOverlay — purpose-built reference picker for the Python source
 * editor. Lists every upstream step in scope, each expanded to its
 * real-run-inferred fields (the same `useStepSchema` hook the data-
 * shape disclosure uses). Picking a leaf inserts the canonical
 * `{{$.steps.<id>.output.<path>}}` token at the editor's cursor.
 *
 * Visual direction matches Solder's editorial / drafting vocabulary:
 *   - eyebrow + display-face title, measure-rule under the header
 *   - dotted dividers between rows (same rhythm as Select.tsx)
 *   - kind+action chip on each step row, mirroring NodeCard
 *   - tabular type-chip on Stage 2 right-edge so the column lines up
 *   - whole-output card in Stage 2 wears the forge tint as a leading
 *     option, with a 2px forge rail to mark it as the prominent pick
 *
 * Why a parallel picker instead of `RefPicker`: RefPicker is in flight
 * from a separate refactor and is shaped for textareas with the picker
 * grammar baked in. The Python editor is CodeMirror 6 — different
 * insertion mechanics, different keymap. Building a small dedicated
 * picker that consumes our existing scope + schema hooks keeps both
 * concerns clean while we wait for RefPicker to settle.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** The Python node's id. Used to walk `getReferenceableScope` so the
   *  picker only surfaces upstream steps (no self-reference, no
   *  later-stage siblings). */
  nodeId: string;
  /** Integration id — drives `useStepSchema`'s real-run fetch. Null on
   *  unsaved drafts; the picker still works against catalog fallback. */
  integrationId: string | null;
  /** Callback that inserts a token at the editor's current cursor. The
   *  caller owns the EditorView ref. */
  onInsert: (token: string) => void;
}

export default function RefOverlay({
  open,
  onClose,
  nodeId,
  integrationId,
  onInsert,
}: Props) {
  const [pickedStepId, setPickedStepId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const scope = useIntegrationStore((s) => getReferenceableScope(s, nodeId));

  useEffect(() => {
    if (!open) return;
    setPickedStepId(null);
    setQuery('');
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (pickedStepId) setPickedStepId(null);
        else onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // pickedStepId intentionally not a dep — Escape behavior reads the
    // current value via closure, no need to re-bind on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  if (!open) return null;

  const steps = scope?.steps ?? [];
  const variables = scope?.variables ?? [];
  const lower = query.trim().toLowerCase();

  const visibleSteps = lower
    ? steps.filter((s) => `${s.label} ${s.kind}.${s.action}`.toLowerCase().includes(lower))
    : steps;
  const visibleVars = lower
    ? variables.filter((v) => v.name.toLowerCase().includes(lower))
    : variables;

  const pickedStep = pickedStepId ? steps.find((s) => s.id === pickedStepId) ?? null : null;

  function insertAndClose(token: string) {
    onInsert(token);
    onClose();
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="ref-overlay-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        className="fixed inset-0 z-50 grid place-items-center bg-surface-950/40 backdrop-blur-sm p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="code-ref-overlay"
      >
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16, ease: [0.2, 0.7, 0.3, 1] }}
          className="glass-rail rounded-xl w-full max-w-xl px-5 pt-4 pb-4 max-h-[80vh] overflow-y-auto solder-scroll-thin"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header — eyebrow tracks which stage we're in so the user
              knows whether ← back will land them somewhere useful. */}
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow">
                {pickedStep ? `ref · stage 2 · pick field` : 'ref · stage 1 · pick source'}
              </p>
              <h3 className="font-display text-lg text-surface-900 dark:text-surface-50 truncate leading-tight">
                {pickedStep ? pickedStep.label : 'Insert reference'}
              </h3>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {pickedStep && (
                <button
                  type="button"
                  onClick={() => setPickedStepId(null)}
                  className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-500 hover:text-forge-600 dark:text-surface-400 dark:hover:text-forge-400 transition-colors"
                  data-testid="code-ref-back"
                >
                  ← back
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 text-lg leading-none px-1"
                aria-label="Close reference picker"
              >
                ×
              </button>
            </div>
          </div>

          <div className="measure-rule mt-3 mb-3" />

          {!pickedStep && (
            <input
              type="text"
              className="input w-full text-sm"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Filter upstream steps…"
              autoFocus
              data-testid="code-ref-search"
            />
          )}

          {!pickedStep ? (
            <Stage1
              steps={visibleSteps}
              variables={visibleVars.map((v) => ({ name: v.name, description: v.description }))}
              hasScope={steps.length + variables.length > 0}
              onPickStep={(id) => setPickedStepId(id)}
              onInsert={insertAndClose}
            />
          ) : (
            <Stage2
              step={pickedStep}
              integrationId={integrationId}
              onInsert={insertAndClose}
            />
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

/* ── Stage 1 — list of upstream sources ──────────────────────────── */

function Stage1({
  steps,
  variables,
  hasScope,
  onPickStep,
  onInsert,
}: {
  steps: ReferenceableStep[];
  variables: Array<{ name: string; description?: string }>;
  hasScope: boolean;
  onPickStep: (id: string) => void;
  onInsert: (token: string) => void;
}) {
  if (!hasScope) {
    return (
      // Empty-state borrows the blueprint vocabulary from the canvas:
      // frame-corners on a tighter card so "no upstream" reads as a
      // schematic-empty state, not a generic disabled message.
      <div className="relative mt-3 mx-1 px-4 py-6 rounded-md bg-surface-50/60 dark:bg-surface-900/40 ring-1 ring-dashed ring-surface-200 dark:ring-surface-800 frame-corners">
        <span className="corner corner-tl" />
        <span className="corner corner-tr" />
        <span className="corner corner-bl" />
        <span className="corner corner-br" />
        <p className="eyebrow text-center mb-1">no upstream</p>
        <p className="text-xs font-mono text-surface-500 dark:text-surface-400 text-center">
          this node is the first stage of its scope
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 mt-3">
      {steps.length > 0 && (
        <Section title="Steps" caption={steps.length}>
          {steps.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPickStep(s.id)}
              className="group relative w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10] transition-colors"
              data-testid={`code-ref-step-${s.id}`}
            >
              {/* 2px forge rail on hover — same drafting mark Select.tsx
                  uses on selection. Here it signals "this row is the
                  one your cursor's about to commit to". */}
              <span
                aria-hidden="true"
                className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-forge-500 opacity-0 group-hover:opacity-100 transition-opacity"
              />
              <KindChip kind={s.kind} action={s.action} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-surface-800 dark:text-surface-100 truncate">
                  {s.label}
                </span>
                <span className="block text-[10px] font-mono uppercase tracking-[0.12em] text-surface-400 dark:text-surface-500 truncate">
                  {s.id} · {s.kind}.{s.action}
                </span>
              </span>
              <span className="font-mono text-[11px] text-surface-400 dark:text-surface-500 group-hover:text-forge-600 dark:group-hover:text-forge-400 transition-colors">
                ▸
              </span>
            </button>
          ))}
        </Section>
      )}

      {variables.length > 0 && (
        <Section title="Variables" caption={variables.length}>
          {variables.map((v) => (
            <button
              key={v.name}
              type="button"
              onClick={() => onInsert(`{{$.vars.${v.name}}}`)}
              className="group relative w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10] transition-colors"
              data-testid={`code-ref-var-${v.name}`}
            >
              <span
                aria-hidden="true"
                className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-forge-500 opacity-0 group-hover:opacity-100 transition-opacity"
              />
              <span className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-mono uppercase tracking-wider bg-surface-100 text-surface-500 ring-1 ring-surface-200 dark:bg-surface-800 dark:text-surface-400 dark:ring-surface-700">
                $
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-mono text-surface-800 dark:text-surface-100 truncate">
                  {v.name}
                </span>
                {v.description && (
                  <span className="block text-[11px] text-surface-500 dark:text-surface-400 truncate">
                    {v.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </Section>
      )}

      <Section title="Run metadata" caption={3}>
        {[
          { token: '{{$.run.id}}', label: 'run.id', help: 'UUID of the active run' },
          {
            token: '{{$.run.started_at}}',
            label: 'run.started_at',
            help: 'ISO timestamp the run kicked off',
          },
          {
            token: '{{$.run.environment}}',
            label: 'run.environment',
            help: '`sandbox` | `production`',
          },
        ].map((entry) => (
          <button
            key={entry.token}
            type="button"
            onClick={() => onInsert(entry.token)}
            className="group relative w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10] transition-colors"
          >
            <span
              aria-hidden="true"
              className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-forge-500 opacity-0 group-hover:opacity-100 transition-opacity"
            />
            <span className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-mono uppercase tracking-wider bg-primary-50 text-primary-700 ring-1 ring-primary-200 dark:bg-primary-950/40 dark:text-primary-300 dark:ring-primary-800/50">
              ⟢
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-mono text-surface-800 dark:text-surface-100 truncate">
                {entry.label}
              </span>
              <span className="block text-[11px] text-surface-500 dark:text-surface-400 truncate">
                {entry.help}
              </span>
            </span>
          </button>
        ))}
      </Section>
    </div>
  );
}

/* ── Stage 2 — fields under the picked step ──────────────────────── */

function Stage2({
  step,
  integrationId,
  onInsert,
}: {
  step: ReferenceableStep;
  integrationId: string | null;
  onInsert: (token: string) => void;
}) {
  const fallback: InferredField[] = useMemo(() => {
    const entry = CATALOG.find((c) => c.kind === step.kind && c.action === step.action);
    const outputs = entry?.referenceableOutputs ?? FALLBACK_REFERENCEABLE_OUTPUTS;
    return outputs.map((o) => ({ path: o.path, type: 'any', sample: o.sample, description: o.description }));
  }, [step.kind, step.action]);

  const schema = useStepSchema({
    integrationId,
    nodeId: step.id,
    fallback,
  });

  const fields = schema.fields.filter((f) => f.path);

  return (
    <div className="space-y-3 mt-3">
      {/* Provenance — forge-tinted left edge promotes this from a
          generic status line into a dimensioned annotation, matching
          the rest of the project's drafting vocabulary. The pip + text
          + refresh roles stay; only the chrome around them changes. */}
      <div className="relative flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-md bg-surface-50/70 dark:bg-surface-900/50 ring-1 ring-surface-200/70 dark:ring-surface-800/70">
        <span
          aria-hidden="true"
          className={`absolute left-0 top-1 bottom-1 w-[2px] rounded-r ${
            schema.source ? 'bg-emerald-500' : 'bg-surface-300 dark:bg-surface-600'
          }`}
        />
        <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-500 dark:text-surface-400 flex-shrink-0">
          shape
        </span>
        <span className="text-[10px] font-mono text-surface-500 dark:text-surface-400 truncate">
          {schema.source ? (
            <>
              run {schema.source.runId.slice(0, 8)}
              {schema.source.finishedAt &&
                ` · ${new Date(schema.source.finishedAt).toLocaleTimeString()}`}
            </>
          ) : (
            <>from catalog · run integration to use real shape</>
          )}
        </span>
        <button
          type="button"
          onClick={schema.refresh}
          disabled={schema.loading}
          className="ml-auto px-1.5 py-0.5 rounded text-[11px] font-mono text-surface-500 hover:text-forge-600 hover:bg-forge-500/[0.08] dark:hover:text-forge-400 disabled:opacity-50 transition-colors"
          title="Re-fetch from latest successful run"
        >
          {schema.loading ? '…' : '↻'}
        </button>
      </div>

      {/* Whole-output card — the prominent option. Forge-tinted left
          rail (full height, 2px) marks it as the leading pick without
          needing a louder background. Uses the same vocabulary
          Select.tsx uses for the selected row. */}
      <button
        type="button"
        onClick={() => onInsert(`{{$.steps.${step.id}.output}}`)}
        className="group relative w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-md ring-1 ring-forge-500/30 bg-forge-500/[0.04] hover:bg-forge-500/[0.10] hover:ring-forge-500/50 dark:bg-forge-500/[0.07] dark:hover:bg-forge-500/[0.14] transition-colors"
        data-testid="code-ref-whole-output"
      >
        <span
          aria-hidden="true"
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-forge-500"
        />
        <span className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-mono uppercase tracking-wider bg-forge-500/15 text-forge-700 ring-1 ring-forge-500/30 dark:bg-forge-500/20 dark:text-forge-300 dark:ring-forge-500/40">
          ◆
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-mono text-forge-700 dark:text-forge-300">
            output
          </span>
          <span className="block text-[11px] text-surface-500 dark:text-surface-400">
            the whole value this step produces
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-forge-600/80 dark:text-forge-400/80 group-hover:text-forge-700 dark:group-hover:text-forge-300 transition-colors">
          whole
        </span>
      </button>

      {fields.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between mb-1 px-0.5">
            <span className="eyebrow">Fields</span>
            <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
              {fields.length}
            </span>
          </div>
          <ul className="max-h-72 overflow-y-auto solder-scroll-thin divide-y divide-dashed divide-surface-200/60 dark:divide-surface-800/60 rounded-md ring-1 ring-surface-200 dark:ring-surface-800">
            {fields.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => onInsert(`{{$.steps.${step.id}.output.${f.path}}}`)}
                  className="group relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 hover:bg-forge-500/[0.06] dark:hover:bg-forge-500/[0.10] transition-colors"
                  data-testid={`code-ref-field-${f.path}`}
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r bg-forge-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-mono text-surface-800 dark:text-surface-100 truncate">
                      {f.path}
                    </span>
                    {f.description && (
                      <span className="block text-[10px] text-surface-500 dark:text-surface-400 truncate">
                        {f.description}
                      </span>
                    )}
                  </span>
                  {/* Type chip — tabular column on the right edge so the
                      types stack into a clean column down the list. */}
                  <TypeChip type={f.type} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────── */

/**
 * Section header with eyebrow + caption count, dotted divider list
 * underneath. Matches the Select.tsx popover rhythm so users see the
 * same density across both surfaces.
 */
function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1 px-0.5">
        <span className="eyebrow">{title}</span>
        {caption !== undefined && (
          <span className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500">
            {caption}
          </span>
        )}
      </div>
      <div className="divide-y divide-dashed divide-surface-200/60 dark:divide-surface-800/60 rounded-md ring-1 ring-surface-200 dark:ring-surface-800 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

/**
 * Compact kind+action chip — same vocabulary NodeCard uses on the
 * canvas. Looks up the catalog entry for the chip background classes;
 * falls back to a neutral chip if the kind isn't in the catalog (e.g.
 * a future kind we haven't shipped yet).
 */
function KindChip({ kind, action }: { kind: string; action: string }) {
  const entry = CATALOG.find((c) => c.kind === kind && c.action === action);
  const chipCls =
    entry?.chip ??
    'bg-surface-100 text-surface-600 ring-1 ring-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:ring-surface-700';
  const icon = entry?.icon ?? '·';
  return (
    <span
      className={`flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-xs leading-none ${chipCls}`}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

/**
 * Type chip for Stage 2 field rows. Tonal variants for each Python-
 * adjacent inferred type so the user can scan the right column and
 * tell strings from numbers from records at a glance. Width is fixed
 * (min-w-12, tabular-nums) so the column lines up down the list.
 */
function TypeChip({ type }: { type: string }) {
  const t = (type || 'any').toLowerCase();
  const cls = TYPE_TONE[t] ?? TYPE_TONE.any;
  return (
    <span
      className={`flex-shrink-0 inline-flex items-center justify-center min-w-[3rem] px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-[0.1em] tabular-nums ${cls}`}
    >
      {t}
    </span>
  );
}

const TYPE_TONE: Record<string, string> = {
  string: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-800/40',
  number: 'bg-forge-50 text-forge-700 ring-1 ring-forge-200 dark:bg-forge-950/30 dark:text-forge-300 dark:ring-forge-800/40',
  integer: 'bg-forge-50 text-forge-700 ring-1 ring-forge-200 dark:bg-forge-950/30 dark:text-forge-300 dark:ring-forge-800/40',
  boolean: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:ring-violet-800/40',
  array: 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:ring-cyan-800/40',
  object: 'bg-primary-50 text-primary-700 ring-1 ring-primary-200 dark:bg-primary-950/30 dark:text-primary-300 dark:ring-primary-800/40',
  null: 'bg-surface-100 text-surface-500 ring-1 ring-surface-200 dark:bg-surface-800 dark:text-surface-400 dark:ring-surface-700',
  any: 'bg-surface-100 text-surface-500 ring-1 ring-surface-200 dark:bg-surface-800 dark:text-surface-400 dark:ring-surface-700',
};
