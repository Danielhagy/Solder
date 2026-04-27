import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import EmptyFrame from '@/components/EmptyFrame';

type SubTab = 'banks' | 'sessions' | 'corpus';

const SUBTABS: Array<{ id: SubTab; label: string; caption: string }> = [
  { id: 'banks', label: 'Test banks', caption: 'synthetic mirrors of source + target APIs' },
  { id: 'sessions', label: 'Sessions', caption: 'writable overlays scoped per run' },
  { id: 'corpus', label: 'Error corpus', caption: 'realistic API failures, hand-curated' }
];

/**
 * Mocks — lifts the mock-engine, test banks, and error corpus into their own
 * top-level surface. Sub-navigates via three internal tabs to keep the global
 * top-nav uncluttered.
 *
 * v1 shell scaffolds the structure with empty states. Each sub-tab fills in
 * as the backend endpoints land (test bank entity browser, mock-session
 * controls, corpus reader).
 */
export default function Mocks() {
  const [tab, setTab] = useState<SubTab>('banks');

  const active = SUBTABS.find((t) => t.id === tab) ?? SUBTABS[0];

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        eyebrow="mock-engine"
        title="Mocks"
        description={active.caption}
      />

      <div className="mb-6 flex items-center rounded-md bg-surface-100 p-1 dark:bg-surface-900/60 w-fit overflow-x-auto">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-surface-50'
                : 'text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-surface-50'
            }`}
            data-testid={`mocks-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'banks' && (
        <EmptyFrame
          label="state · awaiting backend"
          glyph="⛁"
          title="No test banks yet"
          description="Once an integration finishes discovery, its synthetic test banks (source + target) will land here. Browse entities, peek the golden record, and trigger a refresh when the live schema drifts."
        />
      )}

      {tab === 'sessions' && (
        <EmptyFrame
          label="state · idle"
          glyph="◷"
          title="No active mock sessions"
          description="Mock sessions are the writable overlay over the test bank for a single run. They appear here while a run is in flight, with reset and persist controls."
        />
      )}

      {tab === 'corpus' && (
        <EmptyFrame
          label="state · loading"
          glyph="✖"
          title="No connectors registered yet"
          description="Each connector ships a hand-curated set of realistic errors the API can return. They'll list here per-API once Zip and HubSpot land in v1."
        />
      )}
    </div>
  );
}
