import { useEffect, useState } from 'react';
import { api, type Integration } from '@/api/client';
import type { EditorProps } from './_shared';
import ReferenceField from './ReferenceField';

/**
 * Subprocess picker + iteration mode. Lazily loads the list of saved
 * subprocesses (integrations with `is_library=true`) on mount.
 */
export default function ProcessEditor({ node, set }: EditorProps) {
  const [subprocesses, setSubprocesses] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const targetId = (node.config.target_id as string) || '';
  const mode = (node.config.mode as string) || 'once';
  const over = (node.config.over as string) || '$.items';

  useEffect(() => {
    let alive = true;
    api
      .listSubprocesses()
      .then((list) => {
        if (alive) setSubprocesses(list);
      })
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
          Subprocess
        </span>
        <select
          className="input w-full"
          value={targetId}
          onChange={(e) => {
            const id = e.currentTarget.value;
            const picked = subprocesses.find((s) => s.id === id);
            set('target_id', id);
            set('target_name', picked?.name ?? '');
          }}
          disabled={loading}
          data-testid="process-call-target"
        >
          <option value="">{loading ? 'Loading…' : 'Pick a subprocess'}</option>
          {subprocesses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {!loading && subprocesses.length === 0 && (
          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
            No subprocesses yet. Save an integration with the "Library" toggle on to reuse it here.
          </p>
        )}
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Mode</span>
        <select
          className="input w-full"
          value={mode}
          onChange={(e) => set('mode', e.currentTarget.value)}
        >
          <option value="once">Run once</option>
          <option value="for-each">Run for each item</option>
        </select>
      </label>
      {mode === 'for-each' && (
        <label className="block">
          <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">
            Iterate over
          </span>
          <ReferenceField
            nodeId={node.id}
            value={over}
            onChange={(next) => set('over', next)}
            placeholder="$.items"
            singleLine
            ariaLabel="Subprocess iterate over"
          />
          <p className="text-xs text-surface-500 mt-1 dark:text-surface-400">
            JSONPath to an array. Each item is passed as input to the subprocess.
          </p>
        </label>
      )}
    </div>
  );
}
