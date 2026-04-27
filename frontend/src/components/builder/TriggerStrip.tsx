import Select, { type SelectOption } from '@/components/Select';
import { useIntegrationStore, type TriggerConfig } from '@/stores/integration';

type PillType = TriggerConfig['type'];

/**
 * TriggerStrip — second floating rail under the topbar.
 *
 * Collapsed to a single drafting-style dropdown: the active trigger
 * type reads at a glance, and clicking it both (a) lets the user
 * switch types AND (b) opens the full editor in the right rail. The
 * dense 4-pill rack felt like vestigial nav once the editor took over
 * cron / webhook config — one widget instead of four.
 *
 * Each option carries a glyph (▶ ⤳ ◷ ◆) so the trigger-type signature
 * lands instantly even before reading the label, matching the
 * picker-row icon slot in `RefPicker`. Disabled options stay visible
 * with a `soon` caption — keeps the roadmap legible without burying it.
 */
export default function TriggerStrip() {
  const trigger = useIntegrationStore((s) => s.trigger);
  const setTrigger = useIntegrationStore((s) => s.setTrigger);
  const selectTrigger = useIntegrationStore((s) => s.selectTrigger);
  const triggerSelected = useIntegrationStore((s) => s.triggerSelected);

  const options: SelectOption[] = [
    { value: 'manual', label: 'Manual', icon: <Glyph>▶</Glyph>, description: 'Run on demand' },
    { value: 'webhook', label: 'Webhook', icon: <Glyph>⤳</Glyph>, description: 'External HTTP call' },
    { value: 'schedule', label: 'Schedule', icon: <Glyph>◷</Glyph>, description: 'Cron-driven' },
    {
      value: 'on_event',
      label: 'Event',
      icon: <Glyph>◆</Glyph>,
      description: 'Source event',
      caption: 'soon',
      disabled: true,
    },
  ];

  function handleChange(next: string) {
    if (next !== trigger.type) {
      switch (next) {
        case 'manual':
          setTrigger({ type: 'manual' });
          break;
        case 'webhook':
          setTrigger({ type: 'webhook', secret: null });
          break;
        case 'schedule':
          setTrigger({ type: 'schedule', cron: '0 * * * *', timezone: 'UTC' });
          break;
        default:
          return; // disabled
      }
    }
    selectTrigger();
  }

  return (
    <div className="glass-rail rounded-xl px-4 py-1.5 flex items-center gap-3 pointer-events-auto">
      {/* Inline eyebrow — keeps the rail to one line so it doesn't
          encroach on the canvas the way the stacked label did. */}
      <span className="eyebrow flex-shrink-0">trigger</span>
      <Select
        value={trigger.type}
        onChange={handleChange}
        options={options}
        size="sm"
        width="14rem"
        ariaLabel="Trigger type"
        testid="trigger-select"
      />
      <button
        type="button"
        onClick={selectTrigger}
        className={`text-[11px] font-mono px-2 py-1 rounded-md transition-colors hover:bg-forge-500/[0.06] hover:text-forge-700 dark:hover:text-forge-400 flex-shrink-0 ${
          triggerSelected
            ? 'text-forge-700 dark:text-forge-300'
            : 'text-surface-500 dark:text-surface-400'
        }`}
        data-testid="trigger-edit-link"
      >
        {triggerSelected ? 'editing →' : 'configure →'}
      </button>
    </div>
  );
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] text-surface-500 dark:text-surface-400 leading-none">
      {children}
    </span>
  );
}
