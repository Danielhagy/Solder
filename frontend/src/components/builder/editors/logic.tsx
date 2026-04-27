import type { ChangeEvent } from 'react';
import { useIntegrationStore } from '@/stores/integration';
import type {
  BranchVariable,
  LoopAppend,
  SwitchCase
} from '@/catalog';
import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

/**
 * Logic group editor. Dispatches by `node.action` so a single import
 * site in PropertiesPanel covers the whole family. New `switch` action
 * lives alongside the existing `branch` (If/Else) and `loop`. See
 * NODE_CATALOG_PLAN.md §5.5.
 */
export default function LogicEditor({ node, set }: EditorProps) {
  if (node.action === 'branch') return <BranchEditor node={node} set={set} />;
  if (node.action === 'switch') return <SwitchEditor node={node} set={set} />;
  if (node.action === 'loop') return <LoopEditor node={node} set={set} />;
  if (node.action === 'assert') return <AssertEditor node={node} set={set} />;
  if (node.action === 'gate') return <GateEditor node={node} set={set} />;
  // Legacy: pre-rename `if` kind. Preserved verbatim for any old
  // integrations still on disk; the catalog no longer surfaces it.
  if (node.action === 'if') return <IfLegacyEditor node={node} set={set} />;
  return (
    <p className="text-sm text-surface-500 dark:text-surface-400">
      No editor for logic.{node.action}.
    </p>
  );
}

/* ============================================================ */
/* Assert                                                        */
/* ============================================================ */

function AssertEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Predicate
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.expression as string) || ''}
          onChange={(next) => set('expression', next)}
          placeholder='$.amount > 0'
          rows={3}
          ariaLabel="Assert predicate"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Truthy → run continues with input passed through unchanged. Falsy → run halts with
          an assertion error.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Failure message
        </span>
        <input
          type="text"
          className="input w-full"
          value={(node.config.message as string) || ''}
          placeholder="Assertion failed"
          onChange={(e) => set('message', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Surfaced in the run drawer when the assertion fires.
        </p>
      </label>
    </div>
  );
}

/* ============================================================ */
/* Gate                                                          */
/* ============================================================ */

function GateEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Predicate
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.expression as string) || ''}
          onChange={(next) => set('expression', next)}
          placeholder='$.is_active'
          rows={3}
          ariaLabel="Gate predicate"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Truthy → input passes through to downstream nodes unchanged.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          When falsy
        </span>
        <select
          className="input w-full"
          value={(node.config.on_false as string) || 'skip'}
          onChange={(e) => set('on_false', e.currentTarget.value)}
        >
          <option value="skip">Skip downstream nodes (run continues with last good value)</option>
          <option value="stop">Stop the run (graceful exit, no error)</option>
        </select>
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Differs from <span className="font-mono">assert</span>: <span className="font-mono">stop</span> is a clean
          end-of-run, not an error.
        </p>
      </label>
    </div>
  );
}

/* ============================================================ */
/* If / Else                                                     */
/* ============================================================ */

function BranchEditor({ node, set }: EditorProps) {
  const variables = (node.config.variables as BranchVariable[] | undefined) ?? [];
  return (
    <>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Predicate
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.expression as string) || ''}
          onChange={(next) => set('expression', next)}
          placeholder='$.status == "approved"'
          rows={3}
          ariaLabel="If/Else predicate"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Truthy → TRUE arm runs; otherwise FALSE. Renders verbatim on
          the card so the structure is readable without stepping in.
        </p>
      </label>

      <VariablesEditor
        variables={variables}
        onChange={(next) => set('variables', next)}
        helper="Declared on this node. Inner steps populate them; downstream nodes read from this branch's scope after either arm completes."
      />
    </>
  );
}

/* ============================================================ */
/* Switch                                                        */
/* ============================================================ */

function SwitchEditor({ node, set }: EditorProps) {
  const cases = (node.config.cases as SwitchCase[] | undefined) ?? [];
  const variables = (node.config.variables as BranchVariable[] | undefined) ?? [];
  // applySwitchCases keeps `config.cases` and `node.branches` in lockstep
  // so the canvas never renders an arm whose key isn't in the cases array.
  const applySwitchCases = useIntegrationStore((s) => s.applySwitchCases);

  function patchCase(idx: number, patch: Partial<SwitchCase>) {
    const next = cases.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    applySwitchCases(node.id, next);
  }

  function addCase() {
    // Find a unique key by scanning existing case_N indices.
    const used = new Set(cases.map((c) => c.key));
    let n = cases.length + 1;
    while (used.has(`case_${n}`)) n++;
    const next: SwitchCase[] = [...cases, { key: `case_${n}`, match: '', label: '' }];
    applySwitchCases(node.id, next);
  }

  function removeCase(idx: number) {
    const target = cases[idx];
    const branchHasNodes = (node.branches?.[target.key]?.length ?? 0) > 0;
    if (branchHasNodes) {
      const ok = window.confirm(
        `Remove case "${target.label?.trim() || target.key}"? Its ${
          node.branches?.[target.key]?.length
        } step(s) will be deleted.`
      );
      if (!ok) return;
    }
    const next = cases.filter((_, i) => i !== idx);
    applySwitchCases(node.id, next);
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-sm font-medium text-surface-700 dark:text-surface-200">
            Cases
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500 tabular-nums">
            {cases.length} + default
          </span>
        </div>
        <p className="text-xs text-surface-500 mb-2 dark:text-surface-400">
          Evaluated top-to-bottom. The first case whose predicate is
          truthy runs; if none match, the <span className="font-mono">default</span> arm runs.
        </p>

        <div className="space-y-2">
          {cases.map((c, i) => (
            <div
              key={c.key}
              className="rounded-md border border-surface-200 dark:border-surface-800 p-2.5 space-y-2 bg-surface-50/40 dark:bg-surface-900/40"
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-forge-700/70 dark:text-forge-400/80 tabular-nums shrink-0">
                  {c.key}
                </span>
                <input
                  type="text"
                  className="input flex-1 text-sm py-1"
                  value={c.label ?? ''}
                  placeholder={`Case ${i + 1}`}
                  onChange={(e) => patchCase(i, { label: e.currentTarget.value })}
                  aria-label={`Case ${i + 1} label`}
                />
                <button
                  type="button"
                  aria-label="Remove case"
                  className="text-surface-400 hover:text-red-500 dark:text-surface-600 dark:hover:text-red-400 text-sm leading-none px-1"
                  onClick={() => removeCase(i)}
                >
                  ✕
                </button>
              </div>
              <ReferenceField
                nodeId={node.id}
                value={c.match}
                onChange={(next) => patchCase(i, { match: next })}
                placeholder='$.status == "approved"'
                singleLine
                ariaLabel={`Case ${i + 1} match expression`}
              />
            </div>
          ))}
        </div>

        <button
          type="button"
          className="mt-2 w-full rounded-md border border-dashed border-surface-200 hover:border-forge-300 dark:border-surface-800 dark:hover:border-forge-500/50 py-1.5 text-xs font-mono uppercase tracking-[0.15em] text-surface-500 hover:text-forge-600 dark:text-surface-400 dark:hover:text-forge-400 transition-colors"
          onClick={addCase}
        >
          + add case
        </button>
      </div>

      <div className="rounded-md border border-surface-200 dark:border-surface-800 px-2.5 py-2 bg-surface-50/40 dark:bg-surface-900/40">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-forge-700/70 dark:text-forge-400/80 tabular-nums shrink-0">
            default
          </span>
          <span className="text-xs text-surface-500 dark:text-surface-400">
            Catches anything no case matched. Always present.
          </span>
        </div>
      </div>

      <VariablesEditor
        variables={variables}
        onChange={(next) => set('variables', next)}
        helper="Declared on this node. Inner steps populate them; downstream nodes read from this switch's scope after the matched arm completes."
      />
    </div>
  );
}

/* ============================================================ */
/* Loop                                                          */
/* ============================================================ */

function LoopEditor({ node, set }: EditorProps) {
  const appends = (node.config.appends as LoopAppend[] | undefined) ?? [];
  return (
    <>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Iterate over
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.over as string) || ''}
          onChange={(next) => set('over', next)}
          placeholder="$.items"
          singleLine
          ariaLabel="Loop iterate over"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the array to iterate. The body runs once per
          element with that element as input.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Output
        </span>
        <select
          className="input w-full"
          value={(node.config.reduce as string) || 'collect'}
          onChange={(e) => set('reduce', e.currentTarget.value)}
        >
          <option value="collect">Array of every iteration's output</option>
          <option value="last">Last iteration's output only</option>
          <option value="count">Iteration count</option>
          <option value="none">Discard (run for side effects)</option>
        </select>
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Decides what flows out of the loop. Surfaced on the card so
          downstream nodes don't have to guess.
        </p>
      </label>

      <NamedListEditor
        title="Appends"
        addLabel="+ add append"
        items={appends}
        onChange={(next) => set('appends', next)}
        namePlaceholder="succeeded"
        helper="Named accumulators. Inner steps append to them per iteration; downstream reads each as an array. Useful when the loop produces parallel collections (e.g. successes vs failures) without a follow-up split."
      />
    </>
  );
}

/* ============================================================ */
/* Legacy                                                        */
/* ============================================================ */

function IfLegacyEditor({ node, set }: EditorProps) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Condition
      </span>
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
  );
}

/* ============================================================ */
/* Shared list editors                                           */
/* ============================================================ */

interface NamedItem {
  name: string;
  description?: string;
}

/**
 * Generic named-list editor. Branch/Switch use it for variables; Loop
 * uses it for appends. Same shape (name + optional description), same
 * UI — kept as one component so adding rows / clearing them feels the
 * same in every place.
 */
function NamedListEditor<T extends NamedItem>({
  title,
  addLabel,
  items,
  onChange,
  namePlaceholder,
  helper
}: {
  title: string;
  addLabel: string;
  items: T[];
  onChange: (next: T[]) => void;
  namePlaceholder: string;
  helper: string;
}) {
  function patch(idx: number, patch: Partial<T>) {
    onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) as T[]);
  }
  function add() {
    onChange([...items, { name: '', description: '' } as T]);
  }
  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm font-medium text-surface-700 dark:text-surface-200">
          {title}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500 tabular-nums">
          {items.length}
        </span>
      </div>
      <p className="text-xs text-surface-500 mb-2 dark:text-surface-400">{helper}</p>

      {items.length === 0 ? (
        <p className="text-[11px] font-mono italic text-surface-400 dark:text-surface-600 mb-2">
          none declared
        </p>
      ) : (
        <div className="space-y-2 mb-2">
          {items.map((it, i) => (
            <div
              key={i}
              className="rounded-md border border-surface-200 dark:border-surface-800 p-2 space-y-1.5 bg-surface-50/40 dark:bg-surface-900/40"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="input flex-1 font-mono text-sm py-1"
                  value={it.name}
                  placeholder={namePlaceholder}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    patch(i, { name: e.currentTarget.value } as Partial<T>)
                  }
                  aria-label={`${title} ${i + 1} name`}
                />
                <button
                  type="button"
                  aria-label={`Remove ${title} item`}
                  className="text-surface-400 hover:text-red-500 dark:text-surface-600 dark:hover:text-red-400 text-sm leading-none px-1"
                  onClick={() => remove(i)}
                >
                  ✕
                </button>
              </div>
              <input
                type="text"
                className="input w-full text-xs py-1"
                value={it.description ?? ''}
                placeholder="Description (optional)"
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  patch(i, { description: e.currentTarget.value } as Partial<T>)
                }
                aria-label={`${title} ${i + 1} description`}
              />
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="w-full rounded-md border border-dashed border-surface-200 hover:border-forge-300 dark:border-surface-800 dark:hover:border-forge-500/50 py-1.5 text-xs font-mono uppercase tracking-[0.15em] text-surface-500 hover:text-forge-600 dark:text-surface-400 dark:hover:text-forge-400 transition-colors"
        onClick={add}
      >
        {addLabel}
      </button>
    </div>
  );
}

function VariablesEditor({
  variables,
  onChange,
  helper
}: {
  variables: BranchVariable[];
  onChange: (next: BranchVariable[]) => void;
  helper: string;
}) {
  return (
    <NamedListEditor
      title="Variables"
      addLabel="+ add variable"
      items={variables}
      onChange={onChange}
      namePlaceholder="customer_tier"
      helper={helper}
    />
  );
}
