import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useIntegrationStore } from '@/stores/integration';
import { api } from '@/api/client';
import { GROUPS, groupedCatalog, type CatalogEntry, type NodeGroup } from '@/catalog';
import { DND_MIME_NEW, type NewNodePayload } from './dnd';

/** CSS hook applied to <body> while a palette drag is in flight. */
const PALETTE_DRAG_CLASS = 'palette-dragging';

export default function Sidebar() {
  const addNodeToNewStage = useIntegrationStore((s) => s.addNodeToNewStage);
  const addNodeToBranchNewStage = useIntegrationStore((s) => s.addNodeToBranchNewStage);
  const focusPath = useIntegrationStore((s) => s.focusPath);
  const resetStore = useIntegrationStore((s) => s.reset);
  const loadConfig = useIntegrationStore((s) => s.loadConfig);

  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const grouped = groupedCatalog();
  // Sample one entry per group so the collapsed rail still hints at the catalog.
  const railChips = GROUPS.map((g) => grouped[g][0]).filter(Boolean) as CatalogEntry[];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return grouped;
    const out = { HTTP: [], Data: [], Logic: [], Process: [], Output: [] } as Record<NodeGroup, CatalogEntry[]>;
    for (const g of GROUPS) {
      for (const e of grouped[g]) {
        const hay = `${e.label} ${e.description} ${e.kind} ${e.action}`.toLowerCase();
        if (hay.includes(q)) out[g].push(e);
      }
    }
    return out;
  }, [query, grouped]);

  const totalMatches = useMemo(
    () => GROUPS.reduce((acc, g) => acc + filtered[g].length, 0),
    [filtered]
  );
  const isSearching = query.trim().length > 0;

  // Focus the search input when `/` is pressed outside of any editable field.
  useEffect(() => {
    if (collapsed) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed]);

  function handleAdd(entry: CatalogEntry) {
    // Route add target based on the current step-into focus:
    //  - Root view (empty focusPath)  → append a new root stage
    //  - Focused into a branch         → append a new stage INSIDE that branch
    // Parallel placement still requires dragging onto the `+ parallel` zone.
    const payload = {
      kind: entry.kind,
      action: entry.action,
      config: { ...entry.defaultConfig }
    };
    if (focusPath.length === 0) {
      addNodeToNewStage(payload);
    } else {
      const deepest = focusPath[focusPath.length - 1];
      addNodeToBranchNewStage(deepest.parentId, deepest.branchKey, payload);
    }
  }

  function handlePaletteDragStart(
    e: ReactDragEvent<HTMLButtonElement>,
    entry: CatalogEntry
  ) {
    const payload: NewNodePayload = { kind: entry.kind, action: entry.action };
    e.dataTransfer.setData(DND_MIME_NEW, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';

    // Custom drag image — a compact pill so the ghost isn't a blurry snapshot
    // of the entire palette row. Positioned off-screen, snapshotted by the
    // browser, then removed on the next tick.
    if (typeof document !== 'undefined') {
      const ghost = document.createElement('div');
      ghost.style.cssText =
        'position:absolute;top:-9999px;left:-9999px;padding:6px 10px;border-radius:8px;background:#ffffff;border:1px solid #e4e4e7;box-shadow:0 4px 12px rgba(0,0,0,0.1);font:500 13px Inter,system-ui,sans-serif;color:#18181b;display:flex;align-items:center;gap:8px;';
      const dot = document.createElement('span');
      dot.style.cssText =
        'display:inline-block;width:14px;height:14px;border-radius:4px;text-align:center;font-size:10px;line-height:14px;background-color:#f4f4f5;';
      dot.textContent = entry.icon;
      const name = document.createElement('span');
      name.textContent = entry.label;
      ghost.appendChild(dot);
      ghost.appendChild(name);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 16);
      // Defer removal so the browser has time to snapshot the element.
      setTimeout(() => {
        try {
          document.body.removeChild(ghost);
        } catch {
          /* already gone */
        }
      }, 0);

      // Tint the canvas while the drag is in flight. Cleared on dragend or drop.
      document.body.classList.add(PALETTE_DRAG_CLASS);
    }
  }

  function handlePaletteDragEnd() {
    if (typeof document !== 'undefined') {
      document.body.classList.remove(PALETTE_DRAG_CLASS);
    }
  }

  async function handleBuildAI() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const result = await api.buildWithAI(aiPrompt);
      if (result.integration_config) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        loadConfig(result.integration_config as any);
      }
    } catch (err) {
      console.error('AI build failed:', err);
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <aside
      className={`relative ${
        collapsed ? 'w-12' : 'w-64'
      } bg-white border-r border-surface-200 shadow-[inset_-1px_0_0_0_rgb(244_244_245)] flex flex-col transition-all duration-200 dark:bg-surface-950 dark:border-surface-800`}
    >
      {/* Collapse toggle pinned to the top-right edge */}
      <button
        type="button"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={() => setCollapsed((v) => !v)}
        className="absolute top-3 -right-3 z-10 w-6 h-6 rounded-full bg-white border border-surface-200 text-surface-500 hover:text-surface-900 hover:border-surface-300 shadow-sm flex items-center justify-center text-xs leading-none transition-colors dark:bg-surface-900 dark:border-surface-800 dark:text-surface-400 dark:hover:text-surface-50 dark:hover:border-surface-700"
      >
        {collapsed ? '›' : '‹'}
      </button>

      {collapsed ? (
        <div className="flex-1 flex flex-col items-center pt-4 gap-2">
          {railChips.map((entry) => (
            <span
              key={`${entry.kind}.${entry.action}`}
              title={entry.label}
              className={`inline-flex items-center justify-center w-7 h-7 rounded-md text-sm ring-1 ${entry.chip}`}
            >
              {entry.icon}
            </span>
          ))}
          <div className="mt-auto mb-3">
            <span className="text-[9px] font-mono uppercase tracking-[0.15em] text-surface-300 dark:text-surface-600 [writing-mode:vertical-rl] rotate-180">
              solder
            </span>
          </div>
          {/* Keep the harness-required Clear Canvas affordance reachable even when collapsed. */}
          <button
            type="button"
            onClick={() => resetStore()}
            className="sr-only"
          >
            Clear Canvas
          </button>
        </div>
      ) : (
        <>
          <div className="p-4 border-b border-surface-200 dark:border-surface-800">
            <div className="mb-2">
              <span className="eyebrow">AI Builder</span>
            </div>
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              className="input w-full h-20 text-sm resize-none"
              placeholder="Describe your integration..."
            />
            <button
              type="button"
              className="btn btn-primary w-full mt-2 text-sm"
              onClick={handleBuildAI}
              disabled={aiLoading || !aiPrompt.trim()}
            >
              {aiLoading ? 'Building…' : 'Build with AI'}
            </button>
          </div>

          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="mb-2">
              <span className="eyebrow">Nodes</span>
            </div>

            <div className="relative mb-3">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter nodes… (/)"
                className="w-full pl-7 pr-3 py-1.5 text-xs bg-surface-50 dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-surface-700 dark:text-surface-200 placeholder:text-surface-400 dark:placeholder:text-surface-600"
                data-testid="palette-search"
              />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-surface-400 dark:text-surface-600 pointer-events-none">⌕</span>
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-surface-400 hover:text-surface-700 dark:text-surface-600 dark:hover:text-surface-200"
                >
                  ✕
                </button>
              )}
            </div>

            {isSearching && totalMatches === 0 ? (
              <div className="py-8 text-center">
                <p className="text-xs font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500 mb-1">no_matches</p>
                <p className="text-xs text-surface-500 dark:text-surface-400">Try a different search term.</p>
              </div>
            ) : (
              GROUPS.map((group) => {
                const entries = filtered[group];
                if (!entries.length) return null;
                // During search, auto-expand any group with matches regardless
                // of the user's explicit collapse state.
                const isOpen = isSearching ? true : openGroups[group] ?? true;
                return (
                  <div key={group}>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between text-[11px] font-mono uppercase tracking-[0.15em] text-surface-500 hover:text-surface-700 mb-1.5 transition-colors dark:text-surface-400 dark:hover:text-surface-200"
                      onClick={() => setOpenGroups({ ...openGroups, [group]: !isOpen })}
                      data-group={group}
                    >
                      <span>
                        <span>{group}</span>
                        <span className="text-surface-300 dark:text-surface-700 font-mono tabular-nums ml-1">({entries.length})</span>
                      </span>
                      <span className="text-surface-400 dark:text-surface-500">{isOpen ? '−' : '+'}</span>
                    </button>
                    {isOpen && (
                      <div className="space-y-1">
                        {entries.map((entry) => (
                          <button
                            key={`${entry.kind}.${entry.action}`}
                            type="button"
                            data-testid={`palette-${entry.kind}-${entry.action}`}
                            data-draggable="palette"
                            draggable
                            onDragStart={(e) => handlePaletteDragStart(e, entry)}
                            onDragEnd={handlePaletteDragEnd}
                            className="w-full flex items-start gap-3 p-2.5 rounded-lg hover:bg-surface-50 transition-colors text-left dark:hover:bg-surface-900"
                            onClick={() => handleAdd(entry)}
                          >
                            <span className={`mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-md text-sm ring-1 ${entry.chip}`}>
                              {entry.icon}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm font-medium text-surface-900 dark:text-surface-50">{entry.label}</span>
                              <span className="block text-xs text-surface-500 mt-0.5 truncate dark:text-surface-400">{entry.description}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="p-4 border-t border-surface-200 dark:border-surface-800">
            <button
              type="button"
              className="w-full text-xs font-medium text-surface-500 hover:text-surface-900 transition-colors dark:text-surface-400 dark:hover:text-surface-50"
              onClick={() => resetStore()}
            >
              Clear Canvas
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
