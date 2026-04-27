import { useState } from 'react';
import {
  useIntegrationStore,
  type TriggerConfig,
  type WebhookSample,
} from '@/stores/integration';
import JsonBuilder from './JsonBuilder';

/**
 * TriggerEditor — right-rail editor that opens when the user clicks any
 * trigger pill in the strip. Three sections:
 *
 *   1. **Trigger config** — fields specific to the active type
 *      (cron + timezone for schedule, webhook URL/secret for webhook,
 *      etc.). Manual has no fields here; that's fine — it's still the
 *      header that tells the user "this is where you'd configure manual
 *      runs if there were anything to configure."
 *
 *   2. **Global variables** — `Record<string, unknown>` available to
 *      every node in the integration via `{{$.variables.<key>}}`.
 *      Uses the JsonBuilder so the user can put structured values
 *      under each key (not just strings), e.g. a `defaults` map.
 *
 *   3. **Test sample** — the payload the runtime hands to the
 *      integration when the user fires a test from the right rail.
 *      Manual: a single JSON value (any shape). Webhook: split into
 *      headers (string-to-string map) + body (any JSON shape).
 *      Schedule + on_event: skipped — their input is system-generated
 *      (timestamp / event payload from the source).
 */

type Tab = 'config' | 'variables' | 'sample';

export default function TriggerEditor() {
  const trigger = useIntegrationStore((s) => s.trigger);
  const setTrigger = useIntegrationStore((s) => s.setTrigger);
  const variables = useIntegrationStore((s) => s.variables);
  const setVariables = useIntegrationStore((s) => s.setVariables);
  const selectNode = useIntegrationStore((s) => s.selectNode);

  const [tab, setTab] = useState<Tab>('config');

  function close() {
    selectNode(null); // clears triggerSelected as a side-effect
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header — mirrors PropertiesPanel's chrome. */}
      <div className="px-4 pt-3 pb-3 bg-surface-50/50 border-b border-surface-200 dark:bg-surface-900/50 dark:border-surface-800">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">trigger</p>
            <h3
              className="font-display text-lg text-surface-900 dark:text-surface-50 truncate"
              data-testid="trigger-editor-title"
            >
              {triggerHeading(trigger.type)}
            </h3>
          </div>
          <button
            type="button"
            onClick={close}
            className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 text-lg leading-none px-1"
            aria-label="Close trigger editor"
            data-testid="trigger-editor-close"
          >
            ×
          </button>
        </div>

        <div className="mt-3 flex items-center rounded-md bg-surface-100 p-0.5 dark:bg-surface-900/60">
          <TabButton active={tab === 'config'} onClick={() => setTab('config')} testid="trigger-tab-config">
            Config
          </TabButton>
          <TabButton active={tab === 'variables'} onClick={() => setTab('variables')} testid="trigger-tab-variables">
            Variables
          </TabButton>
          <TabButton active={tab === 'sample'} onClick={() => setTab('sample')} testid="trigger-tab-sample">
            Test sample
          </TabButton>
        </div>
      </div>

      <div className="flex-1 overflow-auto solder-scroll-thin p-4 space-y-4">
        {tab === 'config' && <ConfigTab trigger={trigger} setTrigger={setTrigger} />}
        {tab === 'variables' && <VariablesTab variables={variables} setVariables={setVariables} />}
        {tab === 'sample' && <SampleTab trigger={trigger} setTrigger={setTrigger} />}
      </div>
    </div>
  );
}

function triggerHeading(t: TriggerConfig['type']): string {
  switch (t) {
    case 'manual':
      return 'Manual run';
    case 'webhook':
      return 'Webhook';
    case 'schedule':
      return 'Scheduled run';
    case 'on_event':
      return 'On event';
  }
}

function TabButton({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`flex-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        active
          ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-surface-50'
          : 'text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50'
      }`}
    >
      {children}
    </button>
  );
}

// ── Config tab ──────────────────────────────────────────────────────────

function ConfigTab({
  trigger,
  setTrigger,
}: {
  trigger: TriggerConfig;
  setTrigger: (t: TriggerConfig) => void;
}) {
  return (
    <div className="space-y-4">
      <TypePicker
        value={trigger.type}
        onChange={(t) => setTrigger(defaultForType(t, trigger))}
      />

      {trigger.type === 'manual' && (
        <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">
          Manual runs fire only when you hit <span className="font-mono">Run</span> in the topbar — useful for testing
          and one-off jobs. Set a sample payload in the <span className="font-mono">Test sample</span> tab to
          drive every test run from a known input.
        </p>
      )}

      {trigger.type === 'webhook' && (
        <div className="space-y-3">
          <Field label="Webhook URL" hint="Allocated when the integration is saved.">
            <input
              type="text"
              readOnly
              value="/api/webhooks/<pending>"
              className="input w-full font-mono text-xs text-surface-500 dark:text-surface-400"
            />
          </Field>
          <Field
            label="Shared secret"
            hint="Optional — when set, the runtime verifies the X-Solder-Signature header on every incoming request."
          >
            <input
              type="text"
              className="input w-full font-mono text-xs"
              value={trigger.secret ?? ''}
              onChange={(e) =>
                setTrigger({
                  type: 'webhook',
                  secret: e.currentTarget.value || null,
                  sample: trigger.sample,
                })
              }
              placeholder="(none)"
              data-testid="trigger-webhook-secret"
            />
          </Field>
        </div>
      )}

      {trigger.type === 'schedule' && (
        <div className="space-y-3">
          <Field label="Cron expression" hint="Standard 5-field cron (minute hour day-of-month month day-of-week).">
            <input
              type="text"
              className="input w-full font-mono text-xs"
              value={trigger.cron}
              onChange={(e) =>
                setTrigger({
                  type: 'schedule',
                  cron: e.currentTarget.value,
                  timezone: trigger.timezone ?? 'UTC',
                })
              }
              placeholder="0 * * * *"
              data-testid="trigger-cron-input"
            />
          </Field>
          <Field label="Timezone" hint="IANA name. Defaults to UTC.">
            <input
              type="text"
              className="input w-full font-mono text-xs"
              value={trigger.timezone ?? 'UTC'}
              onChange={(e) =>
                setTrigger({
                  type: 'schedule',
                  cron: trigger.cron,
                  timezone: e.currentTarget.value || 'UTC',
                })
              }
              data-testid="trigger-tz-input"
            />
          </Field>
        </div>
      )}

      {trigger.type === 'on_event' && (
        <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">
          Event triggers aren't wired in v1. Pick another trigger type for now.
        </p>
      )}
    </div>
  );
}

function TypePicker({
  value,
  onChange,
}: {
  value: TriggerConfig['type'];
  onChange: (t: TriggerConfig['type']) => void;
}) {
  const options: { id: TriggerConfig['type']; label: string; disabled?: boolean }[] = [
    { id: 'manual', label: 'Manual' },
    { id: 'webhook', label: 'Webhook' },
    { id: 'schedule', label: 'Schedule' },
    { id: 'on_event', label: 'Event', disabled: true },
  ];
  return (
    <Field label="Type">
      <div className="grid grid-cols-2 gap-1.5">
        {options.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => !o.disabled && onChange(o.id)}
              disabled={o.disabled}
              data-testid={`trigger-type-${o.id}`}
              className={`px-3 py-2 rounded-md text-sm transition-colors ${
                active
                  ? 'bg-forge-500/10 ring-1 ring-forge-500/40 text-forge-700 dark:text-forge-300'
                  : 'bg-surface-50 hover:bg-surface-100 text-surface-700 dark:bg-surface-900/40 dark:hover:bg-surface-800 dark:text-surface-200'
              } ${o.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {o.label}
              {o.disabled && (
                <span className="ml-1.5 text-[10px] font-mono text-surface-400">soon</span>
              )}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function defaultForType(t: TriggerConfig['type'], prev: TriggerConfig): TriggerConfig {
  if (t === prev.type) return prev;
  switch (t) {
    case 'manual':
      return { type: 'manual', sample: 'sample' in prev ? prev.sample : undefined };
    case 'webhook':
      return {
        type: 'webhook',
        secret: null,
        sample: undefined,
      };
    case 'schedule':
      return { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' };
    case 'on_event':
      return { type: 'on_event', source: '' };
  }
}

// ── Variables tab ───────────────────────────────────────────────────────

function VariablesTab({
  variables,
  setVariables,
}: {
  variables: Record<string, unknown>;
  setVariables: (v: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">
        Available to every node via{' '}
        <span className="font-mono text-surface-700 dark:text-surface-200">
          {'{{$.variables.<key>}}'}
        </span>
        . Use them for environment-style config — base URLs, retry counts, defaults.
      </p>
      <JsonBuilder
        value={variables as Record<string, never>}
        onChange={(v) => setVariables(v as Record<string, unknown>)}
        fixedRootKind="object"
      />
    </div>
  );
}

// ── Sample tab ──────────────────────────────────────────────────────────

function SampleTab({
  trigger,
  setTrigger,
}: {
  trigger: TriggerConfig;
  setTrigger: (t: TriggerConfig) => void;
}) {
  if (trigger.type === 'manual') {
    const sample = trigger.sample ?? {};
    return (
      <div className="space-y-3">
        <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">
          Build the JSON the integration receives on every test run. Defaults to an empty object —
          add fields below.
        </p>
        <JsonBuilder
          value={sample as never}
          onChange={(s) => setTrigger({ type: 'manual', sample: s })}
        />
      </div>
    );
  }

  if (trigger.type === 'webhook') {
    const sample: WebhookSample = trigger.sample ?? {};
    return (
      <div className="space-y-4">
        <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">
          Mock the request a webhook caller will send — both the headers and the JSON body.
        </p>
        <Field label="Headers">
          <JsonBuilder
            value={(sample.headers ?? {}) as never}
            onChange={(h) =>
              setTrigger({
                type: 'webhook',
                secret: trigger.secret ?? null,
                sample: { ...sample, headers: h as Record<string, string> },
              })
            }
            fixedRootKind="object"
            compact
          />
        </Field>
        <Field label="Body">
          <JsonBuilder
            value={(sample.body ?? {}) as never}
            onChange={(b) =>
              setTrigger({
                type: 'webhook',
                secret: trigger.secret ?? null,
                sample: { ...sample, body: b },
              })
            }
          />
        </Field>
      </div>
    );
  }

  return (
    <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">
      {trigger.type === 'schedule'
        ? 'Scheduled runs receive the firing timestamp + iteration metadata — nothing the user provides. Switch to a manual or webhook trigger if you need a custom payload.'
        : 'Event triggers will receive the source event payload at runtime.'}
    </p>
  );
}

// ── Shared field wrapper ───────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-surface-700 mb-1 dark:text-surface-200">
        {label}
      </span>
      {children}
      {hint && (
        <p className="mt-1 text-[11px] text-surface-500 dark:text-surface-400 leading-snug">
          {hint}
        </p>
      )}
    </label>
  );
}
