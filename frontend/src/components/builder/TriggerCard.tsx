import { useIntegrationStore, type TriggerConfig } from '@/stores/integration';

/**
 * TriggerCard — synthetic "01" stage card pinned to the root canvas.
 *
 * The trigger isn't a real node in the graph (it lives at
 * `state.trigger`, not in `state.nodes`), but visually it reads as the
 * first step the runtime hands data to. Rendering it as a card on the
 * canvas matches the user's mental model: "the trigger is just the
 * step that starts the run." Click selects it, the right rail opens
 * the existing TriggerEditor, just like clicking any node.
 *
 * The card mimics NodeCard's silhouette so it slots into the column
 * row visually, but distinguishes itself with:
 *   - a small entry-arrow glyph in the icon slot per trigger type
 *   - a forge-tinted top-edge stripe (the "trigger band")
 *   - eyebrow `trigger` instead of a kind label, so users can tell
 *     it's the run's entry point at a glance
 */

const TRIGGER_GLYPH: Record<TriggerConfig['type'], string> = {
  manual: '▶',
  webhook: '⤳',
  schedule: '◷',
  on_event: '◆',
};

const TRIGGER_LABEL: Record<TriggerConfig['type'], string> = {
  manual: 'Manual',
  webhook: 'Webhook',
  schedule: 'Schedule',
  on_event: 'Event',
};

function captionFor(t: TriggerConfig): string {
  switch (t.type) {
    case 'manual':
      return 'Run on demand';
    case 'webhook':
      return t.secret ? 'Signed webhook' : 'Open webhook';
    case 'schedule':
      return `${t.cron} · ${t.timezone ?? 'UTC'}`;
    case 'on_event':
      return 'Event-driven';
  }
}

export default function TriggerCard() {
  const trigger = useIntegrationStore((s) => s.trigger);
  const triggerSelected = useIntegrationStore((s) => s.triggerSelected);
  const selectTrigger = useIntegrationStore((s) => s.selectTrigger);

  const glyph = TRIGGER_GLYPH[trigger.type];
  const label = TRIGGER_LABEL[trigger.type];
  const caption = captionFor(trigger);

  // Selected ring matches NodeCard's selection treatment so the
  // canvas's interaction language stays consistent.
  const selectedCls = triggerSelected
    ? 'ring-2 ring-forge-500 shadow-forge-glow'
    : 'ring-1 ring-surface-200 hover:ring-forge-500/40 dark:ring-surface-700 dark:hover:ring-forge-500/50';

  return (
    <button
      type="button"
      onClick={(e) => {
        // The canvas root scroller has `onClick={() => selectNode(null)}`
        // which clears every selection on bubble — including the one we
        // just set. Stop propagation so the trigger selection sticks.
        e.stopPropagation();
        selectTrigger();
      }}
      data-testid="trigger-card"
      data-state={triggerSelected ? 'selected' : 'idle'}
      className={`group relative w-full text-left rounded-xl bg-white dark:bg-surface-900 transition-all duration-150 ${selectedCls} overflow-hidden`}
    >
      {/* Forge-tinted top band — quietly marks this card as the entry
          point even when not selected. Same vocabulary as the run
          drawer's status bands so the system reads as one design. */}
      <div
        aria-hidden="true"
        className="h-[3px] w-full bg-gradient-to-r from-forge-500/70 via-forge-500/40 to-forge-500/0"
      />

      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-forge-500/30 bg-forge-500/[0.06] text-forge-700 dark:text-forge-300 font-mono text-sm leading-none"
        >
          {glyph}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="eyebrow text-forge-700/70 dark:text-forge-400/80">
              trigger
            </span>
            <span className="text-[10px] font-mono text-surface-400 dark:text-surface-500 truncate">
              {trigger.type}
            </span>
          </div>
          <div className="font-medium text-sm text-surface-900 dark:text-surface-50 truncate mt-0.5">
            {label}
          </div>
          <div className="text-[11px] font-mono text-surface-500 dark:text-surface-400 truncate">
            {caption}
          </div>
        </div>
      </div>
    </button>
  );
}
