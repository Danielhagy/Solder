import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import { inferSchema, type InferredField } from './infer-schema';

/**
 * Resolves a step's reference schema from an actual past run.
 *
 * The reference picker asks "what fields does this step's output
 * have?". The static catalog answer is hand-authored and incomplete;
 * the runtime answer is whatever the latest successful run actually
 * produced. This hook prefers the runtime answer and falls back to
 * `fallback` when no run data exists yet.
 *
 * Returns:
 *   - `loading` — true while the network call is in flight
 *   - `fields`   — the inferred-from-run schema, OR `fallback` when no
 *                  runtime data is available
 *   - `source`   — when runtime data was used, metadata about which run
 *                  it came from (run id + finished_at)
 *   - `refresh`  — re-fetch (the picker can offer a refresh button)
 *
 * Cached per (integrationId, nodeId) for the lifetime of the
 * component — the fetch fires once on mount; subsequent paths-edit
 * keystrokes don't re-hit the API.
 */

export interface RuntimeSource {
  runId: string;
  finishedAt: string | null;
}

export interface UseStepSchemaResult {
  loading: boolean;
  fields: InferredField[];
  source: RuntimeSource | null;
  refresh: () => void;
}

export function useStepSchema(opts: {
  integrationId: string | null;
  nodeId: string | null;
  fallback: InferredField[];
}): UseStepSchemaResult {
  const { integrationId, nodeId, fallback } = opts;
  const [loading, setLoading] = useState(false);
  const [fields, setFields] = useState<InferredField[]>(fallback);
  const [source, setSource] = useState<RuntimeSource | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!integrationId || !nodeId) {
      setFields(fallback);
      setSource(null);
      return;
    }
    setLoading(true);
    api
      .getNodeOutput(integrationId, nodeId)
      .then((r) => {
        if (!alive) return;
        if (r.found && r.output !== undefined) {
          setFields(inferSchema(r.output));
          setSource({
            runId: r.run_id ?? '',
            finishedAt: r.finished_at ?? null,
          });
        } else {
          setFields(fallback);
          setSource(null);
        }
      })
      .catch(() => {
        if (alive) {
          setFields(fallback);
          setSource(null);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `fallback` is intentionally not a dep — its identity changes per
    // render but we only need it as a fallback once on mount + on
    // explicit refresh. Capturing it in the closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrationId, nodeId, tick]);

  return {
    loading,
    fields,
    source,
    refresh: () => setTick((t) => t + 1),
  };
}
