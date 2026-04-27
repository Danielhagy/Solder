import { useId, useState } from 'react';
import Select from '@/components/Select';

/**
 * JsonBuilder — recursive structured editor for arbitrary JSON values.
 *
 * Used by the trigger editor's "test sample" section so users can shape
 * the payload their integration runs against without writing raw JSON.
 * Each level renders a `+ Add field` (object) or `+ Add item` (array)
 * affordance; the type of each leaf is selectable (string / number /
 * boolean / null / object / array). Shape switches preserve content
 * where possible (string ↔ number coerces; switching to object/array
 * resets to `{}`/`[]`).
 *
 * Design notes:
 *   - Pure controlled component — no internal value state. Parent owns
 *     the value; we call `onChange(next)` on every mutation.
 *   - Add buttons live INSIDE the container they create entries for —
 *     no global "add" floating somewhere ambiguous.
 *   - Object key inputs commit on blur (or Enter); typing in the middle
 *     of an object doesn't re-key on every keystroke (would lose focus
 *     when the parent re-renders with the new map).
 */

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

function kindOf(v: unknown): ValueKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

function defaultForKind(k: ValueKind): JsonValue {
  switch (k) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'object':
      return {};
    case 'array':
      return [];
  }
}

/** Coerce when sensible; otherwise reset to the kind's default. */
function coerce(v: unknown, to: ValueKind): JsonValue {
  const from = kindOf(v);
  if (from === to) return v as JsonValue;
  if (to === 'string') return String(v ?? '');
  if (to === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (to === 'boolean') return Boolean(v);
  return defaultForKind(to);
}

interface Props {
  value: JsonValue;
  onChange: (next: JsonValue) => void;
  /** Hide the root-level kind selector; useful when the caller fixes the
   *  shape (e.g. the test sample for `manual` is always an object). */
  fixedRootKind?: ValueKind;
  /** Compact mode — smaller fonts, denser spacing. */
  compact?: boolean;
}

export default function JsonBuilder({ value, onChange, fixedRootKind, compact }: Props) {
  return (
    <div className={compact ? 'text-xs' : 'text-sm'}>
      <ValueNode
        value={value}
        onChange={onChange}
        fixedKind={fixedRootKind}
        depth={0}
      />
    </div>
  );
}

interface ValueNodeProps {
  value: JsonValue;
  onChange: (next: JsonValue) => void;
  /** When set, the user can't change the kind at this slot. */
  fixedKind?: ValueKind;
  depth: number;
}

function ValueNode({ value, onChange, fixedKind, depth }: ValueNodeProps) {
  const kind = fixedKind ?? kindOf(value);

  return (
    <div className="space-y-2">
      {!fixedKind && (
        <KindSelect
          value={kind}
          onChange={(k) => onChange(coerce(value, k))}
        />
      )}
      {kind === 'string' && (
        <input
          type="text"
          className="input w-full font-mono text-xs"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder="(empty string)"
        />
      )}
      {kind === 'number' && (
        <input
          type="number"
          className="input w-full font-mono text-xs"
          value={typeof value === 'number' ? value : 0}
          onChange={(e) => {
            const n = Number(e.currentTarget.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
        />
      )}
      {kind === 'boolean' && (
        <Select
          value={value ? 'true' : 'false'}
          onChange={(v) => onChange(v === 'true')}
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
          size="sm"
          width="100%"
          ariaLabel="Boolean value"
        />
      )}
      {kind === 'null' && (
        <div className="text-[11px] font-mono text-surface-400 px-2 py-1 rounded-md bg-surface-50 dark:bg-surface-900/60 dark:text-surface-500">
          null
        </div>
      )}
      {kind === 'object' && (
        <ObjectNode
          value={(value && typeof value === 'object' && !Array.isArray(value)) ? value as { [k: string]: JsonValue } : {}}
          onChange={onChange}
          depth={depth + 1}
        />
      )}
      {kind === 'array' && (
        <ArrayNode
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

function KindSelect({
  value,
  onChange,
}: {
  value: ValueKind;
  onChange: (k: ValueKind) => void;
}) {
  return (
    <Select
      value={value}
      onChange={(v) => onChange(v as ValueKind)}
      options={[
        { value: 'string', label: 'string' },
        { value: 'number', label: 'number' },
        { value: 'boolean', label: 'boolean' },
        { value: 'null', label: 'null' },
        { value: 'object', label: 'object' },
        { value: 'array', label: 'array' },
      ]}
      size="sm"
      width="100%"
      ariaLabel="Value kind"
      testid="json-kind-select"
    />
  );
}

function ObjectNode({
  value,
  onChange,
  depth,
}: {
  value: { [k: string]: JsonValue };
  onChange: (v: { [k: string]: JsonValue }) => void;
  depth: number;
}) {
  // Preserve key insertion order — JS object iteration honours it for
  // string keys. We rebuild the object after each mutation so the user
  // can re-key freely without us swapping siblings around.
  const entries = Object.entries(value);

  function setKey(oldKey: string, newKey: string) {
    if (oldKey === newKey || !newKey.trim()) return;
    if (newKey in value && newKey !== oldKey) {
      // Don't silently overwrite a sibling — beep visually by no-op'ing.
      return;
    }
    const next: { [k: string]: JsonValue } = {};
    for (const [k, v] of entries) next[k === oldKey ? newKey : k] = v;
    onChange(next);
  }

  function setEntryValue(k: string, v: JsonValue) {
    onChange({ ...value, [k]: v });
  }

  function removeEntry(k: string) {
    const { [k]: _, ...rest } = value;
    void _;
    onChange(rest);
  }

  function addField() {
    // Pick a free default name — `field`, `field_2`, etc.
    let i = 1;
    let name = 'field';
    while (name in value) {
      i++;
      name = `field_${i}`;
    }
    onChange({ ...value, [name]: '' });
  }

  return (
    <div className={`pl-3 border-l border-surface-200 dark:border-surface-800 ${depth > 1 ? 'ml-1' : ''}`}>
      {entries.length === 0 ? (
        <p className="text-[11px] font-mono text-surface-400 dark:text-surface-500 py-1">
          (empty object)
        </p>
      ) : (
        <ul className="divide-y divide-surface-200/70 dark:divide-surface-800/70">
          {entries.map(([k, v], i) => (
            <li key={k} className="py-2.5 first:pt-1 last:pb-1">
              <ObjectRow
                index={i}
                entryKey={k}
                entryValue={v}
                onKeyChange={(nk) => setKey(k, nk)}
                onValueChange={(nv) => setEntryValue(k, nv)}
                onRemove={() => removeEntry(k)}
                depth={depth}
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={addField}
        className="mt-2 text-[11px] font-mono text-surface-500 hover:text-forge-600 transition-colors px-2 py-1 rounded-md hover:bg-forge-500/[0.06] dark:text-surface-400 dark:hover:text-forge-400"
        data-testid="json-add-field"
      >
        + Add field
      </button>
    </div>
  );
}

function ObjectRow({
  index,
  entryKey,
  entryValue,
  onKeyChange,
  onValueChange,
  onRemove,
  depth,
}: {
  index: number;
  entryKey: string;
  entryValue: JsonValue;
  onKeyChange: (k: string) => void;
  onValueChange: (v: JsonValue) => void;
  onRemove: () => void;
  depth: number;
}) {
  // Local state for the key so the user can type freely without each
  // keystroke re-rendering the object map (which would steal focus).
  // Commit on blur or Enter.
  const [localKey, setLocalKey] = useState(entryKey);
  const inputId = useId();

  function commitKey() {
    if (localKey !== entryKey) onKeyChange(localKey || entryKey);
  }

  // Ordinal indicator (01, 02, …) — keeps adjacent rows visually distinct
  // when the user adds a stack of fields. Mono-tabular so widths stay
  // aligned across rows when row count crosses the 09→10 boundary.
  const ord = String(index + 1).padStart(2, '0');

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span
          className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500 select-none w-5 flex-shrink-0"
          aria-hidden="true"
        >
          {ord}
        </span>
        <input
          id={inputId}
          type="text"
          className="flex-1 input font-mono text-xs py-1"
          value={localKey}
          onChange={(e) => setLocalKey(e.currentTarget.value)}
          onBlur={commitKey}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitKey();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          data-testid={`json-key-${entryKey}`}
          aria-label={`Field ${ord} key`}
        />
        <button
          type="button"
          onClick={onRemove}
          className="text-surface-400 hover:text-rose-500 text-sm leading-none px-1 flex-shrink-0"
          aria-label={`Remove field ${entryKey}`}
          data-testid={`json-remove-${entryKey}`}
        >
          ×
        </button>
      </div>
      <div className="pl-7">
        {/* Indent the value under the key/index so eye stays on the row's column. */}
        <ValueNode value={entryValue} onChange={onValueChange} depth={depth} />
      </div>
    </div>
  );
}

function ArrayNode({
  value,
  onChange,
  depth,
}: {
  value: JsonValue[];
  onChange: (v: JsonValue[]) => void;
  depth: number;
}) {
  function setItem(i: number, v: JsonValue) {
    const next = [...value];
    next[i] = v;
    onChange(next);
  }

  function removeItem(i: number) {
    onChange(value.filter((_, j) => j !== i));
  }

  function addItem() {
    onChange([...value, '']);
  }

  return (
    <div className={`pl-3 border-l border-surface-200 dark:border-surface-800 ${depth > 1 ? 'ml-1' : ''}`}>
      {value.length === 0 ? (
        <p className="text-[11px] font-mono text-surface-400 dark:text-surface-500 py-1">
          (empty array)
        </p>
      ) : (
        <ul className="divide-y divide-surface-200/70 dark:divide-surface-800/70">
          {value.map((item, i) => (
            <li key={i} className="py-2.5 first:pt-1 last:pb-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <span
                  className="text-[10px] font-mono tabular-nums text-surface-400 dark:text-surface-500 select-none w-5 flex-shrink-0"
                  aria-hidden="true"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-[11px] font-mono text-surface-500 dark:text-surface-400">
                  [{i}]
                </span>
                <button
                  type="button"
                  onClick={() => removeItem(i)}
                  className="text-surface-400 hover:text-rose-500 text-sm leading-none px-1 ml-auto flex-shrink-0"
                  aria-label={`Remove item ${i}`}
                  data-testid={`json-remove-array-${i}`}
                >
                  ×
                </button>
              </div>
              <div className="pl-7">
                <ValueNode value={item} onChange={(v) => setItem(i, v)} depth={depth} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={addItem}
        className="mt-2 text-[11px] font-mono text-surface-500 hover:text-forge-600 transition-colors px-2 py-1 rounded-md hover:bg-forge-500/[0.06] dark:text-surface-400 dark:hover:text-forge-400"
        data-testid="json-add-item"
      >
        + Add item
      </button>
    </div>
  );
}
