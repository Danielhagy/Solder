import { useIntegrationStore, type TriggerConfig } from '@/stores/integration';

type PillType = TriggerConfig['type'];

interface PillDef {
  type: PillType;
  label: string;
  disabled?: boolean;
}

const PILLS: PillDef[] = [
  { type: 'manual', label: 'manual' },
  { type: 'webhook', label: 'webhook' },
  { type: 'schedule', label: 'schedule' },
  { type: 'on_event', label: 'on_event', disabled: true }
];

export default function TriggerStrip() {
  const trigger = useIntegrationStore((s) => s.trigger);
  const setTrigger = useIntegrationStore((s) => s.setTrigger);

  function selectPill(type: PillType) {
    if (type === trigger.type) return;
    switch (type) {
      case 'manual':
        setTrigger({ type: 'manual' });
        return;
      case 'webhook':
        setTrigger({ type: 'webhook', secret: null });
        return;
      case 'schedule':
        setTrigger({ type: 'schedule', cron: '0 * * * *', timezone: 'UTC' });
        return;
      case 'on_event':
        // Disabled; do nothing.
        return;
    }
  }

  const webhookUrl = '/api/webhooks/<pending>';

  return (
    <div className="bg-white border-b border-surface-200 px-4 py-2 flex items-center gap-3 dark:bg-surface-950 dark:border-surface-800">
      <span className="eyebrow">trigger</span>

      <div className="rounded-md bg-surface-100 p-0.5 flex items-center gap-0.5 dark:bg-surface-900/60">
        {PILLS.map((p) => {
          const active = trigger.type === p.type;
          const base =
            'px-2.5 py-1 rounded-md text-sm font-medium transition-colors flex items-center';
          const activeCls = 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-surface-50';
          const inactiveCls = 'text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50';
          const disabledCls = 'opacity-50 cursor-not-allowed';
          const cls = `${base} ${active ? activeCls : inactiveCls} ${
            p.disabled ? disabledCls : ''
          }`.trim();
          return (
            <button
              key={p.type}
              type="button"
              data-testid={`trigger-pill-${p.type}`}
              className={cls}
              onClick={() => {
                if (p.disabled) return;
                selectPill(p.type);
              }}
              aria-pressed={active}
              aria-disabled={p.disabled || undefined}
            >
              <span>{p.label}</span>
              {p.disabled && (
                <span className="ml-1 text-[10px] font-mono text-surface-400 dark:text-surface-500">soon</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Inline config area — manual mode is self-explanatory, no helper needed. */}

      {trigger.type === 'webhook' && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={webhookUrl}
            className="w-[32ch] font-mono text-xs px-2 py-1 rounded-md bg-surface-50 border border-surface-200 text-surface-500 focus:outline-none dark:bg-surface-900 dark:border-surface-800 dark:text-surface-400"
          />
          <button
            type="button"
            className="text-xs font-mono text-surface-500 hover:text-surface-900 px-2 py-1 rounded-md hover:bg-surface-100 transition-colors dark:text-surface-400 dark:hover:text-surface-50 dark:hover:bg-surface-800"
            onClick={() => {
              navigator.clipboard?.writeText(webhookUrl);
            }}
          >
            Copy
          </button>
        </div>
      )}

      {trigger.type === 'schedule' && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            data-testid="trigger-cron"
            placeholder="0 * * * *"
            value={trigger.cron}
            onChange={(e) =>
              setTrigger({
                type: 'schedule',
                cron: e.currentTarget.value,
                timezone: 'UTC'
              })
            }
            className="w-[16ch] font-mono text-xs px-2 py-1 rounded-md bg-white border border-surface-200 text-surface-900 focus:outline-none focus:border-surface-400 dark:bg-surface-900 dark:border-surface-700 dark:text-surface-100 dark:focus:border-surface-600"
          />
          <span className="text-xs font-mono text-surface-400 dark:text-surface-500">UTC</span>
        </div>
      )}
    </div>
  );
}
