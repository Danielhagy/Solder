/*
 * ProcessEditor — workflow-builder shell.
 *
 * Phase 1 scaffolding: header (name, env, save state, Generate, Run),
 * left rail (palette stub), canvas (Step 6 will mount the real WorkflowCanvas),
 * inspector rail (Step 7). The AI Gap-finder drawer (Step 9), Matching View
 * (Step 8), Client Mode (Step 10) and Sandbox Run Drawer (Step 11) are
 * stubbed and will light up in their respective steps.
 *
 * `?demo_replay=1` URL flag is read and exposed to children via context
 * so the AI surfaces serve from cache rather than the live API.
 */
import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '@/api/client';
import { useProcessDiagramStore } from '@/stores/process-diagram';
import { computeReadiness } from '@/lib/process-diagram';
import WorkflowCanvas from '@/components/process/WorkflowCanvas';
import Inspector from '@/components/process/Inspector';

export default function ProcessEditor() {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const [search] = useSearchParams();
  const demoReplay = search.get('demo_replay') === '1';

  const {
    diagramId,
    name,
    doc,
    saveStatus,
    saveError,
    integrationId,
    hydrate,
    setName,
    saveNow,
  } = useProcessDiagramStore();

  const id = params.id;

  useEffect(() => {
    if (!id) return;
    api
      .getDiagram(id)
      .then(hydrate)
      .catch((e) => {
        console.error('Failed to load diagram', e);
      });
  }, [id, hydrate]);

  // Save-on-unmount safety net so the user never loses the last debounced edit.
  useEffect(() => {
    return () => {
      void saveNow();
    };
  }, [saveNow]);

  if (!id) {
    return (
      <div style={{ padding: 32, color: 'var(--surface-300)' }}>
        Redirecting…
        <script>{(() => { setTimeout(() => navigate('/processes', { replace: true }), 0); return ''; })()}</script>
      </div>
    );
  }

  if (!diagramId) {
    return (
      <div
        style={{
          padding: 32,
          color: 'var(--surface-500)',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11,
        }}
      >
        loading process…
      </div>
    );
  }

  const readiness = computeReadiness(doc);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ── Topbar ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid var(--rule)',
          background: 'var(--container-glaze)',
        }}
      >
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            letterSpacing: '0.14em',
            color: 'var(--surface-500)',
            textTransform: 'uppercase',
          }}
        >
          workflow · {doc.client || 'untitled'}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          spellCheck={false}
          style={{
            fontFamily: '"Space Grotesk", Inter, sans-serif',
            fontSize: 16.5,
            fontWeight: 500,
            letterSpacing: '-0.015em',
            color: 'var(--surface-50)',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            minWidth: 220,
          }}
          data-testid="process-editor-name"
        />

        <div style={{ flex: 1 }} />

        {/* Build readiness pip — Step 9 wires the AI gap-finder drawer to this */}
        <button
          type="button"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            border: '1px solid var(--rule)',
            background: 'transparent',
            borderRadius: 999,
            cursor: 'pointer',
          }}
          title="build readiness · ask AI to find gaps"
          data-testid="process-editor-readiness"
        >
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: readiness >= 80 ? 'var(--emerald-400)' : readiness >= 60 ? 'var(--forge-400)' : 'var(--rose-400)',
            }}
          />
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              color: 'var(--surface-100)',
            }}
          >
            {readiness}% ready
          </span>
        </button>

        {/* Save state pill */}
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            color:
              saveStatus === 'error'
                ? 'var(--rose-500)'
                : saveStatus === 'saved'
                  ? 'var(--emerald-500)'
                  : 'var(--surface-500)',
          }}
          data-testid="process-editor-save-state"
        >
          {saveStatus === 'error'
            ? 'save failed'
            : saveStatus === 'saving'
              ? 'saving…'
              : saveStatus === 'pending'
                ? 'unsaved'
                : saveStatus === 'saved'
                  ? 'saved'
                  : 'idle'}
        </span>

        {integrationId && (
          <button
            type="button"
            onClick={() => navigate(`/integrations/${integrationId}`)}
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '7px 12px',
              borderRadius: 4,
              border: '1px solid var(--rule)',
              background: 'transparent',
              color: 'var(--surface-100)',
              cursor: 'pointer',
            }}
          >
            ↗ open integration
          </button>
        )}

        <button
          type="button"
          onClick={async () => {
            await saveNow();
            try {
              const result = await api.generateIntegrationFromDiagram(diagramId);
              navigate(`/integrations/${result.integration_id}?from=process=${diagramId}`);
            } catch (e) {
              console.error('Generate failed', e);
              alert(e instanceof Error ? e.message : String(e));
            }
          }}
          className="solder-cta-forge"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '7px 12px',
            borderRadius: 4,
            fontWeight: 600,
            cursor: 'pointer',
          }}
          data-testid="process-editor-generate"
        >
          Generate
        </button>
      </header>

      {/* ── Three-column body ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left rail — palette stub (full version in Step 6 + onward) */}
        <aside
          style={{
            width: 200,
            borderRight: '1px solid var(--rule)',
            padding: 14,
            background: 'var(--container-glaze)',
            overflowY: 'auto',
          }}
          data-testid="process-editor-left-rail"
        >
          <div
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
              letterSpacing: '0.14em',
              color: 'var(--surface-500)',
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            outline
          </div>
          <div
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              color: 'var(--surface-400)',
              lineHeight: 1.6,
            }}
          >
            {doc.systems.length === 0
              ? 'No systems yet — drop one onto the canvas to start.'
              : doc.systems.map((s) => <div key={s.id}>{s.label}</div>)}
          </div>
        </aside>

        {/* Canvas — Step 6 mounts WorkflowCanvas here */}
        <main
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'auto',
            background: 'var(--surface-950)',
          }}
          data-testid="process-editor-canvas"
        >
          <WorkflowCanvas onOpenMatching={() => { /* Step 8 wires Matching View */ }} />
          {demoReplay && (
            <div
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                padding: '4px 8px',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10,
                color: 'var(--forge-400)',
                border: '1px solid var(--forge-500)',
                borderRadius: 4,
                background: 'rgba(194,65,12,0.08)',
                zIndex: 10,
              }}
            >
              demo_replay=1
            </div>
          )}
        </main>

        {/* Inspector — Step 7 mounts panels here */}
        <aside
          style={{
            width: 332,
            borderLeft: '1px solid var(--rule)',
            padding: 14,
            background: 'var(--container-glaze)',
            overflowY: 'auto',
          }}
          data-testid="process-editor-inspector"
        >
          <Inspector />
          {saveError && (
            <div
              style={{
                marginTop: 12,
                padding: '8px 10px',
                border: '1px solid var(--rose-400)',
                borderRadius: 4,
                color: 'var(--rose-500)',
                fontSize: 11.5,
              }}
            >
              Save error: {saveError}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
