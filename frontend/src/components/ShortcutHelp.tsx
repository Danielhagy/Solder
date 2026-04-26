import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Global keyboard shortcut reference. Opened by `?` anywhere a text field
 * isn't focused; dismissed by Escape, `?`, or clicking the backdrop.
 *
 * The listed shortcuts are documented here but actually implemented in the
 * components that own them (Builder: ⌘S / save dialog, Sidebar: `/` focus,
 * Canvas: Esc pop focus). This component is descriptive, not wired through
 * to the handlers — keeps the overlay independent.
 */

interface Row {
  keys: string[];
  label: string;
  context?: string;
}

// Detect modifier key once at module load. macOS: ⌘ (cmd). Everywhere else: Ctrl.
// Falls back to Ctrl for SSR / non-browser contexts. The Save handler in Builder
// already accepts both Cmd+S and Ctrl+S, so this is purely a label.
const MOD = (() => {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const ua = navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPod|iPad/i.test(ua) ? '⌘' : 'Ctrl';
})();

const ROWS: Row[] = [
  { keys: ['?'], label: 'Show this help' },
  { keys: [MOD, 'S'], label: 'Save integration', context: 'Builder' },
  { keys: ['/'], label: 'Focus node search', context: 'Builder' },
  { keys: ['Esc'], label: 'Step out of a branch', context: 'Builder' },
  { keys: ['Esc'], label: 'Close dialog' }
];

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const editable =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // `?` toggles. On US layouts this is Shift+/. Check `e.key` rather than
      // building a modifier+code combo so non-US keymaps still work when the
      // user produces a literal "?".
      if (e.key === '?' && !editable) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] dark:bg-black/70"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          onClick={() => setOpen(false)}
          data-testid="shortcut-help"
        >
          <motion.div
            className="card p-6 w-[28rem] dark:text-surface-100"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="eyebrow mb-0.5">help / shortcuts</p>
                <h2 className="text-lg font-semibold dark:text-surface-50">
                  Keyboard Shortcuts
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close"
                className="btn-icon"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
            <ul className="space-y-2">
              {ROWS.map((row, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-4 py-1.5"
                >
                  <div className="min-w-0 flex items-baseline gap-2">
                    <span className="text-sm text-surface-800 dark:text-surface-200 truncate">
                      {row.label}
                    </span>
                    {row.context && (
                      <span className="eyebrow">{row.context}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {row.keys.map((k, j) => (
                      <kbd
                        key={j}
                        className="px-1.5 py-0.5 text-xs font-mono rounded bg-surface-100 text-surface-700 ring-1 ring-surface-200 dark:bg-surface-800 dark:text-surface-200 dark:ring-surface-700"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-xs text-surface-500 dark:text-surface-400">
              Press{' '}
              <kbd className="px-1 py-0.5 text-[10px] font-mono rounded bg-surface-100 ring-1 ring-surface-200 dark:bg-surface-800 dark:ring-surface-700">
                ?
              </kbd>{' '}
              anywhere to toggle.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default ShortcutHelp;
