import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

/**
 * Data group editor. Dispatches by `node.action`. All Data nodes share an
 * `over` path (the array they operate on, default `$`) plus action-specific
 * tail config (predicate, key, fields list, mapping).
 *
 * Frontend-only at this wave — runtime executors are pending. Saved
 * integrations using these nodes will fail at run time until the backend
 * wave lands.
 */
export default function DataEditor({ node, set }: EditorProps) {
  switch (node.action) {
    case 'filter':
      return <FilterEditor node={node} set={set} />;
    case 'sort':
      return <SortEditor node={node} set={set} />;
    case 'unique':
      return <UniqueEditor node={node} set={set} />;
    case 'pick':
      return <PickEditor node={node} set={set} />;
    case 'omit':
      return <OmitEditor node={node} set={set} />;
    case 'rename':
      return <RenameEditor node={node} set={set} />;
    case 'ingest_to_bank':
      return <IngestToBankEditor node={node} set={set} />;
    default:
      return (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No editor for data.{node.action}.
        </p>
      );
  }
}

function IngestToBankEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Entity type
        </span>
        <input
          type="text"
          value={(node.config.entity_type as string) || ''}
          onChange={(e) => set('entity_type', e.target.value)}
          placeholder="contact"
          className="w-full px-3 py-2 border border-surface-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-forge-500 dark:bg-surface-900/50 dark:border-surface-800 dark:text-surface-100"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Discriminator on the bank row. Match the connector's entity_type
          (e.g. <span className="font-mono">contact</span>,{' '}
          <span className="font-mono">company</span>) so the mock-engine can
          serve them on subsequent sandbox runs.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Items path
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.items_path as string) || ''}
          onChange={(v) => set('items_path', v)}
          placeholder="$ (whole input)"
          singleLine
          ariaLabel="Items path"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the array of records. Leave empty to ingest the whole
          upstream payload (already an array).
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          ID path
        </span>
        <input
          type="text"
          value={(node.config.id_path as string) || ''}
          onChange={(e) => set('id_path', e.target.value)}
          placeholder="$.id"
          className="w-full px-3 py-2 border border-surface-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-forge-500 dark:bg-surface-900/50 dark:border-surface-800 dark:text-surface-100"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Path inside each record that yields the entity id. Defaults to{' '}
          <span className="font-mono">$.id</span>.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Connector name <span className="text-surface-400">(optional)</span>
        </span>
        <input
          type="text"
          value={(node.config.connector_name as string) || ''}
          onChange={(e) => set('connector_name', e.target.value)}
          placeholder="hubspot"
          className="w-full px-3 py-2 border border-surface-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-forge-500 dark:bg-surface-900/50 dark:border-surface-800 dark:text-surface-100"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Which test bank to write into. Defaults to the integration's first
          existing bank, or auto-creates one if none exist.
        </p>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(node.config.replace)}
          onChange={(e) => set('replace', e.target.checked)}
          className="rounded border-surface-300 text-forge-600 focus:ring-forge-500"
        />
        <span className="text-sm text-surface-700 dark:text-surface-200">
          Replace existing rows of this entity_type before insert
        </span>
      </label>
    </div>
  );
}

/** Shared "iterate over" input — every Data node operates on an array. */
function OverField({
  nodeId,
  value,
  onChange
}: {
  nodeId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
        Over
      </span>
      <ReferenceField
        nodeId={nodeId}
        value={value}
        onChange={onChange}
        placeholder="$.items"
        singleLine
        ariaLabel="Data over"
      />
      <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
        JSONPath to the array. <span className="font-mono">$</span> = whole input.
      </p>
    </label>
  );
}

function FilterEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <OverField
        nodeId={node.id}
        value={(node.config.over as string) || ''}
        onChange={(v) => set('over', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Predicate
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.expression as string) || ''}
          onChange={(next) => set('expression', next)}
          placeholder='$.status == "active"'
          rows={3}
          ariaLabel="Filter predicate"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          Evaluated per item. Truthy keeps the item; falsy drops it.
        </p>
      </label>
    </div>
  );
}

function SortEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <OverField
        nodeId={node.id}
        value={(node.config.over as string) || ''}
        onChange={(v) => set('over', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          By
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.by as string) || ''}
          onChange={(next) => set('by', next)}
          placeholder="$.created_at"
          singleLine
          ariaLabel="Sort by"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the field to sort by. Leave empty to sort items as scalars.
        </p>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Order
        </span>
        <select
          className="input w-full"
          value={(node.config.order as string) || 'asc'}
          onChange={(e) => set('order', e.currentTarget.value)}
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </label>
    </div>
  );
}

function UniqueEditor({ node, set }: EditorProps) {
  return (
    <div className="space-y-3">
      <OverField
        nodeId={node.id}
        value={(node.config.over as string) || ''}
        onChange={(v) => set('over', v)}
      />
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          By
          <span className="eyebrow">optional</span>
        </span>
        <ReferenceField
          nodeId={node.id}
          value={(node.config.by as string) || ''}
          onChange={(next) => set('by', next)}
          placeholder="$.id"
          singleLine
          ariaLabel="Unique by"
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSONPath to the field that defines uniqueness. Empty = full-item equality.
        </p>
      </label>
    </div>
  );
}

function PickEditor({ node, set }: EditorProps) {
  return (
    <FieldsListEditor
      node={node}
      set={set}
      label="Fields to keep"
      placeholder="id, name, email"
      help="Comma-separated list. Each field in this list is kept on every item; everything else is dropped."
    />
  );
}

function OmitEditor({ node, set }: EditorProps) {
  return (
    <FieldsListEditor
      node={node}
      set={set}
      label="Fields to drop"
      placeholder="internal_notes, debug_info"
      help="Comma-separated list. Each field in this list is removed from every item; everything else passes through."
    />
  );
}

function FieldsListEditor({
  node,
  set,
  label,
  placeholder,
  help
}: EditorProps & { label: string; placeholder: string; help: string }) {
  // Stored as string[] in config; rendered as a CSV string for ease of typing.
  // Round-trips on every change so the canonical shape stays the array.
  const fields = (node.config.fields as string[]) || [];
  const csv = fields.join(', ');
  return (
    <div className="space-y-3">
      <OverField
        nodeId={node.id}
        value={(node.config.over as string) || ''}
        onChange={(v) => set('over', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          {label}
        </span>
        <input
          type="text"
          className="input w-full font-mono text-sm"
          value={csv}
          placeholder={placeholder}
          onChange={(e) => {
            const next = e.currentTarget.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            set('fields', next);
          }}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">{help}</p>
      </label>
    </div>
  );
}

function RenameEditor({ node, set }: EditorProps) {
  // Stored as `{ from: to }`. Rendered as a JSON textarea so users can edit
  // the full mapping at once. Round-trips on blur so partial typing doesn't
  // wipe state.
  const mapping = (node.config.mapping as Record<string, string>) || {};
  return (
    <div className="space-y-3">
      <OverField
        nodeId={node.id}
        value={(node.config.over as string) || ''}
        onChange={(v) => set('over', v)}
      />
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Rename mapping
        </span>
        <textarea
          className="input w-full h-28 font-mono text-sm"
          defaultValue={JSON.stringify(mapping, null, 2)}
          placeholder={'{"old_name": "new_name"}'}
          onBlur={(e) => {
            const text = e.currentTarget.value.trim();
            if (!text) {
              set('mapping', {});
              return;
            }
            try {
              const parsed = JSON.parse(text);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                set('mapping', parsed);
              }
            } catch {
              /* keep previous value until valid JSON */
            }
          }}
        />
        <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
          JSON object: keys are source field names, values are target names.
        </p>
      </label>
    </div>
  );
}
