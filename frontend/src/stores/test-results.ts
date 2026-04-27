import { create } from 'zustand';

/**
 * Stores the last per-node test-run result so the output panel under
 * each editor can persist between Test-overlay dismissals.
 *
 * Lives in its own store (not on `useIntegrationStore`) because the
 * data is purely transient view state — never saved with the
 * integration, never round-tripped to the server, and writes from
 * the test overlay would otherwise spam every selector subscribed to
 * the integration store.
 */

export interface NodeTestResult {
  ok: boolean;
  kind: string;
  duration_ms: number;
  output?: unknown;
  /** Captured stdout from `print()` calls during execution. Only
   *  populated for kinds whose runtime captures stdout (today: code.python). */
  stdout?: string;
  error?: string;
  error_kind?: string | null;
  /** When the picker phase chose a past run, its id is recorded so
   *  the output panel can surface "replayed from run X". */
  source_run_id?: string | null;
  /** Wall-clock when the result landed; used for "ran 12s ago" copy. */
  finished_at: number;
}

interface TestResultState {
  byNodeId: Record<string, NodeTestResult>;
  setResult: (nodeId: string, result: NodeTestResult) => void;
  clearResult: (nodeId: string) => void;
  clearAll: () => void;
}

export const useTestResultStore = create<TestResultState>((set) => ({
  byNodeId: {},
  setResult: (nodeId, result) =>
    set((s) => ({ byNodeId: { ...s.byNodeId, [nodeId]: result } })),
  clearResult: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.byNodeId)) return s;
      const next = { ...s.byNodeId };
      delete next[nodeId];
      return { byNodeId: next };
    }),
  clearAll: () => set({ byNodeId: {} }),
}));
