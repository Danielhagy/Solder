import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

export default function TransformEditor({ node, set }: EditorProps) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Expression
      </span>
      <ReferenceField
        nodeId={node.id}
        value={(node.config.expression as string) || ''}
        onChange={(next) => set('expression', next)}
        placeholder="$.data.items"
        rows={4}
        ariaLabel="Transform expression"
      />
      <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
        JSONPath (e.g. <span className="font-mono">$.data.items</span>) or
        template syntax. Type <span className="font-mono">{'{'}</span> or
        click <span className="font-mono">{'{·}'}</span> to insert a
        reference to a previous step's output.
      </p>
    </label>
  );
}
