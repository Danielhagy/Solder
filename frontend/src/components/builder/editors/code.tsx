import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { tokyoNight } from '@uiw/codemirror-theme-tokyo-night';
import { EditorView } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import { CATALOG, FALLBACK_REFERENCEABLE_OUTPUTS } from '@/catalog';
import { useIntegrationStore, getReferenceableScope } from '@/stores/integration';
import { useStepSchema } from '@/lib/use-step-schema';
import type { EditorProps } from './_shared';
import { PYTHON_SNIPPETS, type PythonSnippet } from './code-snippets';
import {
  schemaCompletions,
  paramsFromReferenceableOutputs,
} from './code-autocomplete';
import CodeOutputPanel from './code-output-panel';
import TemplatesOverlay from './code-templates-overlay';
import RefOverlay from './code-ref-overlay';

/**
 * Code group editor. Today: just `code.python`. Future actions
 * (`code.javascript`, `code.jsonata`, `code.jmespath`, `code.shell`)
 * dispatch off `node.action`.
 */
export default function CodeEditor({ node, set }: EditorProps) {
  if (node.action === 'python') return <PythonEditor node={node} set={set} />;
  return (
    <p className="text-sm text-surface-500 dark:text-surface-400">
      No editor for code.{node.action}.
    </p>
  );
}

/** Modules the backend sandbox pre-binds into the user's namespace. */
const AUTO_IMPORTED = [
  'json',
  'math',
  're',
  'datetime',
  'random',
  'collections',
  'itertools',
  'functools',
  'string',
  'base64',
  'hashlib',
  'decimal',
  'statistics',
  'textwrap',
  'csv',
  'operator',
  'copy',
];

function PythonEditor({ node, set }: EditorProps) {
  const allowImports = (node.config.allow_imports as string[]) || [];
  const csv = allowImports.join(', ');
  const source = (node.config.source as string) || '';

  // Static catalog-derived schema for the closest upstream step. This
  // is the fallback shape the autocomplete uses when no real run data
  // exists for the upstream step. The runtime-aware `useStepSchema`
  // call below upgrades it to the real shape when a recent successful
  // run has produced output for that step.
  const upstreamSchema = useIntegrationStore((s) => {
    const scope = getReferenceableScope(s, node.id);
    const closest = scope?.steps[scope.steps.length - 1];
    if (!closest) return null;
    const entry = CATALOG.find(
      (c) => c.kind === closest.kind && c.action === closest.action
    );
    const outputs = entry?.referenceableOutputs ?? FALLBACK_REFERENCEABLE_OUTPUTS;
    return { stepLabel: closest.label, stepId: closest.id, outputs };
  });

  // Pull the real-run schema when an integration is loaded. Falls back
  // to the static catalog shape until a successful run produces output
  // for the upstream step. The hook caches per (integrationId, nodeId)
  // so the editor's keystrokes don't re-hit the API.
  const params = useParams<{ id?: string }>();
  const integrationId =
    params.id && params.id !== 'new' ? params.id : null;
  const fallbackFields = useMemo(() => {
    if (!upstreamSchema) return [];
    return upstreamSchema.outputs.map((o) => ({
      path: o.path,
      type: 'any',
      sample: o.sample,
      description: o.description,
    }));
  }, [upstreamSchema]);
  const stepSchema = useStepSchema({
    integrationId,
    nodeId: upstreamSchema?.stepId ?? null,
    fallback: fallbackFields,
  });

  // Memoised on upstream-schema identity so the autocomplete source
  // rebuilds only when the previous step's shape changes, not per keystroke.
  const extensions = useMemo(() => {
    // Top-level keys come from the inferred schema (real or fallback).
    // The completion source dedupes on first segment, so passing all
    // paths is fine — `paramsFromReferenceableOutputs` extracts the
    // top-level set we want for `data["..."]` autocomplete.
    const params = stepSchema.fields.length
      ? paramsFromReferenceableOutputs(
          stepSchema.fields.map((f) => ({
            path: f.path,
            description: f.description ?? '',
            sample: f.sample,
          }))
        )
      : { topKeys: [] };
    return [
      python(),
      EditorView.lineWrapping,
      autocompletion({ override: [schemaCompletions(params)] }),
      EditorView.theme({
        '&': {
          fontSize: '12.5px',
          borderRadius: '6px',
          overflow: 'hidden',
          minHeight: '14rem',
          maxHeight: '24rem',
        },
        '.cm-scroller': {
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
        },
        '.cm-content': { padding: '8px 0' },
        '.cm-gutters': { borderRight: '1px solid rgb(255 255 255 / 0.05)' },
      }),
    ];
  }, [stepSchema.fields]);

  // Live EditorView ref for cursor-position inserts. Captured via
  // CodeMirror's `onCreateEditor` callback below so the toolbar
  // overlays can dispatch edits at the user's cursor (snippets +
  // reference tokens both flow through this).
  const viewRef = useRef<EditorView | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [refOpen, setRefOpen] = useState(false);

  function insertAtCursor(text: string) {
    const view = viewRef.current;
    if (!view) {
      // Fallback when the editor hasn't mounted yet — append to source.
      set('source', (source ?? '') + text);
      return;
    }
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  }

  function applySnippet(snippet: PythonSnippet) {
    // Empty editor: replace outright. Non-empty: insert at cursor so
    // users can compose snippets into existing code without losing it.
    if (!source.trim()) {
      set('source', snippet.source);
    } else {
      insertAtCursor(snippet.source);
    }
    setTemplatesOpen(false);
    // Defer focus so the editor mounts the new value before we try to
    // place the cursor.
    requestAnimationFrame(() => viewRef.current?.focus());
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-surface-700 dark:text-surface-200">
            Source
          </span>
          {/* Always-on toolbar — Templates and Insert ref reachable
              regardless of whether the source is empty or already
              populated. Mirrors the editorial vibe: small mono labels,
              forge-tinted hover states. */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setTemplatesOpen(true)}
              className="text-[11px] font-mono px-2 py-0.5 rounded-md text-surface-500 hover:text-forge-700 hover:bg-forge-500/[0.06] dark:text-surface-400 dark:hover:text-forge-300 transition-colors"
              data-testid="code-python-templates"
              title="Browse starter templates"
            >
              ⊞ templates
            </button>
            <button
              type="button"
              onClick={() => setRefOpen(true)}
              className="text-[11px] font-mono px-2 py-0.5 rounded-md text-surface-500 hover:text-forge-700 hover:bg-forge-500/[0.06] dark:text-surface-400 dark:hover:text-forge-300 transition-colors"
              data-testid="code-python-ref"
              title="Insert a reference to an upstream step's output"
            >
              {'{·} insert ref'}
            </button>
          </div>
        </div>

        {/*
         * Snippet picker — only when the editor is empty. Cards drop a
         * working starter into the editor; users edit from there. Keeps
         * the blank-page friction below the threshold where users bounce.
         * The Templates button above provides the same gallery any time.
         */}
        {!source.trim() && (
          <SnippetPicker onPick={(code) => set('source', code)} />
        )}

        <div
          className="rounded-md ring-1 ring-surface-300 dark:ring-surface-700 overflow-hidden"
          data-testid="code-python-source"
        >
          <CodeMirror
            value={source}
            onChange={(value) => set('source', value)}
            theme={tokyoNight}
            extensions={extensions}
            onCreateEditor={(view) => {
              viewRef.current = view;
            }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: true,
              autocompletion: true,
              bracketMatching: true,
              closeBrackets: true,
              indentOnInput: true,
              tabSize: 4,
              highlightSelectionMatches: false,
            }}
          />
        </div>

        <p className="text-xs text-surface-500 mt-1.5 dark:text-surface-400 leading-relaxed">
          The upstream output is bound to <code className="font-mono">data</code>. Inline{' '}
          <code className="font-mono">{'{{$.path}}'}</code> tokens (e.g.{' '}
          <code className="font-mono">{'{{$.steps.API_1.output.body.id}}'}</code>) are spliced
          in as Python literals before the script runs. Set{' '}
          <code className="font-mono">result</code> (any JSON-serialisable value) to emit it
          downstream. <code className="font-mono">print()</code> output appears in the{' '}
          <span className="font-mono">Stdout</span> tab below after a Test run.
        </p>

        {/*
         * Live `data` shape preview — collapsed by default, expands to a
         * field list with type chips. Drives the autocomplete so this
         * disclosure also serves as a discovery surface for what users
         * can complete on. Prefers real-run-inferred shape; falls back
         * to the static catalog description when no successful run
         * exists yet.
         */}
        {upstreamSchema && stepSchema.fields.length > 0 && (
          <DataShapeDisclosure
            stepLabel={upstreamSchema.stepLabel}
            fields={stepSchema.fields}
            source={stepSchema.source}
            loading={stepSchema.loading}
            onRefresh={stepSchema.refresh}
          />
        )}

        <details className="mt-2">
          <summary className="text-xs font-mono uppercase tracking-[0.15em] text-surface-500 dark:text-surface-400 cursor-pointer select-none hover:text-surface-700 dark:hover:text-surface-200">
            pre-imported modules
            <span className="ml-2 text-surface-400 dark:text-surface-600 normal-case tracking-normal">
              ({AUTO_IMPORTED.length})
            </span>
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {AUTO_IMPORTED.map((mod) => (
              <code
                key={mod}
                className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-surface-100 text-surface-700 ring-1 ring-surface-200 dark:bg-surface-800 dark:text-surface-200 dark:ring-surface-700"
              >
                {mod}
              </code>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-surface-500 dark:text-surface-400">
            Use any of these without <code className="font-mono">import</code>. Need
            something else? Add it to the Allowed imports list below.
          </p>
        </details>

        {/* Persistent output panel — surfaces the most recent Test run
            for this node. Renders nothing until a test has been run. */}
        <CodeOutputPanel nodeId={node.id} />
      </div>

      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Timeout
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            className="input flex-1 font-mono text-sm"
            min={100}
            max={120000}
            step={100}
            value={(node.config.timeout_ms as number) ?? 30000}
            onChange={(e) => set('timeout_ms', Number(e.currentTarget.value) || 30000)}
          />
          <span className="text-xs font-mono text-surface-500 dark:text-surface-400">ms</span>
        </div>
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          The script is killed if it runs longer. 30s is plenty for normal transforms; bump
          for heavy-data jobs.
        </p>
      </label>

      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Allowed imports
          <span className="eyebrow">optional</span>
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={csv}
          placeholder="urllib.parse, hmac"
          onChange={(e) => {
            const next = e.currentTarget.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            set('allow_imports', next);
          }}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Extra stdlib modules the script may <code className="font-mono">import</code>{' '}
          beyond the pre-imported set. Networking and filesystem modules are always
          blocked.
        </p>
      </label>

      {/* Portal-rendered overlays — both insert at the editor's cursor
          via the captured EditorView ref. They live outside the editor
          card so backdrop blur / fixed positioning isn't trapped by an
          ancestor's containing block (the same lesson Select learned). */}
      <TemplatesOverlay
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onPick={applySnippet}
      />
      <RefOverlay
        open={refOpen}
        onClose={() => setRefOpen(false)}
        nodeId={node.id}
        integrationId={integrationId}
        onInsert={insertAtCursor}
      />
    </div>
  );
}

/* ── Sub-components ───────────────────────────────────────────────── */

function SnippetPicker({ onPick }: { onPick: (code: string) => void }) {
  return (
    <div className="mb-2 rounded-md ring-1 ring-forge-500/20 bg-forge-500/[0.03] dark:ring-forge-500/30 dark:bg-forge-500/[0.04] p-2.5">
      <div className="flex items-baseline justify-between mb-2">
        <p className="eyebrow text-forge-700 dark:text-forge-300">starter snippets</p>
        <span className="text-[10px] font-mono text-surface-400 dark:text-surface-500">
          click to insert
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {PYTHON_SNIPPETS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s.source)}
            className="text-left px-2.5 py-1.5 rounded-md ring-1 ring-surface-200 bg-white hover:bg-forge-500/[0.06] hover:ring-forge-500/40 dark:ring-surface-700 dark:bg-surface-900/60 dark:hover:bg-forge-500/[0.10] transition-colors"
            data-testid={`code-snippet-${s.id}`}
          >
            <div className="text-xs font-medium text-surface-900 dark:text-surface-50">
              {s.title}
            </div>
            <div className="text-[10px] text-surface-500 dark:text-surface-400 truncate">
              {s.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DataShapeDisclosure({
  stepLabel,
  fields,
  source,
  loading,
  onRefresh,
}: {
  stepLabel: string;
  fields: Array<{ path: string; type: string; sample?: unknown; description?: string }>;
  source: { runId: string; finishedAt: string | null } | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  // Keep only top-level paths for the chip display; deep paths cluster
  // by their first segment to avoid drowning the user in `body.id`,
  // `body.email`, `body.name` rows.
  const topLevel = useMemo(() => {
    const seen = new Map<
      string,
      { type: string; sample?: unknown; description?: string; childCount: number }
    >();
    for (const f of fields) {
      if (!f.path) continue;
      const head = f.path.split('.')[0];
      const existing = seen.get(head);
      if (!existing) {
        seen.set(head, {
          type: f.path === head ? f.type : 'dict',
          sample: f.path === head ? f.sample : undefined,
          description: f.path === head ? f.description : undefined,
          childCount: f.path === head ? 0 : 1,
        });
      } else if (f.path === head) {
        existing.type = f.type;
        existing.sample = f.sample;
        existing.description = f.description;
      } else {
        existing.childCount += 1;
      }
    }
    return Array.from(seen.entries()).map(([key, v]) => ({ key, ...v }));
  }, [fields]);

  if (topLevel.length === 0) return null;

  return (
    <details className="mt-2" data-testid="code-data-shape">
      <summary className="text-xs font-mono uppercase tracking-[0.15em] text-surface-500 dark:text-surface-400 cursor-pointer select-none hover:text-surface-700 dark:hover:text-surface-200">
        data shape
        <span className="ml-2 text-surface-400 dark:text-surface-600 normal-case tracking-normal">
          from {stepLabel} · {topLevel.length} field{topLevel.length === 1 ? '' : 's'}
        </span>
      </summary>
      {/* Provenance badge — when the schema came from an actual run,
          show which run + when. Click ↻ to re-fetch (useful after a
          new run lands). When no source is set we're on the static
          catalog fallback; the badge reads "from catalog" so the user
          knows the shape might be incomplete. */}
      <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono text-surface-500 dark:text-surface-400">
        {source ? (
          <>
            <span
              aria-hidden="true"
              className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"
            />
            <span>
              run {source.runId.slice(0, 8)}
              {source.finishedAt && ` · ${new Date(source.finishedAt).toLocaleTimeString()}`}
            </span>
          </>
        ) : (
          <>
            <span
              aria-hidden="true"
              className="inline-block w-1.5 h-1.5 rounded-full bg-surface-300 dark:bg-surface-600"
            />
            <span>from catalog · run the integration to use real shape</span>
          </>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto px-1.5 py-0.5 rounded hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-50"
          title="Re-fetch from latest successful run"
          data-testid="code-data-shape-refresh"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {topLevel.map((f) => (
          <code
            key={f.key}
            title={f.description}
            className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-surface-100 text-surface-700 ring-1 ring-surface-200 dark:bg-surface-800 dark:text-surface-200 dark:ring-surface-700"
          >
            {f.key}
            <span className="ml-1 text-surface-400 dark:text-surface-500">{f.type}</span>
          </code>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-surface-500 dark:text-surface-400">
        Type <code className="font-mono">data[&quot;</code> in the editor to autocomplete on
        these keys.
      </p>
    </details>
  );
}

