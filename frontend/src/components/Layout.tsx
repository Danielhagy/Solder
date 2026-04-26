import { NavLink, Outlet } from 'react-router-dom';
import { useThemeStore } from '@/stores/theme';
import ShortcutHelp from './ShortcutHelp';

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
          <NavLink to="/" className="flex items-center gap-1.5 flex-shrink-0">
            <span className="font-mono text-xs text-surface-400 dark:text-surface-500">/*</span>
            <span className="text-base font-semibold text-surface-900 tracking-tight dark:text-surface-50">
              solder
            </span>
          </NavLink>
          <div className="flex items-center rounded-md bg-surface-100 p-1 dark:bg-surface-900/60 overflow-x-auto">
            <NavLink to="/" end className={pillCls}>Builder</NavLink>
            <NavLink to="/integrations" className={pillCls}>Integrations</NavLink>
            <NavLink to="/history" className={pillCls}>History</NavLink>
            <NavLink to="/docs" className={pillCls}>Docs</NavLink>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="hidden sm:inline text-xs text-surface-400 font-mono dark:text-surface-500">
              v0.1
            </span>
            <kbd
              aria-hidden="true"
              title="Press ? to see shortcuts"
              className="hidden md:inline-flex items-center justify-center w-5 h-5 text-[10px] font-mono rounded text-surface-500 ring-1 ring-surface-200 hover:text-surface-900 hover:ring-surface-300 dark:text-surface-400 dark:ring-surface-800 dark:hover:text-surface-50 dark:hover:ring-surface-700 transition-colors cursor-help select-none"
            >
              ?
            </kbd>
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
