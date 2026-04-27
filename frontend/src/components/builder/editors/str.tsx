import type { EditorProps } from './_shared';

/**
 * String group editor. Folded under the `Data` sidebar group but with a
 * distinct `kind`. Most actions take one input + an option block.
 */
export default function StrEditor({ node, set }: EditorProps) {
  switch (node.action) {
    case 'concat':
      return <ConcatEditor node={node} set={set} />;
    case 'split':
      return <SplitEditor node={node} set={set} />;
    case 'replace':
      return <ReplaceEditor node={node} set={set} />;
    case 'trim':
      return <TrimEditor node={node} set={set} />;
    case 'case':
      return <CaseEditor node={node} set={set} />;
    default:
      return (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No editor for str.{node.action}.
        </p>
      );
  }
}

function ValueField({
  value,
  onChange,
  help
}: {
  value: string;
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Value
      </span>
      <input
        type="text"
        className="input w-full font-mono text-sm"
        value={value}
        placeholder="$"
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {help && (
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">{help}</p>
      )}
    </label>
  );
}

function ConcatEditor({ node, set }: EditorProps) {
  // Stored as `string[]`; each entry is either a JSONPath ($.foo) or a
  // literal. The runtime decides per-entry. Rendered as one input per part
  // with add/remove buttons so users can sequence them clearly.
  const parts = (node.config.parts as string[]) || [];
  const update = (next: string[]) => set('parts', next);
  return (
    <div className="space-y-3">
      <div>
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Parts
        </span>
        <div className="space-y-1.5">
          {parts.length === 0 && (
            <p className="text-xs text-surface-500 dark:text-surface-400">
              No parts yet — add one below.
            </p>
          )}
          {parts.map((part, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                className="input flex-1 font-mono text-sm"
                value={part}
                placeholder={'$.first_name  or  " "  or  literal'}
                onChange={(e) => {
                  const next = [...parts];
                  next[i] = e.currentTarget.value;
                  update(next);
                }}
              />
              <button
                type="button"
                aria-label={`Remove part ${i + 1}`}
                className="btn-icon hover:text-red-500 dark:hover:text-red-400"
                onClick={() => update(parts.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="mt-2 btn btn-secondary text-sm"
          onClick={() => update([...parts, ''])}
        >
          + Add part
        </button>
        <p className="text-xs text-surface-500 mt-2 dark:text-surface-400">
          Each part is either a JSONPath (<span className="font-mono">$.field</span>) or a literal. Strings are joined in order.
        </p>
      </div>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Separator
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.separator as string) ?? ''}
          placeholder="(empty for no separator)"
          onChange={(e) => set('separator', e.currentTarget.value)}
        />
      </label>
    </div>
  );
}

function SplitEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ValueField
        value={(node.config.value as string) || ''}
        onChange={(v) => set('value', v)}
        help="JSONPath to the string to split."
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Separator
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.separator as string) ?? ','}
          placeholder=","
          onChange={(e) => set('separator', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Empty separator splits on every character.
        </p>
      </label>
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Max parts
          <span className="eyebrow">optional</span>
        </span>
        <input
          type="number"
          className="input w-full font-mono text-sm"
          value={(node.config.max as number) ?? 0}
          min={0}
          onChange={(e) => set('max', Number(e.currentTarget.value) || 0)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          0 = no limit. Useful when you only want the first N segments.
        </p>
      </label>
    </div>
  );
}

function ReplaceEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ValueField
        value={(node.config.value as string) || ''}
        onChange={(v) => set('value', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Pattern
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.pattern as string) || ''}
          placeholder="search text or regex"
          onChange={(e) => set('pattern', e.currentTarget.value)}
        />
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Replacement
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.replacement as string) || ''}
          placeholder="(empty to delete)"
          onChange={(e) => set('replacement', e.currentTarget.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
        <input
          type="checkbox"
          checked={node.config.all !== false}
          onChange={(e) => set('all', e.currentTarget.checked)}
        />
        Replace all occurrences
      </label>
      <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
        <input
          type="checkbox"
          checked={!!node.config.regex}
          onChange={(e) => set('regex', e.currentTarget.checked)}
        />
        Treat pattern as regular expression
      </label>
    </div>
  );
}

function TrimEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ValueField
        value={(node.config.value as string) || ''}
        onChange={(v) => set('value', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Side
        </span>
        <select
          className="input w-full"
          value={(node.config.side as string) || 'both'}
          onChange={(e) => set('side', e.currentTarget.value)}
        >
          <option value="both">Both ends</option>
          <option value="start">Start only</option>
          <option value="end">End only</option>
        </select>
      </label>
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Chars to strip
          <span className="eyebrow">optional</span>
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.chars as string) || ''}
          placeholder="(empty = whitespace)"
          onChange={(e) => set('chars', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          A string of characters; each one is stripped if present at the configured side(s).
        </p>
      </label>
    </div>
  );
}

function CaseEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ValueField
        value={(node.config.value as string) || ''}
        onChange={(v) => set('value', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Convert to
        </span>
        <select
          className="input w-full"
          value={(node.config.to as string) || 'lower'}
          onChange={(e) => set('to', e.currentTarget.value)}
        >
          <option value="upper">UPPER CASE</option>
          <option value="lower">lower case</option>
          <option value="title">Title Case</option>
          <option value="camel">camelCase</option>
          <option value="snake">snake_case</option>
          <option value="kebab">kebab-case</option>
        </select>
      </label>
    </div>
  );
}
