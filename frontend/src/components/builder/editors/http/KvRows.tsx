/*
 * KvRows — reusable key/value row list used by the HTTP editor's
 * Params, Headers, and Form-body tabs.
 *
 * Each row: [enable dot] [key input] [value ReferenceField] [drag handle] [✕]
 * - The enable dot lets users stage rows without losing them (Postman parity).
 * - The value field is a ReferenceField so `{{$.…}}` chips work everywhere.
 * - Drag handle reorders via HTML5 native DnD — no new dep.
 *
 * Callers pass the current rows + an onChange that receives the full new array.
 * The list always renders a trailing "blank" row hint via the `+ Add row` button.
 */
import { useState } from 'react';
import ReferenceField from '../ReferenceField';
import type { HttpKvRow } from './http.types';

export interface KvRowsProps {
  nodeId: string;
  rows: HttpKvRow[];
  onChange: (next: HttpKvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** When true, the leading row is read-only and rendered with a forge-tint
   *  + padlock to signal "managed by the Connection" (Headers tab uses this
   *  to show the inherited Authorization without persisting it). */
  managedFirstRow?: HttpKvRow & { managedReason?: string };
  /** Optional row of suggested keys (header names, common params). The
   *  key input becomes a datalist combo. */
  keySuggestions?: string[];
  testIdBase?: string;
}

export default function KvRows({
  nodeId,
  rows,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  managedFirstRow,
  keySuggestions,
  testIdBase,
}: KvRowsProps) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const datalistId = keySuggestions && keySuggestions.length > 0
    ? `${testIdBase ?? 'kv'}-suggestions`
    : undefined;

  function patch(idx: number, partial: Partial<HttpKvRow>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...partial } : r)));
  }

  function add() {
    onChange([...rows, { enabled: true, key: '', value: '' }]);
  }

  function remove(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = rows.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {managedFirstRow && (
        <ManagedRow row={managedFirstRow} />
      )}

      {rows.length === 0 && !managedFirstRow && (
        <div className="text-[11px] font-mono text-surface-500 dark:text-surface-500 px-1 py-2">
          no entries — click + Add row below
        </div>
      )}

      {rows.map((row, idx) => {
        const isDropTarget = dragOver === idx && dragIdx !== null && dragIdx !== idx;
        const isDragging = dragIdx === idx;
        return (
          <div
            key={idx}
            className={[
              'grid items-center gap-2 rounded px-1.5 py-1',
              isDropTarget
                ? 'bg-forge-500/[0.08] ring-1 ring-forge-500/40'
                : 'hover:bg-surface-50/40 dark:hover:bg-surface-800/30',
              isDragging ? 'opacity-50' : '',
              !row.enabled ? 'opacity-60' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ gridTemplateColumns: 'auto 1fr 1.4fr auto auto' }}
            data-testid={testIdBase ? `${testIdBase}-row-${idx}` : undefined}
            onDragOver={(e) => {
              if (dragIdx === null) return;
              e.preventDefault();
              setDragOver(idx);
            }}
            onDrop={(e) => {
              if (dragIdx === null) return;
              e.preventDefault();
              reorder(dragIdx, idx);
              setDragIdx(null);
              setDragOver(null);
            }}
          >
            <button
              type="button"
              onClick={() => patch(idx, { enabled: !row.enabled })}
              aria-label={row.enabled ? 'Disable row' : 'Enable row'}
              title={row.enabled ? 'Click to disable' : 'Click to enable'}
              className={[
                'w-3 h-3 rounded-full transition-colors',
                row.enabled
                  ? 'bg-forge-500'
                  : 'bg-surface-300 dark:bg-surface-700 ring-1 ring-inset ring-surface-400 dark:ring-surface-600',
              ].join(' ')}
            />
            <input
              type="text"
              value={row.key}
              onChange={(e) => patch(idx, { key: e.currentTarget.value })}
              placeholder={keyPlaceholder}
              list={datalistId}
              spellCheck={false}
              className="input w-full font-mono text-xs py-1"
              data-testid={testIdBase ? `${testIdBase}-key-${idx}` : undefined}
            />
            <ReferenceField
              nodeId={nodeId}
              value={row.value}
              onChange={(v) => patch(idx, { value: v })}
              placeholder={valuePlaceholder}
              singleLine
              ariaLabel={`${row.key || keyPlaceholder} value`}
              testId={testIdBase ? `${testIdBase}-value-${idx}` : undefined}
            />
            <button
              type="button"
              draggable
              onDragStart={() => setDragIdx(idx)}
              onDragEnd={() => {
                setDragIdx(null);
                setDragOver(null);
              }}
              aria-label="Drag to reorder"
              title="Drag to reorder"
              className="text-surface-400 hover:text-surface-700 dark:text-surface-500 dark:hover:text-surface-300 cursor-grab active:cursor-grabbing px-1 select-none text-sm"
            >
              ⋮⋮
            </button>
            <button
              type="button"
              onClick={() => remove(idx)}
              aria-label="Delete row"
              title="Delete row"
              className="text-surface-400 hover:text-rose-500 dark:text-surface-500 dark:hover:text-rose-400 px-1"
            >
              ✕
            </button>
          </div>
        );
      })}

      {datalistId && (
        <datalist id={datalistId}>
          {keySuggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}

      <button
        type="button"
        onClick={add}
        className="self-start mt-1 text-[11px] font-mono uppercase tracking-[0.08em] text-surface-500 hover:text-forge-500 dark:text-surface-400 dark:hover:text-forge-400 transition-colors"
        data-testid={testIdBase ? `${testIdBase}-add` : undefined}
      >
        + Add row
      </button>
    </div>
  );
}

function ManagedRow({
  row,
}: {
  row: HttpKvRow & { managedReason?: string };
}) {
  return (
    <div
      className="grid items-center gap-2 rounded px-1.5 py-1 bg-forge-500/[0.06] ring-1 ring-forge-500/30"
      style={{ gridTemplateColumns: 'auto 1fr 1.4fr auto auto' }}
      title={row.managedReason ?? 'Managed by the bound Connection.'}
    >
      <span
        aria-hidden="true"
        className="w-3 h-3 rounded-full bg-forge-500"
      />
      <div className="font-mono text-xs text-forge-700 dark:text-forge-300 truncate">
        {row.key}
      </div>
      <div className="font-mono text-xs text-forge-700 dark:text-forge-300 truncate flex items-center gap-1.5">
        <span aria-hidden="true">🔒</span>
        <span>{row.value}</span>
      </div>
      <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-forge-600 dark:text-forge-300 px-1">
        managed
      </span>
      <span className="w-3" />
    </div>
  );
}
