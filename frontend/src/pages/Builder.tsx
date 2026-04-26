import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Canvas from '@/components/builder/Canvas';
import Sidebar from '@/components/builder/Sidebar';
import PropertiesPanel from '@/components/builder/PropertiesPanel';
import TriggerStrip from '@/components/builder/TriggerStrip';
import {
  useIntegrationStore,
  type IntegrationConfig as StoreIntegrationConfig,
  type TriggerConfig
} from '@/stores/integration';
import { api, type IntegrationVersion } from '@/api/client';
import RunDrawer, { type RunStatus, type StepRecord } from '@/components/builder/RunDrawer';

/**
 * Stable serialization of everything that matters to "is this integration
 * different from the last save?". Used to derive the dirty indicator and to
 * stamp the saved snapshot after a successful save/load.
 */
function snapshotKey(
  name: string,
  isLibrary: boolean,
  trigger: TriggerConfig,
  config: StoreIntegrationConfig
): string {
  return JSON.stringify({ name, isLibrary, trigger, config });
}

/** Compact "saved 12s ago" / "saved 3m ago" phrasing for the dirty indicator. */
function formatSavedAgo(savedAt: number, now: number): string {
  const delta = Math.max(0, now - savedAt);
  const sec = Math.round(delta / 1000);
  if (sec < 5) return 'saved just now';
  if (sec < 60) return `saved ${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `saved ${min}m ago`;
  const hr = Math.round(min / 60);
  return `saved ${hr}h ago`;
}

export default function Builder() {
  const [searchParams, setSearchParams] = useSearchParams();
  const id = searchParams.get('id');

  const [integrationName, setIntegrationName] = useState('New Integration');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentIntegrationId, setCurrentIntegrationId] = useState<string | null>(
    null
  );
  const [isLibrary, setIsLibrary] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [versions, setVersions] = useState<IntegrationVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  useEffect(() => {
    if (!showSaveDialog) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowSaveDialog(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSaveDialog]);

  useEffect(() => {
    if (!showHistoryDialog) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowHistoryDialog(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showHistoryDialog]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (showSaveDialog === false) {
          e.preventDefault();
          setShowSaveDialog(true);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSaveDialog]);

  // Load integration by ?id=<uuid> whenever id changes. Absent id => fresh canvas.
  useEffect(() => {
    let cancelled = false;
    if (!id) {
      setCurrentIntegrationId(null);
      return;
    }
    (async () => {
      try {
        const integration = await api.getIntegration(id);
        if (cancelled) return;
        // The store's loadConfig normalizes raw/legacy node shapes at runtime,
        // so crossing from the API client's loose IntegrationConfig into the
        // store's strict one is safe.
        useIntegrationStore
          .getState()
          .loadConfig(integration.config as unknown as StoreIntegrationConfig);
        const loadedTrigger =
          (integration.trigger as TriggerConfig | undefined) ?? { type: 'manual' };
        useIntegrationStore.getState().setTrigger(loadedTrigger);
        setIntegrationName(integration.name);
        setCurrentIntegrationId(integration.id);
        setIsLibrary(integration.is_library === true);
        // Stamp the saved snapshot post-load so the dirty indicator reads
        // "clean" immediately. Normalizing through the store first ensures
        // the key we compute matches what the user's edits will diff against.
        const normalized = useIntegrationStore.getState().toConfig();
        setSavedSnapshot(
          snapshotKey(
            integration.name,
            integration.is_library === true,
            loadedTrigger,
            normalized
          )
        );
        setSavedAt(Date.now());
        setNow(Date.now());
      } catch (err) {
        console.error('Failed to load integration:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const toConfig = useIntegrationStore((s) => s.toConfig);
  const trigger = useIntegrationStore((s) => s.trigger);
  // Subscribing here drives re-renders of the dirty indicator whenever the
  // canvas changes. `toConfig()` reads from these same slices.
  const nodes = useIntegrationStore((s) => s.nodes);
  const variables = useIntegrationStore((s) => s.variables);

  // Snapshot key at last save/load. null = fresh unsaved canvas.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // `now` ticks so the "saved Xs ago" phrasing updates without a save event.
  const [now, setNow] = useState(() => Date.now());

  const currentSnapshot = useMemo(
    () => snapshotKey(integrationName, isLibrary, trigger, { nodes, variables }),
    [integrationName, isLibrary, trigger, nodes, variables]
  );
  // Empty canvas + default name counts as clean; avoids a noisy "unsaved" label
  // the moment the user lands on /.
  const isPristine =
    savedSnapshot === null && nodes.length === 0 && integrationName === 'New Integration';
  const dirty = !isPristine && currentSnapshot !== savedSnapshot;

  // Tick every 10s while clean so "saved 30s ago" advances. Stops while dirty.
  useEffect(() => {
    if (dirty || !savedAt) return;
    const h = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(h);
  }, [dirty, savedAt]);

  // Browser "are you sure?" guard. Only registers while dirty; avoids spurious
  // prompts when the user is just navigating between clean pages.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  async function saveIntegration() {
    setSaving(true);
    try {
      // Capture the snapshot we're saving BEFORE the await so subsequent edits
      // during the request are still recognized as dirty.
      const pendingSnapshot = currentSnapshot;
      if (currentIntegrationId) {
        // Existing integration -> PATCH
        await api.updateIntegration(currentIntegrationId, {
          name: integrationName,
          config: toConfig(),
          trigger,
          is_library: isLibrary
        });
      } else {
        // New integration -> POST; adopt the new id for subsequent saves.
        const created = await api.createIntegration({
          name: integrationName,
          config: toConfig(),
          trigger,
          is_library: isLibrary
        });
        setCurrentIntegrationId(created.id);
        // Reflect the id in the URL so the page is reload-safe / shareable.
        setSearchParams({ id: created.id }, { replace: true });
      }
      setSavedSnapshot(pendingSnapshot);
      setSavedAt(Date.now());
      setNow(Date.now());
      setShowSaveDialog(false);
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setSaving(false);
    }
  }

  async function openHistory() {
    if (!currentIntegrationId) return;
    setShowHistoryDialog(true);
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const rows = await api.listVersions(currentIntegrationId);
      setVersions(rows);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : 'Failed to load versions');
    } finally {
      setVersionsLoading(false);
    }
  }

  async function restoreVersion(versionNumber: number) {
    if (!currentIntegrationId) return;
    setRestoringVersion(versionNumber);
    try {
      const restored = await api.restoreVersion(currentIntegrationId, versionNumber);
      // Fold the restored snapshot back into the live canvas so the user sees it
      // immediately without a full reload.
      useIntegrationStore
        .getState()
        .loadConfig(restored.config as unknown as StoreIntegrationConfig);
      const restoredTrigger =
        (restored.trigger as TriggerConfig | undefined) ?? { type: 'manual' };
      useIntegrationStore.getState().setTrigger(restoredTrigger);
      setIntegrationName(restored.name);
      setIsLibrary(restored.is_library === true);
      // The restore API also writes a new version on top; reflect clean state
      // so the dirty indicator doesn't flag the restore itself as unsaved work.
      const normalized = useIntegrationStore.getState().toConfig();
      setSavedSnapshot(
        snapshotKey(
          restored.name,
          restored.is_library === true,
          restoredTrigger,
          normalized
        )
      );
      setSavedAt(Date.now());
      setNow(Date.now());
      // Refresh the list — restore creates a new version on top.
      const rows = await api.listVersions(currentIntegrationId);
      setVersions(rows);
      setShowHistoryDialog(false);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoringVersion(null);
    }
  }

  const [running, setRunning] = useState(false);
  // Drawer state. `runStatus` drives the chip; null = drawer closed.
  const [runDrawerOpen, setRunDrawerOpen] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runSteps, setRunSteps] = useState<StepRecord[]>([]);
  const [runOutput, setRunOutput] = useState<unknown>(undefined);
  const [runError, setRunError] = useState<string | null>(null);

  async function runIntegration() {
    // Need an integration id to run against. If the user hasn't saved yet,
    // auto-save first so the backend has something to execute.
    setRunning(true);
    // Reset drawer state for the new run.
    setRunSteps([]);
    setRunOutput(undefined);
    setRunError(null);
    setRunStatus('running');
    setRunStartedAt(Date.now());
    setRunId(null);
    setRunDrawerOpen(true);
    try {
      // Running always commits the current canvas; snapshot-stamp so the
      // dirty indicator immediately reads "saved just now".
      const pendingSnapshot = currentSnapshot;
      let integrationId = currentIntegrationId;
      if (!integrationId) {
        const created = await api.createIntegration({
          name: integrationName,
          config: toConfig(),
          trigger,
          is_library: isLibrary
        });
        integrationId = created.id;
        setCurrentIntegrationId(created.id);
        setSearchParams({ id: created.id }, { replace: true });
      } else {
        // Commit the current canvas state so the run uses what the user sees.
        await api.updateIntegration(integrationId, {
          name: integrationName,
          config: toConfig(),
          trigger,
          is_library: isLibrary
        });
      }
      setSavedSnapshot(pendingSnapshot);
      setSavedAt(Date.now());
      setNow(Date.now());

      const run = await api.createRun(integrationId);
      await api.executeRun(run.id);
      setRunId(run.id);

      // Poll for terminal state — capped so we don't spin forever if the
      // worker is down. The backend workflow only writes `steps` on completion
      // today; poll still calls getRun each tick so when the update lands the
      // drawer repaints instantly instead of waiting for a reload.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 800));
        const latest = await api.getRun(run.id);
        if (Array.isArray(latest.steps)) {
          setRunSteps(latest.steps as StepRecord[]);
        }
        if (
          latest.status === 'success' ||
          latest.status === 'failed' ||
          latest.status === 'cancelled'
        ) {
          setRunStatus(latest.status as RunStatus);
          setRunOutput(latest.output_data);
          setRunError(latest.error_message ?? null);
          return;
        }
      }
      setRunStatus('timeout');
      setRunError('Run did not complete within 30s. Check the worker.');
    } catch (err) {
      setRunStatus('failed');
      setRunError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="h-[calc(100vh-73px)] flex overflow-hidden bg-surface-100 dark:bg-surface-950">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="bg-white border-b border-surface-200 px-4 py-2.5 flex items-center justify-between gap-3 dark:bg-surface-950 dark:border-surface-800">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <input
              type="text"
              value={integrationName}
              onChange={(e) => setIntegrationName(e.target.value)}
              className="text-base font-semibold min-w-0 flex-1 max-w-[40ch] border-none focus:outline-none focus:ring-0 bg-transparent px-0 py-1 dark:text-surface-50 dark:placeholder-surface-500"
              placeholder="Integration name"
            />
            <span
              aria-hidden="true"
              className="h-4 w-px bg-surface-200 dark:bg-surface-800 flex-shrink-0"
            />
            <span
              className="text-xs font-mono flex items-center gap-1.5 flex-shrink-0"
              data-testid="save-status"
              data-dirty={dirty ? 'true' : 'false'}
              title={
                dirty
                  ? 'You have unsaved changes'
                  : savedAt
                    ? `Last saved ${new Date(savedAt).toLocaleTimeString()}`
                    : 'Nothing to save yet'
              }
            >
              {dirty ? (
                <>
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400"
                    aria-hidden="true"
                  />
                  <span className="text-amber-600 dark:text-amber-300">unsaved</span>
                </>
              ) : savedAt ? (
                <>
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
                    aria-hidden="true"
                  />
                  <span className="text-surface-500 dark:text-surface-400">
                    {formatSavedAgo(savedAt, now)}
                  </span>
                </>
              ) : (
                <span className="text-surface-400 dark:text-surface-500">draft</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={openHistory}
              disabled={!currentIntegrationId}
              title={currentIntegrationId ? 'View version history' : 'Save first to see history'}
              data-testid="history-button"
            >
              History
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowSaveDialog(true)}
            >
              <span>Save</span>
              <span className="ml-2 text-xs text-surface-400 font-mono hidden md:inline dark:text-surface-500">⌘S</span>
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={runIntegration}
              disabled={trigger.type !== 'manual' || running}
              data-testid="run-button"
            >
              {running
                ? 'running…'
                : trigger.type === 'manual'
                  ? '→ Run'
                  : `→ Trigger: ${trigger.type}`}
            </button>
          </div>
        </div>
        <TriggerStrip />
        <Canvas />
        {/* Hidden marker so the Playwright harness can assert the loaded id. */}
        <input
          type="hidden"
          data-testid="builder-integration-id"
          value={currentIntegrationId ?? ''}
          readOnly
        />
      </div>
      {/* Right rail: run drawer takes over while a run is in flight,
          otherwise the properties editor / run plan. Sharing the same slot
          avoids the double-rail + button-overlap the design review flagged. */}
      {runDrawerOpen ? (
        <RunDrawer
          open={runDrawerOpen}
          status={runStatus}
          runId={runId}
          startedAt={runStartedAt}
          steps={runSteps}
          output={runOutput}
          error={runError}
          planNodes={nodes}
          onClose={() => setRunDrawerOpen(false)}
        />
      ) : (
        <PropertiesPanel />
      )}

      <AnimatePresence>
        {showSaveDialog && (
          <motion.div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 dark:bg-black/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <motion.div
              className="card p-6 w-96 dark:text-surface-100"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <h2 className="text-lg font-semibold mb-4 dark:text-surface-50">Save Integration</h2>
              <input
                type="text"
                value={integrationName}
                onChange={(e) => setIntegrationName(e.target.value)}
                className="input w-full mb-3"
                placeholder="Integration name"
              />
              <label className="flex items-start gap-2 mb-4 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isLibrary}
                  onChange={(e) => setIsLibrary(e.currentTarget.checked)}
                  className="mt-0.5"
                  data-testid="save-as-library"
                />
                <span>
                  <span className="block text-sm font-medium text-surface-800 dark:text-surface-200">
                    Reusable subprocess
                  </span>
                  <span className="block text-xs text-surface-500 dark:text-surface-400">
                    Other integrations can call this via a <code className="font-mono">process.call</code> node.
                  </span>
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowSaveDialog(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={saveIntegration}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showHistoryDialog && (
          <motion.div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 dark:bg-black/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={() => setShowHistoryDialog(false)}
            data-testid="history-dialog"
          >
            <motion.div
              className="card p-6 w-[32rem] max-h-[80vh] flex flex-col dark:text-surface-100"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold dark:text-surface-50">Version History</h2>
                <button
                  type="button"
                  aria-label="Close"
                  className="text-surface-400 hover:text-surface-700 dark:text-surface-500 dark:hover:text-surface-200"
                  onClick={() => setShowHistoryDialog(false)}
                >
                  ✕
                </button>
              </div>

              {versionsError && (
                <div className="mb-3 text-sm text-red-600 dark:text-red-300">
                  {versionsError}
                </div>
              )}

              {versionsLoading ? (
                <div className="text-sm text-surface-500 dark:text-surface-400">
                  Loading…
                </div>
              ) : versions.length === 0 ? (
                <div className="text-sm text-surface-500 dark:text-surface-400">
                  No versions yet.
                </div>
              ) : (
                <ol className="flex-1 overflow-auto -mx-2 px-2 space-y-2" data-testid="version-list">
                  {versions.map((v, idx) => {
                    const isLatest = idx === 0;
                    return (
                      <li
                        key={v.id}
                        className="flex items-start gap-3 p-3 rounded border border-surface-200 dark:border-surface-800"
                        data-testid={`version-row-${v.version_number}`}
                      >
                        <div className="flex-shrink-0 font-mono text-xs uppercase tracking-[0.15em] text-surface-500 dark:text-surface-400 pt-1 w-10">
                          v{v.version_number}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-surface-800 dark:text-surface-200">
                            {v.change_summary || '(no summary)'}
                          </div>
                          <div className="text-xs text-surface-500 dark:text-surface-500 mt-0.5">
                            {new Date(v.created_at).toLocaleString()}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost !px-3 !py-1 text-sm"
                          disabled={isLatest || restoringVersion !== null}
                          onClick={() => restoreVersion(v.version_number)}
                          title={isLatest ? 'Already the current version' : `Restore v${v.version_number}`}
                          data-testid={`restore-${v.version_number}`}
                        >
                          {restoringVersion === v.version_number ? 'Restoring…' : isLatest ? 'Current' : 'Restore'}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
