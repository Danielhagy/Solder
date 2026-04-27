import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useIntegrationStore } from '@/stores/integration';
import { GROUPS, groupedCatalog, type CatalogEntry, type NodeGroup } from '@/catalog';
// CatalogEntry kept for the palette-drag handler's parameter type even though
// the rail-chips that referenced it directly are gone.
import { DND_MIME_NEW, type NewNodePayload } from './dnd';
import NestedContextPanel from './NestedContextPanel';
import { api, brandLogoUrl } from '@/api/client';

/** CSS hook applied to <body> while a palette drag is in flight. */
const PALETTE_DRAG_CLASS = 'palette-dragging';

export default function Sidebar() {
  const addNodeToNewStage = useIntegrationStore((s) => s.addNodeToNewStage);
  const addNodeToBranchNewStage = useIntegrationStore((s) => s.addNodeToBranchNewStage);
  const focusPath = useIntegrationStore((s) => s.focusPath);
  const resetStore = useIntegrationStore((s) => s.reset);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  /*
   * Map of `connector.name` → `brand_domain` from `/api/connectors`. Used
   * to render Brandfetch CDN logos on palette entries whose `kind`
   * matches a registered connector (e.g. `zip.list_vendors` shows the
   * Zip logo). Fetched once on mount; failures fall through to the
   * generic glyph icon.
   */
  const [brandByKind, setBrandByKind] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cs = await api.listConnectors();
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const c of cs) {
          if (c.brand_domain) map[c.name] = c.brand_domain;
        }
        setBrandByKind(map);
      } catch {
        // Falls through to glyph rendering — no error state needed.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /*
   * Publish the sidebar's effective width (rail + Builder root padding +
   * gap) as a CSS variable on `<body>` so the Canvas's left padding can
   * track us through the collapse transition. Without this, the canvas
   * content stays pinned at the expanded position and the collapsed
   * sidebar leaves a ~220px dead zone of empty canvas where nodes
   * "should have moved into" — which is exactly what the user flagged.
   *
   * 17rem when expanded = sidebar w-64 (256px) + gap 0.5rem + root pad
   *                       0.5rem + a small breathing buffer
   * 5rem  when collapsed = sidebar w-12 (48px)  + the same paddings
   */
  useEffect(() => {
    document.body.style.setProperty(
      '--solder-sidebar-w',
      collapsed ? '5rem' : '17rem'
    );
    return () => {
      document.body.style.removeProperty('--solder-sidebar-w');
    };
  }, [collapsed]);

  const grouped = groupedCatalog();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return grouped;
    // Built dynamically from GROUPS so a new group lands automatically — no
    // need to update this initialiser when the catalog grows. The double-cast
    // bridges TS's string-keyed `fromEntries` inference to the literal-keyed
    // Record; keys are guaranteed to match by construction.
    const out = Object.fromEntries(
      GROUPS.map((g) => [g, [] as CatalogEntry[]])
    ) as unknown as Record<NodeGroup, CatalogEntry[]>;
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

  return (
    <aside
      className={`relative pointer-events-auto ${
        collapsed ? 'w-12' : 'w-64'
      } glass-rail rounded-xl flex flex-col transition-all duration-200`}
    >
      {/* Collapse toggle pinned just inside the rail's right edge. Sits on
          the glass surface itself (the rail is rounded now, so a half-
          outside button would clip awkwardly). */}
      <button
        type="button"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={() => setCollapsed((v) => !v)}
        className="absolute top-3 right-1.5 z-10 w-6 h-6 rounded-full text-surface-500 hover:text-surface-900 hover:bg-surface-100 flex items-center justify-center text-xs leading-none transition-colors dark:text-surface-400 dark:hover:text-surface-50 dark:hover:bg-white/5"
      >
        {collapsed ? '›' : '‹'}
      </button>

      {collapsed ? (
        /*
         * Collapsed rail — just an "expand" affordance and the wordmark.
         *
         * Earlier this stacked one chip per catalog kind (↗ ⚡ ⎇ ⟳ ⇥ ✓)
         * to "hint" at the palette behind the rail. The hint didn't land:
         * each glyph is meaningless without the label beside it, and six
         * arbitrary symbols stacked vertically read as a cluttered toy
         * dock rather than "click to see nodes". User flagged it; the
         * collapsed rail is now a single full-rail tap target that
         * expands on click — clearer affordance, less visual noise.
         */
        <button
          type="button"
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={() => setCollapsed(false)}
          className="flex-1 flex flex-col items-center justify-between pt-12 pb-3 text-surface-400 hover:text-surface-700 dark:text-surface-500 dark:hover:text-surface-200 transition-colors group"
        >
          <span className="text-xs font-mono uppercase tracking-[0.2em] [writing-mode:vertical-rl] rotate-180 select-none">
            nodes
          </span>
          <span className="solder-wordmark-frame [writing-mode:vertical-rl] rotate-180 select-none">
            /* solder */
          </span>
        </button>
      ) : (
        <>
          {/*
           * Top slot — nested-only.
           * Root view: nothing (the AI-builder textarea that used to live
           * here is gone; by the time the canvas is loaded the integration
           * has already been authored, so the surface was dead weight).
           * Nested: NestedContextPanel shows which container we're inside
           * and lets the user pop back out.
           */}
          {focusPath.length > 0 && <NestedContextPanel />}

          <div className="flex-1 overflow-auto solder-scroll-thin p-4 space-y-4">
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
                        {entries.map((entry) => {
                          const brand = brandByKind[entry.kind];
                          const logoUrl = brandLogoUrl(brand);
                          return (
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
                              {logoUrl ? (
                                /*
                                 * Connector entries get a Brandfetch logo tile —
                                 * matches user expectation of "company name and
                                 * logo" in the connector area. The wrapper keeps
                                 * the same 7×7 footprint as the glyph chip so
                                 * vertical rhythm holds; the logo sits on a
                                 * white bed because Brandfetch returns full-
                                 * colour marks designed for light backgrounds.
                                 */
                                <span className="mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-surface-200 dark:ring-surface-700 bg-white overflow-hidden flex-shrink-0">
                                  <img
                                    src={logoUrl}
                                    alt=""
                                    className="w-5 h-5 object-contain"
                                    loading="lazy"
                                    onError={(e) => {
                                      // Fall back to the catalog glyph if the
                                      // CDN can't resolve the logo (rate limit,
                                      // missing brand, offline). We can't swap
                                      // back to the glyph after first paint, so
                                      // just hide the broken image — the chip
                                      // stays empty rather than rendering a
                                      // broken-image icon.
                                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                </span>
                              ) : (
                                <span className={`mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-md text-sm ring-1 ${entry.chip}`}>
                                  {entry.icon}
                                </span>
                              )}
                              <span className="flex-1 min-w-0">
                                <span className="block text-sm font-medium text-surface-900 dark:text-surface-50">{entry.label}</span>
                                <span className="block text-xs text-surface-500 mt-0.5 truncate dark:text-surface-400">{entry.description}</span>
                              </span>
                            </button>
                          );
                        })}
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
