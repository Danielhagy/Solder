import type { EditorProps } from './_shared';

/**
 * Math group editor. Folded under the `Data` sidebar group but with a
 * distinct `kind` so dispatch and runtime stay clean.
 */
export default function MathEditor({ node, set }: EditorProps) {
  if (node.action === 'calc') return <CalcEditor node={node} set={set} />;
  if (node.action === 'round') return <RoundEditor node={node} set={set} />;
  return (
    <p className="text-sm text-surface-500 dark:text-surface-400">
      No editor for math.{node.action}.
    </p>
  );
}

function CalcEditor({ node, set }: EditorProps) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Expression
      </span>
      <textarea
        className="input w-full h-20 font-mono text-sm"
        value={(node.config.expression as string) || ''}
        placeholder="$.subtotal * 1.08 + $.shipping"
        onChange={(e) => set('expression', e.currentTarget.value)}
      />
      <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
        Four-function math + parentheses + JSONPath references. No code
        execution — operators only.
      </p>
    </label>
  );
}

function RoundEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Value
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.value as string) || ''}
          placeholder="$"
          onChange={(e) => set('value', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the number, or a literal.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Mode
        </span>
        <select
          className="input w-full"
          value={(node.config.mode as string) || 'round'}
          onChange={(e) => set('mode', e.currentTarget.value)}
        >
          <option value="round">Round (half-up)</option>
          <option value="ceil">Ceiling</option>
          <option value="floor">Floor</option>
          <option value="trunc">Truncate</option>
        </select>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Decimal places
        </span>
        <input
          type="number"
          className="input w-full font-mono text-sm"
          value={(node.config.places as number) ?? 0}
          min={0}
          onChange={(e) => set('places', Number(e.currentTarget.value) || 0)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          0 = nearest integer. 2 = currency style.
        </p>
      </label>
    </div>
  );
}
