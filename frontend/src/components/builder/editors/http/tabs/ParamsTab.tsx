/*
 * ParamsTab — structured query params with a "Bulk edit" escape hatch for
 * pasting an existing `?a=1&b=2` string. Reuses KvRows for the structured
 * view; serialises both directions when toggled.
 */
import { useState } from 'react';
import KvRows from '../KvRows';
import type { HttpKvRow } from '../http.types';

interface Props {
  nodeId: string;
  rows: HttpKvRow[];
  onChange: (next: HttpKvRow[]) => void;
}

function rowsToQuery(rows: HttpKvRow[]): string {
  return rows
    .filter((r) => r.enabled !== false && r.key)
    .map((r) => `${encodeURIComponent(r.key)}=${encodeURIComponent(r.value ?? '')}`)
    .join('&');
}

function queryToRows(q: string): HttpKvRow[] {
  return q
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const k = eq < 0 ? pair : pair.slice(0, eq);
      const v = eq < 0 ? '' : pair.slice(eq + 1);
      try {
        return {
          enabled: true,
          key: decodeURIComponent(k.replace(/\+/g, ' ')),
          value: decodeURIComponent(v.replace(/\+/g, ' ')),
        };
      } catch {
        return { enabled: true, key: k, value: v };
      }
    });
}

export default function ParamsTab({ nodeId, rows, onChange }: Props) {
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState(() => rowsToQuery(rows));

  function commitBulk() {
    onChange(queryToRows(bulkText.trim()));
    setBulk(false);
  }

  if (bulk) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px] text-surface-500 dark:text-surface-400">
          Paste a query string (without the leading `?`). Values are URL-decoded
          on commit.
        </p>
        <textarea
          value={bulkText}
          onChange={(e) => setBulkText(e.currentTarget.value)}
          rows={5}
          spellCheck={false}
          className="input w-full font-mono text-xs"
          placeholder="limit=25&after={{$.steps.X.cursor}}"
          data-testid="http-params-bulk-textarea"
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => setBulk(false)}
            className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-surface-200 px-2 py-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commitBulk}
            className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-forge-500 hover:text-forge-700 dark:text-forge-400 dark:hover:text-forge-300 px-2 py-1"
            data-testid="http-params-bulk-commit"
          >
            Apply rows
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-surface-500 dark:text-surface-400">
          Query string parameters appended to the URL.
        </p>
        <button
          type="button"
          onClick={() => {
            setBulkText(rowsToQuery(rows));
            setBulk(true);
          }}
          className="font-mono text-[10px] uppercase tracking-[0.08em] text-surface-500 hover:text-forge-500 dark:text-surface-400 dark:hover:text-forge-400"
          data-testid="http-params-bulk-edit"
        >
          Bulk edit
        </button>
      </div>
      <KvRows
        nodeId={nodeId}
        rows={rows}
        onChange={onChange}
        keyPlaceholder="key"
        valuePlaceholder="value"
        testIdBase="http-params"
      />
    </div>
  );
}
