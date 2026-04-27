import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

/**
 * Format group editor. Each Format node converts between data shapes
 * (JSON↔CSV, base64, URL escapes, hashes). All are pure compute —
 * `sandboxBehavior: 'identical'` — so the editors stay simple.
 *
 * Frontend-only at this wave; backend executors pending.
 */
export default function FormatEditor({ node, set }: EditorProps) {
  switch (node.action) {
    case 'json_to_csv':
      return <JsonToCsvEditor node={node} set={set} />;
    case 'csv_to_json':
      return <CsvToJsonEditor node={node} set={set} />;
    case 'base64_encode':
      return <Base64EncodeEditor node={node} set={set} />;
    case 'base64_decode':
      return <Base64DecodeEditor node={node} set={set} />;
    case 'url_encode':
      return <UrlEncodeEditor node={node} set={set} />;
    case 'url_decode':
      return <UrlDecodeEditor node={node} set={set} />;
    case 'hash':
      return <HashEditor node={node} set={set} />;
    default:
      return (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No editor for format.{node.action}.
        </p>
      );
  }
}

/** Shared "where does the input come from" path field. */
function PathField({
  nodeId,
  label,
  value,
  onChange,
  placeholder,
  help
}: {
  nodeId: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
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
        placeholder={placeholder ?? '$'}
        singleLine
        ariaLabel={`Format ${label}`}
      />
      {help && (
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">{help}</p>
      )}
    </label>
  );
}

function JsonToCsvEditor({ node, set }: EditorProps) {
  const cols = (node.config.columns as string[]) || [];
  const csvCols = cols.join(', ');
  return (
    <div className="space-y-3">
      <PathField
        nodeId={node.id}
        label="Over"
        value={(node.config.over as string) || ''}
        onChange={(v) => set('over', v)}
        placeholder="$.items"
        help="JSONPath to the array of objects to serialise."
      />
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Columns
          <span className="eyebrow">optional</span>
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={csvCols}
          placeholder="id, name, email"
          onChange={(e) => {
            const next = e.currentTarget.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            set('columns', next);
          }}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Comma-separated column names + order. Leave empty to use the union of keys from the first row.
        </p>
      </label>
      <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
        <input
          type="checkbox"
          checked={node.config.header !== false}
          onChange={(e) => set('header', e.currentTarget.checked)}
        />
        Include header row
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Delimiter
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          maxLength={2}
          value={(node.config.delimiter as string) || ','}
          onChange={(e) => set('delimiter', e.currentTarget.value || ',')}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Usually <span className="font-mono">,</span> · also common: <span className="font-mono">;</span>, <span className="font-mono">\t</span>.
        </p>
      </label>
    </div>
  );
}

function CsvToJsonEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <PathField
        nodeId={node.id}
        label="CSV input"
        value={(node.config.csv as string) || ''}
        onChange={(v) => set('csv', v)}
        placeholder="$"
        help="JSONPath to the CSV string."
      />
      <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
        <input
          type="checkbox"
          checked={node.config.has_header !== false}
          onChange={(e) => set('has_header', e.currentTarget.checked)}
        />
        First row is the header
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Delimiter
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          maxLength={2}
          value={(node.config.delimiter as string) || ','}
          onChange={(e) => set('delimiter', e.currentTarget.value || ',')}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
        <input
          type="checkbox"
          checked={!!node.config.type_coerce}
          onChange={(e) => set('type_coerce', e.currentTarget.checked)}
        />
        Coerce numbers + booleans
        <span className="eyebrow">optional</span>
      </label>
    </div>
  );
}

function Base64EncodeEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <PathField
        nodeId={node.id}
        label="Data"
        value={(node.config.data as string) || ''}
        onChange={(v) => set('data', v)}
        help="JSONPath to the string or bytes to encode."
      />
      <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
        <input
          type="checkbox"
          checked={!!node.config.url_safe}
          onChange={(e) => set('url_safe', e.currentTarget.checked)}
        />
        URL-safe alphabet
        <span className="eyebrow">RFC 4648 §5</span>
      </label>
    </div>
  );
}

function Base64DecodeEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <PathField
        nodeId={node.id}
        label="Data"
        value={(node.config.data as string) || ''}
        onChange={(v) => set('data', v)}
        help="JSONPath to the base64 string."
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Output as
        </span>
        <select
          className="input w-full"
          value={(node.config.as as string) || 'string'}
          onChange={(e) => set('as', e.currentTarget.value)}
        >
          <option value="string">String (UTF-8)</option>
          <option value="bytes">Bytes</option>
        </select>
      </label>
    </div>
  );
}

function UrlEncodeEditor({ node, set }: EditorProps) {
  const componentMode = node.config.component !== false;
  return (
    <div className="space-y-3">
      <PathField
        nodeId={node.id}
        label="Data"
        value={(node.config.data as string) || ''}
        onChange={(v) => set('data', v)}
        help="JSONPath to the string to percent-escape."
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Mode
        </span>
        <select
          className="input w-full"
          value={componentMode ? 'component' : 'full'}
          onChange={(e) => set('component', e.currentTarget.value === 'component')}
        >
          <option value="component">Component (encodeURIComponent)</option>
          <option value="full">Full URL (encodeURI)</option>
        </select>
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Component escapes <span className="font-mono">/?#&amp;=</span> too — use it for query values. Full URL preserves them.
        </p>
      </label>
    </div>
  );
}

function UrlDecodeEditor({ node, set }: EditorProps) {
  return (
    <PathField
      nodeId={node.id}
      label="Data"
      value={(node.config.data as string) || ''}
      onChange={(v) => set('data', v)}
      help="JSONPath to the percent-encoded string."
    />
  );
}

function HashEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <PathField
        nodeId={node.id}
        label="Data"
        value={(node.config.data as string) || ''}
        onChange={(v) => set('data', v)}
        help="JSONPath to the string or bytes to hash."
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Algorithm
        </span>
        <select
          className="input w-full"
          value={(node.config.algo as string) || 'sha256'}
          onChange={(e) => set('algo', e.currentTarget.value)}
        >
          <option value="md5">md5 (insecure — checksums only)</option>
          <option value="sha1">sha1 (insecure — checksums only)</option>
          <option value="sha256">sha256</option>
          <option value="sha512">sha512</option>
        </select>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Output encoding
        </span>
        <select
          className="input w-full"
          value={(node.config.output as string) || 'hex'}
          onChange={(e) => set('output', e.currentTarget.value)}
        >
          <option value="hex">Hex</option>
          <option value="base64">Base64</option>
        </select>
      </label>
    </div>
  );
}
