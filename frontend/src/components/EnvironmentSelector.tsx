import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useEnvironmentStore, type Environment } from '@/stores/environment';

/**
 * Global environment selector. Lives in the top header, always visible.
 *
 * Sandbox: muted teal pill. Production: amber-bordered pill with PROD eyebrow.
 * Switching to production goes through a confirmation modal so a stray click
 * can't push a real call against a customer's API. Switching back is silent.
 *
 * Per-integration scope arrives later — for now this drives a global default
 * state that the Builder will read once integrations carry their own env.
 */
export default function EnvironmentSelector() {
  const env = useEnvironmentStore((s) => s.environment);
  const setEnvironment = useEnvironmentStore((s) => s.setEnvironment);

  const [open, setOpen] = useState(false);
  const [confirmTo, setConfirmTo] = useState<Environment | null>(null);
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

  function requestSwitch(next: Environment) {
    if (next === env) {
      setOpen(false);
      return;
    }
    if (next === 'production') {
      setConfirmTo('production');
      setOpen(false);
      return;
    }
    setEnvironment(next);
    setOpen(false);
  }

  const isProd = env === 'production';
  const pillClass = isProd
    ? 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md ring-1 ring-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:ring-amber-700/60 dark:text-amber-200 dark:hover:bg-amber-950/60'
    : 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md ring-1 ring-cyan-200 bg-cyan-50/60 text-cyan-800 hover:bg-cyan-100/60 dark:bg-cyan-950/30 dark:ring-cyan-800/40 dark:text-cyan-200 dark:hover:bg-cyan-950/50';

  return (
    <>
      <div className="relative" ref={wrapRef}>
        <button
          type="button"
          className={pillClass}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="environment-selector"
          data-environment={env}
          title={isProd ? 'Running against real APIs' : 'Running against mock-engine'}
        >
          <span
            aria-hidden="true"
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              isProd ? 'bg-amber-500 dark:bg-amber-400' : 'bg-cyan-500 dark:bg-cyan-400'
            }`}
          />
          <span className="text-[11px] font-mono uppercase tracking-[0.15em]">
            env · {isProd ? 'prod' : 'sandbox'}
          </span>
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              className="absolute right-0 top-full mt-2 w-72 z-50 card p-3 dark:text-surface-100"
            >
              <p className="eyebrow mb-2">switch environment</p>
              <div className="space-y-1">
                <EnvOption
                  label="Sandbox"
                  caption="mock-engine · safe to iterate"
                  active={env === 'sandbox'}
                  tone="sandbox"
                  onClick={() => requestSwitch('sandbox')}
                />
                <EnvOption
                  label="Production"
                  caption="real APIs · real consequences"
                  active={env === 'production'}
                  tone="production"
                  onClick={() => requestSwitch('production')}
                />
              </div>
              <div className="measure-rule my-3" aria-hidden="true" />
              <div className="space-y-1.5">
                <p className="eyebrow">overrides</p>
                <p className="text-xs text-surface-500 dark:text-surface-400">
                  Per-node overrides will appear here once an integration is open.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {confirmTo === 'production' && (
          <ConfirmProductionModal
            onCancel={() => setConfirmTo(null)}
            onConfirm={() => {
              setEnvironment('production');
              setConfirmTo(null);
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

interface EnvOptionProps {
  label: string;
  caption: string;
  active: boolean;
  tone: 'sandbox' | 'production';
  onClick: () => void;
}

function EnvOption({ label, caption, active, tone, onClick }: EnvOptionProps) {
  const dotClass =
    tone === 'production'
      ? 'bg-amber-500 dark:bg-amber-400'
      : 'bg-cyan-500 dark:bg-cyan-400';
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={`w-full text-left flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors ${
        active
          ? 'bg-surface-100 dark:bg-surface-800'
          : 'hover:bg-surface-50 dark:hover:bg-surface-800/60'
      }`}
      data-testid={`env-option-${tone}`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full ${dotClass}`}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-surface-800 dark:text-surface-100">
          {label}
        </span>
        <span className="block text-xs text-surface-500 dark:text-surface-400">
          {caption}
        </span>
      </span>
      {active && (
        <span className="text-xs font-mono text-surface-400 dark:text-surface-500 mt-0.5">
          ✓
        </span>
      )}
    </button>
  );
}

interface ConfirmProductionModalProps {
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmProductionModal({ onCancel, onConfirm }: ConfirmProductionModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <motion.div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] dark:bg-black/70"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      onClick={onCancel}
      data-testid="env-confirm-prod"
    >
      <motion.div
        className="card p-6 w-[26rem] dark:text-surface-100"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow mb-1">switch · sandbox → production</p>
        <h2 className="text-lg font-semibold dark:text-surface-50">
          Run against real APIs?
        </h2>
        <p className="mt-2 text-sm text-surface-600 dark:text-surface-300">
          Production mode routes every node to the live target system using your
          stored credentials. Writes will be real. The mock-engine is bypassed.
        </p>
        <div className="measure-rule my-4" aria-hidden="true" />
        <p className="text-xs text-surface-500 dark:text-surface-400 font-mono">
          You can switch back at any time — but actions already sent to live APIs
          can't be undone from here.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Stay in sandbox
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            data-testid="env-confirm-prod-go"
          >
            Switch to production
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
