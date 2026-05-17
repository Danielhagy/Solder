/*
 * ConnectionChip — the connection picker for an HTTP node.
 *
 * Sits between the URL bar and the tab strip. Two states:
 *
 *   bound:    [🟧 Hubspot — prod · oauth2_cc · synthetic ▾]
 *   unbound:  [ + bind a connection (optional) ]
 *
 * Clicking opens a portal-rendered popover with a search input, grouped
 * list of available connections (built-in vs custom), and a footer with
 * Clear + "+ New connection" actions.
 *
 * Auto-bind is the parent editor's job (it knows when a node is freshly
 * created); this component is a pure consumer of `connectionId`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  api,
  brandLogoUrl,
  type Connection,
  type Connector,
  type SandboxMode,
} from '@/api/client';

interface Props {
  connectionId: string | null;
  onChange: (id: string | null) => void;
}

const POPOVER_MAX = 380;

export default function ConnectionChip({ connectionId, onChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [filter, setFilter] = useState('');
  const [highlighted, setHighlighted] = useState(0);

  // Fetch lazily — only when the popover opens.
  useEffect(() => {
    if (!open) return;
    Promise.all([api.listConnections(), api.listConnectors()])
      .then(([cn, ct]) => {
        setConnections(cn);
        setConnectors(ct);
      })
      .catch(() => {
        // Soft fail — the picker just shows "no connections available".
      });
  }, [open]);

  // Position the portaled popover under the trigger.
  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  // Click-outside + Esc dismissal.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const connectorById = useMemo(() => {
    const m = new Map<string, Connector>();
    for (const c of connectors) m.set(c.id, c);
    return m;
  }, [connectors]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return connections;
    return connections.filter((c) => {
      const connector = c.connector_id ? connectorById.get(c.connector_id) : undefined;
      const hay = [c.label, connector?.display_name ?? '', connector?.name ?? '', c.base_url ?? '']
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [connections, connectorById, filter]);

  const grouped = useMemo(() => {
    const builtin: Connection[] = [];
    const custom: Connection[] = [];
    for (const c of filtered) {
      if (c.connector_id) builtin.push(c);
      else custom.push(c);
    }
    return { builtin, custom };
  }, [filtered]);

  const flatList = useMemo(
    () => [...grouped.builtin, ...grouped.custom],
    [grouped]
  );

  useEffect(() => {
    setHighlighted(0);
  }, [filter, open]);

  const bound = connections.find((c) => c.id === connectionId)
    ?? (connectionId ? ({ id: connectionId, label: '(loading…)' } as Connection) : null);

  // Best-effort chip display before connections are fetched: keep what we
  // had cached on the bound row when the picker last opened.
  const boundConnector = bound?.connector_id
    ? connectorById.get(bound.connector_id)
    : undefined;
  const boundLogo = boundConnector ? brandLogoUrl(boundConnector.brand_domain) : null;

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, Math.max(flatList.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = flatList[highlighted];
      if (pick) {
        onChange(pick.id);
        setOpen(false);
      }
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="http-connection-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left',
          'border transition-colors',
          connectionId
            ? 'border-forge-500/40 bg-forge-500/[0.06] hover:bg-forge-500/[0.10] dark:border-forge-500/40'
            : 'border-dashed border-surface-300 dark:border-surface-700 hover:border-surface-400 dark:hover:border-surface-600',
        ].join(' ')}
      >
        {bound ? (
          <>
            <span
              aria-hidden="true"
              className="w-5 h-5 rounded grid place-items-center bg-surface-100 dark:bg-surface-800 overflow-hidden flex-shrink-0"
            >
              {boundLogo ? (
                <img
                  src={boundLogo}
                  alt=""
                  className="w-4 h-4 object-contain"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <span className="text-[10px] font-semibold text-surface-500">
                  {(bound.label || '?').slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <span className="flex-1 min-w-0 truncate font-mono text-xs text-surface-900 dark:text-surface-50">
              {bound.label}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-surface-500 dark:text-surface-400 flex-shrink-0">
              {bound.auth_scheme}
            </span>
            <SandboxPill mode={bound.sandbox_mode} />
            <Chevron open={open} />
          </>
        ) : (
          <>
            <span aria-hidden="true" className="text-surface-400 dark:text-surface-500">＋</span>
            <span className="flex-1 font-mono text-[11px] uppercase tracking-[0.08em] text-surface-500 dark:text-surface-400">
              bind a connection (optional)
            </span>
            <Chevron open={open} />
          </>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <AnimatePresence>
            <motion.div
              key="connection-popover"
              ref={popoverRef}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.12 }}
              role="listbox"
              tabIndex={-1}
              onKeyDown={handleKey}
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                width: Math.max(pos.width, 320),
                maxHeight: POPOVER_MAX,
                zIndex: 60,
              }}
              className="overflow-hidden flex flex-col rounded-md border shadow-xl"
              data-testid="http-connection-popover"
            >
              {/*
               * Match the dark surface vocabulary used by the new modals — bg
               * is --surface-900 (near-black in dark, cream in light) with
               * --rule border.
               */}
              <div
                style={{
                  background: 'var(--surface-900)',
                  borderColor: 'var(--rule)',
                  color: 'var(--surface-50)',
                }}
                className="flex flex-col"
              >
                <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--rule)' }}>
                  <span
                    aria-hidden="true"
                    className="font-mono text-[11px] text-surface-400 dark:text-surface-500"
                  >
                    /
                  </span>
                  <input
                    ref={searchRef}
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.currentTarget.value)}
                    onKeyDown={handleKey}
                    placeholder="search connections"
                    className="flex-1 bg-transparent outline-none font-mono text-xs text-surface-50"
                    data-testid="http-connection-search"
                  />
                </div>

                <div className="overflow-auto solder-scroll-thin flex-1" style={{ maxHeight: 260 }}>
                  {flatList.length === 0 ? (
                    <div className="px-3 py-4 text-[11px] font-mono italic text-surface-500">
                      no connections {filter ? 'match' : 'available yet'}
                    </div>
                  ) : (
                    <>
                      {grouped.builtin.length > 0 && (
                        <Group title="BUILT-IN">
                          {grouped.builtin.map((c, i) => (
                            <Row
                              key={c.id}
                              connection={c}
                              connector={c.connector_id ? connectorById.get(c.connector_id) : undefined}
                              active={flatList[highlighted]?.id === c.id}
                              selected={c.id === connectionId}
                              onPick={() => {
                                onChange(c.id);
                                setOpen(false);
                              }}
                              onHover={() => setHighlighted(i)}
                            />
                          ))}
                        </Group>
                      )}
                      {grouped.custom.length > 0 && (
                        <Group title="CUSTOM">
                          {grouped.custom.map((c, i) => {
                            const absoluteIndex = grouped.builtin.length + i;
                            return (
                              <Row
                                key={c.id}
                                connection={c}
                                connector={undefined}
                                active={flatList[highlighted]?.id === c.id}
                                selected={c.id === connectionId}
                                onPick={() => {
                                  onChange(c.id);
                                  setOpen(false);
                                }}
                                onHover={() => setHighlighted(absoluteIndex)}
                              />
                            );
                          })}
                        </Group>
                      )}
                    </>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 px-3 py-2 border-t" style={{ borderColor: 'var(--rule)' }}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    disabled={!connectionId}
                    className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-surface-400 dark:text-surface-500 hover:text-rose-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid="http-connection-clear"
                  >
                    ✕ Clear
                  </button>
                  <a
                    href="/connections"
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-surface-400 dark:text-surface-500 hover:text-forge-500"
                  >
                    + New connection ↗
                  </a>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>,
          document.body
        )}
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="px-3 py-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-surface-500 dark:text-surface-500"
        style={{ background: 'var(--container-glaze)' }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  connection,
  connector,
  active,
  selected,
  onPick,
  onHover,
}: {
  connection: Connection;
  connector: Connector | undefined;
  active: boolean;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const logo = connector ? brandLogoUrl(connector.brand_domain) : null;
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onMouseEnter={onHover}
      data-testid={`http-connection-option-${connection.id}`}
      aria-selected={selected}
      className={[
        'w-full flex items-center gap-2 px-3 py-1.5 text-left',
        active ? 'bg-forge-500/[0.10]' : 'hover:bg-surface-800/40',
        selected ? 'border-l-2 border-forge-500' : 'border-l-2 border-transparent',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="w-5 h-5 rounded grid place-items-center bg-surface-100 dark:bg-surface-800 overflow-hidden flex-shrink-0"
      >
        {logo ? (
          <img
            src={logo}
            alt=""
            className="w-4 h-4 object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span className="text-[10px] font-semibold text-surface-500">
            {(connection.label || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
      </span>
      <span className="flex-1 min-w-0 truncate font-mono text-xs text-surface-50">
        {connection.label}
      </span>
      <span className="font-mono text-[10px] text-surface-500 flex-shrink-0">
        {connector?.display_name ?? connection.auth_scheme}
      </span>
      <SandboxPill mode={connection.sandbox_mode} />
    </button>
  );
}

function SandboxPill({ mode }: { mode: SandboxMode }) {
  const styles: Record<SandboxMode, { label: string; color: string }> = {
    synthetic: { label: 'synth', color: 'var(--forge-400)' },
    vendor: { label: 'vendor', color: 'var(--primary-400)' },
    none: { label: 'live', color: 'var(--surface-500)' },
  };
  const s = styles[mode];
  return (
    <span
      className="font-mono text-[9.5px] uppercase tracking-[0.08em] px-1 py-px rounded flex-shrink-0"
      style={{ color: s.color, borderColor: s.color, borderWidth: 1, borderStyle: 'solid' }}
    >
      {s.label}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`flex-shrink-0 text-surface-400 dark:text-surface-500 transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
