import type { EditorProps } from './_shared';

export default function OutputEditor({ node, set }: EditorProps) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Output Mapping</span>
      <textarea
        className="input w-full h-32 font-mono text-sm"
        defaultValue={JSON.stringify(node.config.mapping ?? {}, null, 2)}
        placeholder={'{"result": "$.data"}'}
        onBlur={(e) => {
          try {
            set('mapping', JSON.parse(e.currentTarget.value));
          } catch {
            /* ignore invalid JSON */
          }
        }}
      />
    </label>
  );
}
