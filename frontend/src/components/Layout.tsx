import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useMatch } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useThemeStore } from '@/stores/theme';
import EnvironmentSelector from './EnvironmentSelector';
import ShortcutHelp from './ShortcutHelp';
import PageScrollHint from './PageScrollHint';

/*
 * Page transitions removed deliberately. Three iterations were tried
 * (y-translate + blur, blur-only, opacity-only) and each was rejected
 * by the user as janky. The animation cost — even pure opacity over a
 * viewport-sized container with mode="wait" — was the "jank" itself,
 * not the magnitudes. Instant route swap is the calm baseline; if a
 * future motion-design pass wants to revisit, the right path is the
 * browser-native View Transitions API (React Router's unstable_-
 * viewTransition), not framer-motion variants on Outlet.
 */

/*
 * Topbar — "Industrial Drafting" direction (variant 01 from the design
 * review at /__design/topbar). Reads as a CAD title block: four corner
 * sight marks bracket the bar, the brand cell carries a `00 · workbench`
 * stage eyebrow above the `/*solder*\/` wordmark, nav is a mono
 * uppercase `·`-separated list with an ember `▸` + underline on the
 * active route. No fill — the bar IS the drafting plate.
 */

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/integrations', label: 'Integrations' },
  { to: '/processes', label: 'Processes' },
  { to: '/connections', label: 'Connections' },
  { to: '/runs', label: 'Runs' },
  { to: '/sandboxes', label: 'Sandboxes' }
];

export default function Layout() {
  const { theme, toggle } = useThemeStore();

  // The Builder and the Dashboard are both viewport-locked workbenches —
  // they manage their own internal layout and should never scroll the
  // page. The Builder runs a full-bleed canvas; the Dashboard renders
  // the operational status banner + 3-zone grid that fits exactly to
  // the viewport. List pages (Integrations / Connections / Runs / Sandboxes)
  // use the scroll-friendly padded surface. useMatch re-renders on
  // route change so the chrome flips correctly between modes.
  const onBuilder = !!useMatch('/integrations/:id');
  const onDashboard = !!useMatch('/');
  const viewportLocked = onBuilder || onDashboard;

  return (
    <div
      className={
        viewportLocked
          ? 'h-screen flex flex-col overflow-hidden'
          : 'min-h-screen flex flex-col'
      }
    >
      <header className="relative px-8 py-4 border-b border-surface-300 dark:border-surface-700">
        {/* Corner sight marks — small CAD-style brackets at each corner.
            Render as a frame, not as decoration. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-2 w-3 h-3 border-t-2 border-l-2 border-surface-400 dark:border-surface-600"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-2 right-2 w-3 h-3 border-t-2 border-r-2 border-surface-400 dark:border-surface-600"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 left-2 w-3 h-3 border-b-2 border-l-2 border-surface-400 dark:border-surface-600"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 right-2 w-3 h-3 border-b-2 border-r-2 border-surface-400 dark:border-surface-600"
        />

        <div className="max-w-6xl mx-auto flex items-center gap-8">
          {/* Brand cell — stage eyebrow + wordmark */}
          <div className="flex flex-col gap-1 flex-shrink-0">
            <span className="font-mono uppercase tracking-[0.2em] text-[10px] text-surface-500 dark:text-surface-400">
              00 · workbench
            </span>
            <Link
              to="/"
              className="inline-flex items-baseline gap-1 flex-shrink-0"
            >
              <span className="solder-wordmark-frame">/*</span>
              <span className="solder-wordmark text-surface-900 dark:text-surface-50">
                solder
              </span>
              <span className="solder-wordmark-frame">*/</span>
            </Link>
          </div>

          {/* Inline mono nav, dot-separated, ember underline on active */}
          <nav
            aria-label="Primary"
            className="flex-1 flex items-center justify-center min-w-0"
          >
            <ul className="flex items-center gap-3 flex-wrap">
              {NAV.map((item, i) => (
                <li key={item.to} className="flex items-center gap-3">
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      [
                        'font-mono text-[12px] uppercase tracking-[0.18em] transition-colors duration-150 inline-flex items-center gap-1.5 pb-0.5',
                        isActive
                          ? 'text-forge-600 dark:text-forge-400 border-b border-forge-500 dark:border-forge-400'
                          : 'text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50 border-b border-transparent'
                      ].join(' ')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          aria-hidden="true"
                          className={
                            isActive
                              ? 'text-forge-500 dark:text-forge-400'
                              : 'opacity-0'
                          }
                        >
                          ▸
                        </span>
                        <span>{item.label}</span>
                      </>
                    )}
                  </NavLink>
                  {i < NAV.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="font-mono text-[12px] text-surface-400 dark:text-surface-600 select-none"
                    >
                      ·
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          {/* Right cluster: env · | · [?] · ☾ */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <EnvironmentSelector />
            <span
              aria-hidden="true"
              className="inline-block h-4 w-px bg-surface-300 dark:bg-surface-700"
            />
            <HelpMenu />
            <button
              type="button"
              aria-label="Toggle theme"
              onClick={toggle}
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              data-testid="theme-toggle"
              className="font-mono text-[14px] text-surface-600 dark:text-surface-300 hover:text-surface-900 dark:hover:text-surface-50 transition-colors"
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </div>
      </header>
      <main
        className={
          onBuilder
            ? 'flex-1 min-h-0 overflow-hidden bg-black'
            : onDashboard
              ? 'flex-1 min-h-0 overflow-hidden solder-page-surface !p-0'
              : 'flex-1 min-h-0 solder-page-surface'
        }
      >
        <Outlet />
      </main>
      <ShortcutHelp />
      <PageScrollHint />
    </div>
  );
}

/**
 * Compact help cluster: opens a small menu anchoring shortcuts and a
 * Documentation link. The shortcut overlay is still triggered by `?`
 * globally — this menu is the discoverable entry point for users who
 * don't know the shortcut yet.
 *
 * Trigger styled to match the topbar's mono `[?]` kbd-chip aesthetic
 * so it sits inside the drafting-plate vocabulary instead of the
 * old btn-icon pill.
 */
function HelpMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function fireShortcutHelp() {
    setOpen(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-label="Help and documentation"
        title="Help"
        onClick={() => setOpen((v) => !v)}
        data-testid="help-menu-trigger"
        className="font-mono text-[11px] uppercase tracking-[0.15em] px-1.5 py-0.5 rounded border border-surface-300 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:text-surface-900 hover:border-surface-500 dark:hover:text-surface-50 transition-colors"
      >
        [?]
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className="absolute right-0 top-full mt-2 w-56 z-50 card p-1.5 dark:text-surface-100"
          >
            <button
              type="button"
              role="menuitem"
              onClick={fireShortcutHelp}
              className="w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-surface-50 dark:hover:bg-surface-800/60"
            >
              <span className="text-sm">Keyboard shortcuts</span>
              <kbd className="px-1 py-0.5 text-[10px] font-mono rounded bg-surface-100 ring-1 ring-surface-200 dark:bg-surface-800 dark:ring-surface-700">
                ?
              </kbd>
            </button>
            <Link
              to="/docs"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-50 dark:hover:bg-surface-800/60"
            >
              <span className="text-sm">Documentation</span>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
