import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useThemeStore } from '@/stores/theme';
import EnvironmentSelector from './EnvironmentSelector';
import ShortcutHelp from './ShortcutHelp';

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

export default function Layout() {
  const { theme, toggle } = useThemeStore();

  const pillCls = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? 'px-3 py-1.5 text-sm rounded-md bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-surface-50'
      : 'px-3 py-1.5 text-sm rounded-md text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-surface-200 px-6 py-3 dark:bg-surface-950 dark:border-surface-800">
        <nav className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <NavLink to="/" className="flex items-baseline gap-1 flex-shrink-0">
            <span className="solder-wordmark-frame">/*</span>
            <span className="solder-wordmark text-surface-900 dark:text-surface-50">solder</span>
            <span className="solder-wordmark-frame">*/</span>
          </NavLink>
          <div className="flex items-center rounded-md bg-surface-100 p-1 dark:bg-surface-900/60 overflow-x-auto">
            <NavLink to="/" end className={pillCls}>Dashboard</NavLink>
            <NavLink to="/integrations" className={pillCls}>Integrations</NavLink>
            <NavLink to="/connections" className={pillCls}>Connections</NavLink>
            <NavLink to="/runs" className={pillCls}>Runs</NavLink>
            <NavLink to="/mocks" className={pillCls}>Mocks</NavLink>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <EnvironmentSelector />
            <span
              aria-hidden="true"
              className="hidden md:inline-block h-4 w-px bg-surface-200 dark:bg-surface-800 mx-1"
            />
            <HelpMenu />
            <button
              type="button"
              aria-label="Toggle theme"
              onClick={toggle}
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              className="btn-icon"
              data-testid="theme-toggle"
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </nav>
      </header>
      <main className="flex-1 min-h-0 solder-page-surface">
        <Outlet />
      </main>
      <ShortcutHelp />
    </div>
  );
}

/**
 * Compact help cluster: opens a small menu anchoring shortcuts and a Documentation
 * link. The shortcut overlay is still triggered by `?` globally — this menu is
 * the discoverable entry point for users who don't know the shortcut yet.
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
        className="btn-icon font-mono text-sm"
        data-testid="help-menu-trigger"
      >
        ?
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
