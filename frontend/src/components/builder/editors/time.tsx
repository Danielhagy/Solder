import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

/**
 * Time group editor — Now, Parse, Format, Add duration, Diff. All
 * `sandboxBehavior: 'identical'` for now; if a future Sleep node lands
 * here, it'll declare `'no-op'` so sandbox runs don't burn iteration time.
 */
export default function TimeEditor({ node, set }: EditorProps) {
  switch (node.action) {
    case 'now':
      return <NowEditor node={node} set={set} />;
    case 'parse':
      return <ParseEditor node={node} set={set} />;
    case 'format':
      return <FormatDateEditor node={node} set={set} />;
    case 'add':
      return <AddDurationEditor node={node} set={set} />;
    case 'diff':
      return <DiffEditor node={node} set={set} />;
    default:
      return (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No editor for time.{node.action}.
        </p>
      );
  }
}

function ValueField({
  nodeId,
  label,
  value,
  onChange,
  help
}: {
  nodeId: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        {label}
      </span>
      <ReferenceField
        nodeId={nodeId}
        value={value}
        onChange={onChange}
        placeholder="$"
        singleLine
        ariaLabel={`Time ${label}`}
      />
      {help && (
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">{help}</p>
      )}
    </label>
  );
}

function TzField({
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
        Timezone
      </span>
      <input
        type="text"
        className="input w-full font-mono text-sm"
        value={value}
        placeholder="UTC"
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
        IANA name — e.g. <span className="font-mono">UTC</span>, <span className="font-mono">America/New_York</span>, <span className="font-mono">Europe/London</span>.
        {help ? ` ${help}` : ''}
      </p>
    </label>
  );
}

function NowEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Format
        </span>
        <select
          className="input w-full"
          value={(node.config.format as string) || 'iso'}
          onChange={(e) => set('format', e.currentTarget.value)}
        >
          <option value="iso">ISO 8601 string</option>
          <option value="unix">Unix seconds</option>
          <option value="unix_ms">Unix milliseconds</option>
        </select>
      </label>
      {((node.config.format as string) || 'iso') === 'iso' && (
        <TzField
          value={(node.config.tz as string) || 'UTC'}
          onChange={(v) => set('tz', v)}
        />
      )}
    </div>
  );
}

function ParseEditor({ node, set }: EditorProps) {
  const formats = (node.config.formats as string[]) || [];
  const csv = formats.join(', ');
  return (
    <div className="space-y-3">
      <ValueField
        nodeId={node.id}
        label="Input"
        value={(node.config.value as string) || ''}
        onChange={(v) => set('value', v)}
        help="JSONPath to the date string to parse."
      />
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Allowed formats
          <span className="eyebrow">optional</span>
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={csv}
          placeholder="YYYY-MM-DD, MM/DD/YYYY"
          onChange={(e) => {
            const next = e.currentTarget.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            set('formats', next);
          }}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Comma-separated. Tried in order. Empty list = auto-detect (ISO, RFC2822).
        </p>
      </label>
      <TzField
        value={(node.config.assume_tz as string) || 'UTC'}
        onChange={(v) => set('assume_tz', v)}
        help="Used when the input has no zone offset."
      />
    </div>
  );
}

function FormatDateEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ValueField
        nodeId={node.id}
        label="Input"
        value={(node.config.value as string) || ''}
        onChange={(v) => set('value', v)}
        help="JSONPath to the ISO timestamp."
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Format
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={(node.config.format as string) || 'YYYY-MM-DD'}
          placeholder="YYYY-MM-DD"
          onChange={(e) => set('format', e.currentTarget.value)}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Tokens: <span className="font-mono">YYYY MM DD HH mm ss</span>. Anything else passes through verbatim.
        </p>
      </label>
      <TzField
        value={(node.config.tz as string) || 'UTC'}
        onChange={(v) => set('tz', v)}
        help="Output is rendered in this zone."
      />
    </div>
  );
}

function AddDurationEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ValueField
        nodeId={node.id}
        label="From"
        value={(node.config.value as string) || ''}
        onChange={(v) => set('value', v)}
        help="JSONPath to the ISO timestamp to shift."
      />
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Amount
          </span>
          <input
            type="number"
            className="input w-full font-mono text-sm"
            value={(node.config.amount as number) ?? 0}
            onChange={(e) => set('amount', Number(e.currentTarget.value) || 0)}
          />
          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
            Negative shifts back in time.
          </p>
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Unit
          </span>
          <select
            className="input w-full"
            value={(node.config.unit as string) || 'days'}
            onChange={(e) => set('unit', e.currentTarget.value)}
          >
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
            <option value="months">Months</option>
            <option value="years">Years</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function DiffEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <ValueField
        nodeId={node.id}
        label="A"
        value={(node.config.a as string) || ''}
        onChange={(v) => set('a', v)}
        help="JSONPath to the first ISO timestamp."
      />
      <ValueField
        nodeId={node.id}
        label="B"
        value={(node.config.b as string) || ''}
        onChange={(v) => set('b', v)}
        help="JSONPath to the second ISO timestamp. Result is A − B."
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Unit
        </span>
        <select
          className="input w-full"
          value={(node.config.unit as string) || 'days'}
          onChange={(e) => set('unit', e.currentTarget.value)}
        >
          <option value="seconds">Seconds</option>
          <option value="minutes">Minutes</option>
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
      </label>
    </div>
  );
}
