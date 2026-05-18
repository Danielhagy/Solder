/*
 * Inspector — right-rail context panel for the workflow editor.
 *
 * Switches by `selection.kind`. Five panes (System, Object, Flow, Edge,
 * Empty) all live in this one file to keep the editor surface coherent.
 * MatchPanel is delegated to MatchingView (full-screen overlay).
 */
import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import { useProcessDiagramStore } from '@/stores/process-diagram';
import type {
  EdgeGuard,
  FieldMapping,
  Flow,
  ObjectNode,
  System,
} from '@/lib/process-diagram';

export default function Inspector() {
  const selection = useProcessDiagramStore((s) => s.selection);
  const doc = useProcessDiagramStore((s) => s.doc);

  if (!selection.kind || !selection.id) return <InspectorEmpty />;
  if (selection.kind === 'system') {
    const sys = doc.systems.find((s) => s.id === selection.id);
    if (!sys) return <InspectorEmpty />;
    return <SystemPanel sys={sys} />;
  }
  if (selection.kind === 'object') {
    const obj = doc.objects.find((o) => o.id === selection.id);
    if (!obj) return <InspectorEmpty />;
    return <ObjectPanel obj={obj} />;
  }
  if (selection.kind === 'flow') {
    const flow = doc.flows.find((f) => f.id === selection.id);
    if (!flow) return <InspectorEmpty />;
    return <FlowPanel flow={flow} />;
  }
  if (selection.kind === 'edge') {
    const edge = doc.edges.find((e) => e.id === selection.id);
    if (!edge) return <InspectorEmpty />;
    return <EdgePanel edge={edge} />;
  }
  return <InspectorEmpty />;
}


// ── Empty ───────────────────────────────────────────────────────────────


function InspectorEmpty() {
  return (
    <div>
      <Eyebrow>inspector</Eyebrow>
      <h2 style={H2}>Nothing selected</h2>
      <p style={Body}>
        Click a system, object, or flow on the canvas to inspect it. Click a
        flow arrow to map fields.
      </p>
      <SectionHead label="hint" />
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[
          'Click any arrow to map source → target fields.',
          'Click an object to see its schema and sample data.',
          'Use "Run sandbox" to flow synthetic data end-to-end.',
        ].map((tip, i) => (
          <li key={i} style={{ fontSize: 12.5, color: 'var(--surface-300)' }}>
            <span style={{ fontFamily: '"JetBrains Mono", monospace', color: 'var(--forge-500)', marginRight: 6 }}>▸</span>
            {tip}
          </li>
        ))}
      </ul>
    </div>
  );
}


// ── System ──────────────────────────────────────────────────────────────


function SystemPanel({ sys }: { sys: System }) {
  const doc = useProcessDiagramStore((s) => s.doc);
  const sysObjects = doc.objects.filter((o) => o.system === sys.id);
  return (
    <div>
      <Eyebrow>system</Eyebrow>
      <h2 style={H2}>{sys.label}</h2>
      <p style={{ ...Mono, color: 'var(--surface-400)', marginTop: 4 }}>{sys.role}</p>
      <SectionHead label="connection" />
      <KvGrid
        rows={[
          ['env', sys.env],
          ['auth', sys.auth],
          ['status', sys.connection],
        ]}
      />
      <SectionHead label={`objects modeled · ${sysObjects.length}`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {sysObjects.map((o) => (
          <div
            key={o.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              borderBottom: '1px dashed var(--rule)',
            }}
          >
            <span style={{ fontFamily: '"JetBrains Mono", monospace', color: sys.tint, width: 14 }}>
              {o.glyph}
            </span>
            <span style={{ ...Body, flex: 1 }}>{o.label}</span>
            <span style={{ ...Mono, color: 'var(--surface-400)', fontSize: 10.5 }}>
              {o.fields.length}f · {o.sample}s
            </span>
          </div>
        ))}
      </div>
      {sys.connectionId && (
        <>
          <SectionHead label="actions" />
          <a
            href={`/sandboxes?id=${encodeURIComponent(sys.connectionId)}`}
            target="_blank"
            rel="noreferrer"
            style={{
              ...Mono,
              color: 'var(--forge-500)',
              fontSize: 10.5,
              textDecoration: 'none',
            }}
            data-testid="inspector-system-view-sandbox"
          >
            View records in Sandboxes →
          </a>
        </>
      )}
    </div>
  );
}


// ── Object ──────────────────────────────────────────────────────────────


function ObjectPanel({ obj }: { obj: ObjectNode }) {
  const doc = useProcessDiagramStore((s) => s.doc);
  const sys = doc.systems.find((s) => s.id === obj.system);
  const usedBy = doc.flows.filter((f) => f.from === obj.id || f.to === obj.id);

  // Try to load 3 sample records from the bank
  const [samples, setSamples] = useState<Record<string, unknown>[]>([]);
  useEffect(() => {
    if (!sys?.connectionId || !obj.entityType) return;
    let alive = true;
    api
      .listBankEntities(sys.connectionId, obj.entityType, 3)
      .then((r) => {
        if (alive) setSamples(r.entities.map((e) => e.data));
      })
      .catch(() => {
        /* silent — bank may be empty */
      });
    return () => {
      alive = false;
    };
  }, [sys?.connectionId, obj.entityType]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Eyebrow>{sys?.label || 'system'} · object</Eyebrow>
        <Chip tone={obj.kind === 'mirror' ? 'info' : obj.kind === 'reference' ? 'accent' : 'warn'}>
          {obj.kind}
        </Chip>
      </div>
      <h2 style={H2}>{obj.label}</h2>
      <p style={{ ...Mono, color: 'var(--surface-400)', marginTop: 4 }}>
        {obj.fields.length} fields · {obj.sample} synthetic samples
      </p>

      <SectionHead label="schema" />
      <div>
        {obj.fields.map((f) => (
          <div
            key={f.name}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto 1fr',
              gap: 10,
              alignItems: 'baseline',
              padding: '4px 0',
              borderBottom: '1px dashed var(--rule)',
              ...Mono,
              fontSize: 11.5,
            }}
          >
            <span style={{ color: 'var(--surface-100)' }}>
              {f.name}
              {f.required && <span style={{ color: 'var(--forge-500)', marginLeft: 4 }}>*</span>}
              {f.pii && <span style={{ color: 'var(--violet-400)', marginLeft: 6, fontSize: 9 }}>pii</span>}
            </span>
            <span style={{ color: 'var(--surface-400)' }}>{f.type}</span>
            <span style={{ color: 'var(--surface-500)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {f.sample !== undefined ? String(f.sample) : f.enums ? f.enums.slice(0, 3).join(' | ') : ''}
            </span>
          </div>
        ))}
      </div>

      {samples.length > 0 && (
        <>
          <SectionHead label="sample record" />
          <pre
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              color: 'var(--surface-200)',
              background: 'var(--surface-800)',
              padding: 10,
              borderRadius: 6,
              overflow: 'auto',
              maxHeight: 220,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {JSON.stringify(samples[0], null, 2)}
          </pre>
        </>
      )}

      {usedBy.length > 0 && (
        <>
          <SectionHead label={`used by · ${usedBy.length}`} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {usedBy.map((f) => (
              <span key={f.id} style={{ ...Mono, color: 'var(--surface-200)', fontSize: 11 }}>
                <span style={{ color: 'var(--forge-500)' }}>→</span> {f.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// ── Flow ────────────────────────────────────────────────────────────────


function FlowPanel({ flow }: { flow: Flow }) {
  const doc = useProcessDiagramStore((s) => s.doc);
  const diagramId = useProcessDiagramStore((s) => s.diagramId);
  const updateDoc = useProcessDiagramStore((s) => s.updateDoc);
  const fromObj = doc.objects.find((o) => o.id === flow.from);
  const toObj = doc.objects.find((o) => o.id === flow.to);
  const fromSys = doc.systems.find((s) => s.id === fromObj?.system);
  const toSys = doc.systems.find((s) => s.id === toObj?.system);

  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!fromObj || !toObj) return <InspectorEmpty />;

  const mappings: FieldMapping[] = flow.mappings || [];

  async function handleSuggest() {
    if (!diagramId) return;
    setSuggesting(true);
    setError(null);
    try {
      const result = await api.suggestEdgeMappings(diagramId, flow.id);
      // Merge results into the flow's mappings — client-side, then the
      // store's autosave fires (no AI-write race).
      updateDoc((d) => {
        const fIdx = d.flows.findIndex((x) => x.id === flow.id);
        if (fIdx < 0) return;
        const fresh: FieldMapping[] = result.mappings.map((m, i) => ({
          id: `${flow.id}-m${i}`,
          targetPath: m.target_path,
          source: { kind: 'path', expression: m.source_expression },
          confidence: m.confidence,
          rationale: m.rationale,
          needs_review: m.needs_review,
          required: false,
          reviewed: !m.needs_review,
        }));
        d.flows[fIdx] = { ...d.flows[fIdx], mappings: fresh, mapped: fresh.length };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div>
      <Eyebrow>flow · {flow.role}</Eyebrow>
      <h2 style={H2}>{flow.label}</h2>
      <p style={{ ...Mono, color: 'var(--surface-400)', marginTop: 4 }}>
        {fromSys?.label}.{fromObj.label} → {toSys?.label}.{toObj.label}
      </p>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Chip tone={flow.mode === 'async' ? 'warn' : 'info'}>{flow.mode}</Chip>
        <Chip tone="neutral">{flow.direction}</Chip>
        <Chip tone="neutral">{flow.cadence}</Chip>
        {flow.native && <Chip tone="success">native</Chip>}
      </div>

      {flow.note && (
        <div
          style={{
            borderLeft: '2px solid var(--forge-500)',
            paddingLeft: 10,
            marginTop: 12,
            marginBottom: 4,
          }}
        >
          <p style={{ ...Body, color: 'var(--surface-200)', margin: 0 }}>{flow.note}</p>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
        <SectionHead label={`field mapping · ${mappings.length} of ${flow.total || fromObj.fields.length}`} inline />
        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggesting}
          style={{
            background: 'rgba(194,65,12,0.06)',
            border: '1px solid var(--forge-500)',
            color: 'var(--forge-500)',
            padding: '4px 10px',
            borderRadius: 4,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: suggesting ? 'not-allowed' : 'pointer',
            opacity: suggesting ? 0.6 : 1,
          }}
          data-testid="flow-suggest-mappings"
        >
          {suggesting ? '…' : '✦ ai suggest'}
        </button>
      </div>
      {error && (
        <div style={{ ...Body, color: 'var(--rose-500)', marginTop: 8 }}>{error}</div>
      )}

      {/* Mapping grid header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          gap: 8,
          padding: '6px 0',
          borderBottom: '1px solid var(--rule)',
          marginTop: 4,
        }}
      >
        <Eyebrow>{fromSys?.label || 'source'}</Eyebrow>
        <span />
        <Eyebrow>{toSys?.label || 'target'}</Eyebrow>
      </div>

      {mappings.length === 0 ? (
        <div style={{ ...Body, color: 'var(--surface-500)', padding: '12px 4px', fontStyle: 'italic' }}>
          No mappings yet. Click <strong>✦ ai suggest</strong> above to populate.
        </div>
      ) : (
        mappings.map((m) => {
          const conf = m.confidence ?? 1;
          const tier =
            conf >= 0.9 ? 'auto' : conf >= 0.7 ? 'review' : 'low';
          const rowBg =
            tier === 'auto'
              ? 'rgba(74,124,89,0.06)'
              : tier === 'review'
                ? 'rgba(194,65,12,0.08)'
                : 'transparent';
          const rowBorder =
            tier === 'auto'
              ? 'var(--emerald-500)'
              : tier === 'review'
                ? 'var(--forge-500)'
                : 'var(--rose-400)';
          return (
            <div
              key={m.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto 1fr auto',
                gap: 8,
                padding: '8px 10px',
                marginBottom: 4,
                background: rowBg,
                borderLeft: `3px solid ${rowBorder}`,
                borderRadius: 4,
                alignItems: 'center',
              }}
              title={m.rationale || ''}
            >
              <MappingPill
                label={m.source.kind === 'path' ? m.source.expression.replace('$.loop.item.', '') : '(literal)'}
                kind="source"
              />
              <span style={{ ...Mono, color: 'var(--surface-400)' }}>→</span>
              <MappingPill label={m.targetPath} kind="target" />
              <span
                style={{
                  ...Mono,
                  fontSize: 10,
                  fontWeight: 600,
                  color:
                    tier === 'auto'
                      ? 'var(--emerald-500)'
                      : tier === 'review'
                        ? 'var(--forge-500)'
                        : 'var(--rose-500)',
                  letterSpacing: '0.04em',
                  whiteSpace: 'nowrap',
                }}
              >
                {Math.round(conf * 100)}%
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}


function MappingPill({
  label,
  kind,
  confidence,
  reviewed,
}: {
  label: string;
  kind: 'source' | 'target';
  confidence?: number;
  reviewed?: boolean;
}) {
  const pip =
    kind !== 'target' || confidence == null
      ? null
      : confidence >= 0.9
        ? { color: 'var(--emerald-500)', text: '✓' }
        : confidence >= 0.7
          ? { color: 'var(--forge-500)', text: '?' }
          : { color: 'var(--rose-500)', text: '!' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--surface-800)',
        border: '1px solid var(--rule)',
        borderRadius: 4,
        padding: '3px 8px',
        ...Mono,
        fontSize: 11,
        minWidth: 0,
      }}
    >
      {pip && (
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: reviewed ? pip.color : `${pip.color}`,
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            opacity: reviewed ? 1 : 0.85,
          }}
          title={confidence ? `confidence ${(confidence * 100).toFixed(0)}%` : ''}
        >
          {pip.text}
        </span>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  );
}


// ── Edge guard ──────────────────────────────────────────────────────────


function EdgePanel({ edge }: { edge: EdgeGuard }) {
  const doc = useProcessDiagramStore((s) => s.doc);
  const tone =
    edge.kind === 'retry'
      ? 'var(--forge-500)'
      : edge.kind === 'fallback'
        ? 'var(--rose-400)'
        : 'var(--primary-500)';
  const attachedFlows = doc.flows.filter((f) => edge.attaches.includes(f.id));
  return (
    <div>
      <Eyebrow>edge guard · {edge.kind}</Eyebrow>
      <h2 style={{ ...H2, color: tone }}>{edge.label}</h2>
      <p style={{ ...Body, color: 'var(--surface-200)', marginTop: 8 }}>{edge.detail}</p>
      <SectionHead label="attached to" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {attachedFlows.map((f) => (
          <span key={f.id} style={{ ...Mono, color: 'var(--surface-200)', fontSize: 11 }}>
            <span style={{ color: tone }}>↳</span> {f.label}
          </span>
        ))}
      </div>
    </div>
  );
}


// ── Shared atoms ───────────────────────────────────────────────────────


const Body: React.CSSProperties = { fontSize: 13, color: 'var(--surface-300)', lineHeight: 1.5, margin: 0 };
const Mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12 };
const H2: React.CSSProperties = {
  fontFamily: '"Space Grotesk", Inter, sans-serif',
  fontSize: 18,
  fontWeight: 500,
  letterSpacing: '-0.015em',
  color: 'var(--surface-50)',
  margin: '4px 0 0',
};

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
        letterSpacing: '0.14em',
        color: 'var(--surface-500)',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}

function SectionHead({ label, inline }: { label: string; inline?: boolean }) {
  if (inline) return <Eyebrow>{label}</Eyebrow>;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '16px 0 8px',
      }}
    >
      <Eyebrow>{label}</Eyebrow>
      <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: 'info' | 'warn' | 'accent' | 'neutral' | 'success' }) {
  const colors: Record<string, [string, string]> = {
    info: ['var(--primary-500)', 'rgba(31,74,102,0.08)'],
    warn: ['var(--forge-500)', 'rgba(194,65,12,0.08)'],
    accent: ['var(--violet-400)', 'rgba(79,69,112,0.08)'],
    success: ['var(--emerald-500)', 'rgba(74,124,89,0.08)'],
    neutral: ['var(--surface-500)', 'transparent'],
  };
  const [fg, bg] = colors[tone];
  return (
    <span
      style={{
        ...Mono,
        fontSize: 10.5,
        color: fg,
        background: bg,
        border: `1px solid ${fg}`,
        borderRadius: 4,
        padding: '2px 6px',
        letterSpacing: '0.04em',
        textTransform: 'lowercase',
      }}
    >
      {children}
    </span>
  );
}


function KvGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 6, columnGap: 12, ...Mono }}>
      {rows.map(([k, v]) => (
        <FragmentRow key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span style={{ color: 'var(--surface-500)' }}>{k}</span>
      <span style={{ color: 'var(--surface-100)' }}>{v}</span>
    </>
  );
}
