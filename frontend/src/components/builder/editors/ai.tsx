import type { EditorProps } from './_shared';

/**
 * AI group editor. Each action is a single, named LLM call — `prompt`
 * (free-form), `classify` (pick-one), `extract` (structured), `summarise`
 * (long → short). Per FullSpec §11 these are the *only* AI nodes; the
 * intent / mapping / discovery agents are not user-draggable.
 *
 * Sandbox semantics are `route-to-mock` for now — sandbox runs hit a
 * fixture keyed by `(node_id, prompt_hash)` (FullSpec §10 Q5 still
 * decides whether that's record-or-stub-or-live; default conservative).
 *
 * `requiresCredentials: true` — the runtime resolves the Anthropic key
 * from the integration's stored credentials, not from the editor.
 */
export default function AiEditor({ node, set }: EditorProps) {
  switch (node.action) {
    case 'prompt':
      return <PromptEditor node={node} set={set} />;
    case 'classify':
      return <ClassifyEditor node={node} set={set} />;
    case 'extract':
      return <ExtractEditor node={node} set={set} />;
    case 'summarise':
      return <SummariseEditor node={node} set={set} />;
    default:
      return (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No editor for ai.{node.action}.
        </p>
      );
  }
}

function ModelSelect({
  value,
  onChange,
  defaultModel
}: {
  value: string;
  onChange: (v: string) => void;
  defaultModel: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Model
      </span>
      <select
        className="input w-full"
        value={value || defaultModel}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        <option value="claude-sonnet-4-6">Sonnet 4.6 (fast, cheap)</option>
        <option value="claude-opus-4-7">Opus 4.7 (reasoning, slow)</option>
        <option value="claude-haiku-4-5-20251001">Haiku 4.5 (fastest)</option>
      </select>
    </label>
  );
}

function SandboxBanner() {
  return (
    <div className="alert alert-info text-xs">
      <p className="font-medium mb-1">Sandbox behavior</p>
      <p>
        In sandbox, this node hits a deterministic fixture keyed by the prompt
        rather than calling Claude live — keeps test runs reproducible and
        free. Switch to production from the env selector in the header to use
        real credentials.
      </p>
    </div>
  );
}

function PromptEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ModelSelect
        value={(node.config.model as string) || ''}
        onChange={(v) => set('model', v)}
        defaultModel="claude-sonnet-4-6"
      />
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          System prompt
          <span className="eyebrow">optional</span>
        </span>
        <textarea
          className="input w-full h-20 font-mono text-xs leading-relaxed"
          value={(node.config.system as string) || ''}
          placeholder="You are a careful integration assistant…"
          onChange={(e) => set('system', e.currentTarget.value)}
          spellCheck={false}
        />
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          User prompt
        </span>
        <textarea
          className="input w-full h-28 font-mono text-xs leading-relaxed"
          value={(node.config.user as string) || ''}
          placeholder="$.prompt"
          onChange={(e) => set('user', e.currentTarget.value)}
          spellCheck={false}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath references (e.g. <span className="font-mono">$.prompt</span>) are interpolated
          before the call.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Max output tokens
        </span>
        <input
          type="number"
          className="input w-full font-mono text-sm"
          min={1}
          max={32000}
          value={(node.config.max_tokens as number) ?? 1024}
          onChange={(e) => set('max_tokens', Number(e.currentTarget.value) || 1024)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
        <input
          type="checkbox"
          checked={!!node.config.structured}
          onChange={(e) => set('structured', e.currentTarget.checked)}
        />
        Force JSON output (tool-use)
        <span className="eyebrow">stricter</span>
      </label>
      <SandboxBanner />
    </div>
  );
}

function ClassifyEditor({ node, set }: EditorProps) {
  const labels = (node.config.labels as string[]) || [];
  const update = (next: string[]) => set('labels', next);
  return (
    <div className="space-y-3">
      <ModelSelect
        value={(node.config.model as string) || ''}
        onChange={(v) => set('model', v)}
        defaultModel="claude-sonnet-4-6"
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Input
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.input as string) || ''}
          placeholder="$"
          onChange={(e) => set('input', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the text being classified.
        </p>
      </label>
      <div>
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Labels
        </span>
        <div className="space-y-1.5">
          {labels.length === 0 && (
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Add at least two — the model returns one of these verbatim.
            </p>
          )}
          {labels.map((lbl, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                className="input flex-1 font-mono text-sm"
                value={lbl}
                placeholder="approved"
                onChange={(e) => {
                  const next = [...labels];
                  next[i] = e.currentTarget.value;
                  update(next);
                }}
              />
              <button
                type="button"
                aria-label={`Remove label ${i + 1}`}
                className="btn-icon hover:text-red-500 dark:hover:text-red-400"
                onClick={() => update(labels.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="mt-2 btn btn-secondary text-sm"
          onClick={() => update([...labels, ''])}
        >
          + Add label
        </button>
      </div>
      <SandboxBanner />
    </div>
  );
}

function ExtractEditor({ node, set }: EditorProps) {
  const schema = (node.config.schema as Record<string, unknown>) || {};
  return (
    <div className="space-y-3">
      <ModelSelect
        value={(node.config.model as string) || ''}
        onChange={(v) => set('model', v)}
        defaultModel="claude-sonnet-4-6"
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Input
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.input as string) || ''}
          placeholder="$"
          onChange={(e) => set('input', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the text to extract from.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Schema
        </span>
        <textarea
          className="input w-full h-32 font-mono text-xs leading-relaxed"
          defaultValue={JSON.stringify(schema, null, 2)}
          placeholder={'{"vendor_name": "string", "amount": "number"}'}
          spellCheck={false}
          onBlur={(e) => {
            const text = e.currentTarget.value.trim();
            if (!text) {
              set('schema', {});
              return;
            }
            try {
              const parsed = JSON.parse(text);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                set('schema', parsed);
              }
            } catch {
              /* keep previous value until valid JSON */
            }
          }}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSON object: keys are the fields to pull, values are types
          (<span className="font-mono">string</span>, <span className="font-mono">number</span>,
          <span className="font-mono">boolean</span>, etc.). The model returns this exact shape.
        </p>
      </label>
      <SandboxBanner />
    </div>
  );
}

function SummariseEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ModelSelect
        value={(node.config.model as string) || ''}
        onChange={(v) => set('model', v)}
        defaultModel="claude-opus-4-7"
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Input
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.input as string) || ''}
          placeholder="$"
          onChange={(e) => set('input', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the long text to summarise.
        </p>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Length
          </span>
          <select
            className="input w-full"
            value={(node.config.target_length as string) || 'medium'}
            onChange={(e) => set('target_length', e.currentTarget.value)}
          >
            <option value="short">Short (~1 sentence)</option>
            <option value="medium">Medium (~paragraph)</option>
            <option value="long">Long (~half page)</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Style
          </span>
          <select
            className="input w-full"
            value={(node.config.style as string) || 'neutral'}
            onChange={(e) => set('style', e.currentTarget.value)}
          >
            <option value="neutral">Neutral</option>
            <option value="bullets">Bullets</option>
            <option value="executive">Executive</option>
            <option value="technical">Technical</option>
          </select>
        </label>
      </div>
      <SandboxBanner />
    </div>
  );
}
