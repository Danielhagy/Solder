import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

/**
 * State group editor — set/get integration variables, generate IDs,
 * roll random numbers. All `sandboxBehavior: 'identical'` — pure compute
 * or in-memory variable scope reads/writes.
 */
export default function StateEditor({ node, set }: EditorProps) {
  switch (node.action) {
    case 'set':
      return <SetEditor node={node} set={set} />;
    case 'get':
      return <GetEditor node={node} set={set} />;
    case 'ulid':
      return <UlidEditor node={node} set={set} />;
    case 'uuid':
      return <UuidEditor />;
    case 'random_int':
      return <RandomIntEditor node={node} set={set} />;
    case 'random_float':
      return <RandomFloatEditor node={node} set={set} />;
    default:
      return (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No editor for state.{node.action}.
        </p>
      );
  }
}

function NameField({
  value,
  onChange
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Variable name
      </span>
      <input
        type="text"
        className="input w-full font-mono text-sm"
        value={value}
        placeholder="vendor_id"
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
        Stored at <span className="font-mono">$.vars.&lt;name&gt;</span> for the rest of the run.
      </p>
    </label>
  );
}

function SetEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <NameField
        value={(node.config.name as string) || ''}
        onChange={(v) => set('name', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Value
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.value as string) || ''}
          onChange={(next) => set('value', next)}
          placeholder="$ or a literal"
          singleLine
          ariaLabel="State set value"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath into the upstream output, or any literal string / number / object.
        </p>
      </label>
    </div>
  );
}

function GetEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <NameField
        value={(node.config.name as string) || ''}
        onChange={(v) => set('name', v)}
      />
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Default
          <span className="eyebrow">optional</span>
        </span>
        <textarea
          className="input w-full h-20 font-mono text-sm"
          defaultValue={
            node.config.default === null || node.config.default === undefined
              ? ''
              : JSON.stringify(node.config.default, null, 2)
          }
          placeholder="(empty for null)"
          onBlur={(e) => {
            const text = e.currentTarget.value.trim();
            if (!text) {
              set('default', null);
              return;
            }
            try {
              set('default', JSON.parse(text));
            } catch {
              set('default', text);
            }
          }}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Returned when the variable hasn't been set. JSON literal or plain string.
        </p>
      </label>
    </div>
  );
}

function UlidEditor({ node, set }: EditorProps) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Prefix
        <span className="eyebrow">optional</span>
      </span>
      <input
        type="text"
        className="input w-full font-mono text-sm"
        value={(node.config.prefix as string) || ''}
        placeholder="po"
        onChange={(e) => set('prefix', e.currentTarget.value)}
      />
      <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
        Joined with an underscore — e.g. <span className="font-mono">po_01HQK…</span>. Leave empty for a bare ULID.
      </p>
    </label>
  );
}

function UuidEditor() {
  return (
    <p className="text-sm text-surface-500 dark:text-surface-400">
      Generates a fresh UUID v4 on every run. No options.
    </p>
  );
}

function RangeFields({
  min,
  max,
  seed,
  onMin,
  onMax,
  onSeed,
  step
}: {
  min: number;
  max: number;
  seed: string;
  onMin: (n: number) => void;
  onMax: (n: number) => void;
  onSeed: (s: string) => void;
  step?: number | 'any';
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Min
          </span>
          <input
            type="number"
            className="input w-full font-mono text-sm"
            value={min}
            step={step ?? 1}
            onChange={(e) => onMin(Number(e.currentTarget.value) || 0)}
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Max
          </span>
          <input
            type="number"
            className="input w-full font-mono text-sm"
            value={max}
            step={step ?? 1}
            onChange={(e) => onMax(Number(e.currentTarget.value) || 0)}
          />
        </label>
      </div>
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Seed
          <span className="eyebrow">optional</span>
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={seed}
          placeholder="(empty for non-deterministic)"
          onChange={(e) => onSeed(e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          When set, the same seed produces the same value across runs. Useful for tests.
        </p>
      </label>
    </div>
  );
}

function RandomIntEditor({ node, set }: EditorProps) {
  return (
    <RangeFields
      min={(node.config.min as number) ?? 0}
      max={(node.config.max as number) ?? 100}
      seed={(node.config.seed as string) || ''}
      onMin={(n) => set('min', n)}
      onMax={(n) => set('max', n)}
      onSeed={(s) => set('seed', s)}
    />
  );
}

function RandomFloatEditor({ node, set }: EditorProps) {
  return (
    <RangeFields
      min={(node.config.min as number) ?? 0}
      max={(node.config.max as number) ?? 1}
      seed={(node.config.seed as string) || ''}
      onMin={(n) => set('min', n)}
      onMax={(n) => set('max', n)}
      onSeed={(s) => set('seed', s)}
      step="any"
    />
  );
}
