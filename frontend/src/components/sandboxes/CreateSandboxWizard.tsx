/*
 * CreateSandboxWizard — "+ Sandbox from Spec" flow.
 *
 * Five steps wrapped in a single modal so the user never loses orientation:
 *   1. Pick connector       (typed list from /api/connectors)
 *   2. Pick spec source     (one of the seeded /api/openapi rows)
 *   3. Filter by tag        (chip multiselect, defaults to all tags)
 *   4. Pick endpoints       (checkbox list, filtered by selected tags)
 *   5. Review + commit      (label, base URL, submit)
 *
 * On submit the wizard chains three calls:
 *   POST /connections                              ← create the row
 *   PUT  /connections/{id}/sandbox    {mode:'synthetic'}
 *   POST /connections/{id}/sandbox/ingest-openapi  {openapi_spec_id, endpoint_allowlist}
 *
 * Then `onCreated(id)` is fired so the parent page can navigate to the
 * new connection's detail. Failure at any step rolls forward, not back —
 * the connection stays in synthetic mode with whatever endpoints made
 * it through, and the modal surfaces the error so the user can re-run
 * just the ingest step from the connection detail later.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type Connector, type OpenAPISpec } from '@/api/client';

type Step = 1 | 2 | 3 | 4 | 5;

interface SpecEndpoint {
  method: string;
  path: string;
  operation_id: string | null;
  summary: string;
  tags: string[];
  deprecated: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (connectionId: string) => void;
}

const eyebrow: React.CSSProperties = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--surface-500)',
};

const stepLabels = ['Connector', 'Spec', 'Tags', 'Endpoints', 'Review'] as const;

export function CreateSandboxWizard({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Step 1
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorId, setConnectorId] = useState<string>('');

  // Step 2
  const [specs, setSpecs] = useState<OpenAPISpec[]>([]);
  const [specId, setSpecId] = useState<string>('');

  // Step 3 + 4
  const [endpoints, setEndpoints] = useState<SpecEndpoint[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Step 5
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  // Reset everything on close so a re-open starts fresh.
  useEffect(() => {
    if (!open) {
      setStep(1);
      setError('');
      setBusy(false);
      setConnectorId('');
      setSpecId('');
      setEndpoints([]);
      setAllTags([]);
      setActiveTags(new Set());
      setPicked(new Set());
      setLabel('');
      setBaseUrl('');
    }
  }, [open]);

  // Step 1: load connectors.
  useEffect(() => {
    if (!open) return;
    api
      .listConnectors()
      .then(setConnectors)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load connectors'));
  }, [open]);

  // Step 2: load specs the moment a connector is picked. Default the
  // selected spec to whichever published name starts with the connector's
  // display_name (e.g. "Ramp Developer API ..." matches the Ramp
  // connector). Saves a click in the common case.
  useEffect(() => {
    if (!open || !connectorId) return;
    api
      .listOpenAPISpecs()
      .then((rows) => {
        setSpecs(rows);
        const connector = connectors.find((c) => c.id === connectorId);
        if (connector && rows.length) {
          const display = connector.display_name.toLowerCase();
          const match =
            rows.find((r) => r.name.toLowerCase().startsWith(display)) ?? rows[0];
          setSpecId(match.id);
        }
        // Default base_url + label from the connector so the review
        // step is mostly pre-filled.
        if (connector) {
          setBaseUrl(connector.base_url);
          setLabel((prev) => prev || `${connector.display_name} sandbox`);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load specs'));
  }, [open, connectorId, connectors]);

  // Step 3+4: load endpoints when a spec is picked.
  useEffect(() => {
    if (!open || !specId) return;
    api
      .listSpecEndpoints(specId)
      .then((res) => {
        setEndpoints(res.endpoints);
        setAllTags(res.tags);
        // Default: all tags active (no filtering until user starts
        // picking). Empty tag set means "any operation passes" so the
        // checklist starts maximal.
        setActiveTags(new Set(res.tags));
        // Pre-pick GET collections on common procurement paths so the
        // demo walkthrough is one click away from a working sandbox.
        // The user can refine in step 4.
        const seed = new Set<string>();
        for (const e of res.endpoints) {
          if (e.method === 'GET' && !e.path.includes('{')) seed.add(`${e.method} ${e.path}`);
        }
        setPicked(seed);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load endpoints'));
  }, [open, specId]);

  const visibleEndpoints = useMemo(() => {
    if (!activeTags.size) return endpoints;
    return endpoints.filter((e) => e.tags.some((t) => activeTags.has(t)) || e.tags.length === 0);
  }, [endpoints, activeTags]);

  const visibleKeys = useMemo(
    () => new Set(visibleEndpoints.map((e) => `${e.method} ${e.path}`)),
    [visibleEndpoints]
  );

  function toggleTag(t: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function toggleEndpoint(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllVisible() {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of visibleKeys) next.add(k);
      return next;
    });
  }

  function clearAllVisible() {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of visibleKeys) next.delete(k);
      return next;
    });
  }

  async function commit() {
    if (!connectorId || !specId || !label || !picked.size) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createConnection({
        label,
        connector_id: connectorId,
        // Bearer is the placeholder until the real OAuth flow lands.
        // Required so the mock engine's auth_bearer validator passes.
        secrets: { token: 'demo-placeholder-token' },
        base_url: baseUrl || undefined,
      });
      await api.updateConnectionSandbox(created.id, { mode: 'synthetic' });
      await api.ingestOpenAPIIntoSandbox(created.id, {
        openapi_spec_id: specId,
        endpoint_allowlist: Array.from(picked),
      });
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sandbox creation failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const canAdvance: Record<Step, boolean> = {
    1: !!connectorId,
    2: !!specId,
    3: true,
    4: picked.size > 0,
    5: !!label,
  };

  return (
    <div
      role="dialog"
      aria-label="Create sandbox from spec"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgb(0 0 0 / 0.55)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
      data-testid="sandbox-wizard"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-900)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
          padding: '24px 28px 20px',
          width: 720,
          maxWidth: '100%',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 18px 48px rgb(0 0 0 / 0.4)',
        }}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <span style={eyebrow}>WIZARD · STEP {step} OF 5</span>
            <h2
              style={{
                fontFamily: '"Space Grotesk", Inter, sans-serif',
                fontSize: 22,
                margin: '6px 0 0',
                color: 'var(--surface-50)',
                letterSpacing: '-0.01em',
              }}
            >
              Sandbox from Spec — {stepLabels[step - 1]}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wizard"
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 20,
              color: 'var(--surface-400)',
              cursor: 'pointer',
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </header>

        {/* Step rail — hairline progress + clickable backwards */}
        <nav
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 6,
            paddingBottom: 4,
            borderBottom: '1px solid var(--rule)',
          }}
        >
          {stepLabels.map((lbl, i) => {
            const num = (i + 1) as Step;
            const reached = num <= step;
            return (
              <button
                key={lbl}
                type="button"
                disabled={num > step}
                onClick={() => setStep(num)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: '4px 0 8px',
                  borderBottom: reached
                    ? '2px solid var(--forge-400)'
                    : '2px solid var(--rule)',
                  color: reached ? 'var(--surface-50)' : 'var(--surface-500)',
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11,
                  letterSpacing: '0.08em',
                  textAlign: 'left',
                  cursor: num <= step ? 'pointer' : 'not-allowed',
                  textTransform: 'uppercase',
                }}
              >
                {String(num).padStart(2, '0')} · {lbl}
              </button>
            );
          })}
        </nav>

        <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4 }}>
          {step === 1 && (
            <StepConnector
              connectors={connectors}
              value={connectorId}
              onChange={setConnectorId}
            />
          )}
          {step === 2 && (
            <StepSpec specs={specs} value={specId} onChange={setSpecId} />
          )}
          {step === 3 && (
            <StepTags
              allTags={allTags}
              active={activeTags}
              toggle={toggleTag}
              endpointsCount={endpoints.length}
              visibleCount={visibleEndpoints.length}
            />
          )}
          {step === 4 && (
            <StepEndpoints
              visible={visibleEndpoints}
              picked={picked}
              toggle={toggleEndpoint}
              selectAll={selectAllVisible}
              clearAll={clearAllVisible}
            />
          )}
          {step === 5 && (
            <StepReview
              connector={connectors.find((c) => c.id === connectorId)}
              spec={specs.find((s) => s.id === specId)}
              picked={picked}
              label={label}
              setLabel={setLabel}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
            />
          )}
        </div>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 12px',
              border: '1px solid var(--rose-400)',
              borderRadius: 4,
              background: 'rgb(179 58 58 / 0.1)',
              color: 'var(--rose-500)',
              fontSize: 12.5,
            }}
          >
            {error}
          </div>
        )}

        <footer
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: 12,
            borderTop: '1px solid var(--rule)',
          }}
        >
          <button
            type="button"
            onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}
            disabled={step === 1 || busy}
            style={btnGhost(step === 1 || busy)}
          >
            ← Back
          </button>
          <span style={{ ...eyebrow, color: 'var(--surface-500)' }}>
            {picked.size} endpoints picked
          </span>
          {step < 5 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s + 1) as Step)}
              disabled={!canAdvance[step] || busy}
              style={btnPrimary(!canAdvance[step] || busy)}
              data-testid="sandbox-wizard-next"
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={commit}
              disabled={!canAdvance[5] || busy || !picked.size}
              style={btnPrimary(!canAdvance[5] || busy || !picked.size)}
              data-testid="sandbox-wizard-commit"
            >
              {busy ? 'Creating…' : 'Create sandbox'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ── Step components — flat, file-local for one-glance reading ── */

function StepConnector({
  connectors,
  value,
  onChange,
}: {
  connectors: Connector[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ color: 'var(--surface-300)', fontSize: 13, margin: 0 }}>
        The connector defines defaults (auth scheme, base URL, brand) for the new sandbox connection.
      </p>
      {connectors.map((c) => {
        const selected = c.id === value;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            data-testid={`sandbox-wizard-connector-${c.name}`}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 4,
              border: selected ? '1px solid var(--forge-400)' : '1px solid var(--rule)',
              background: selected ? 'rgb(194 65 12 / 0.08)' : 'transparent',
              color: 'var(--surface-100)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600 }}>{c.display_name}</div>
            <div
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                color: 'var(--surface-500)',
                marginTop: 3,
              }}
            >
              {c.auth_scheme} · {c.base_url}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function StepSpec({
  specs,
  value,
  onChange,
}: {
  specs: OpenAPISpec[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (!specs.length)
    return <p style={{ color: 'var(--surface-400)' }}>No OpenAPI specs available. Upload one from the OpenAPI page first.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ color: 'var(--surface-300)', fontSize: 13, margin: 0 }}>
        Pick the spec that defines the API surface for this sandbox.
      </p>
      {specs.map((s) => {
        const selected = s.id === value;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 4,
              border: selected ? '1px solid var(--forge-400)' : '1px solid var(--rule)',
              background: selected ? 'rgb(194 65 12 / 0.08)' : 'transparent',
              color: 'var(--surface-100)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600 }}>{s.name}</div>
            <div
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                color: 'var(--surface-500)',
                marginTop: 3,
              }}
            >
              v{s.version}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function StepTags({
  allTags,
  active,
  toggle,
  endpointsCount,
  visibleCount,
}: {
  allTags: string[];
  active: Set<string>;
  toggle: (t: string) => void;
  endpointsCount: number;
  visibleCount: number;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ color: 'var(--surface-300)', fontSize: 13, margin: 0 }}>
        Tags filter the endpoint checklist on the next step. Toggle any tag off to hide its
        operations. Endpoints with no tag are always shown.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {allTags.length === 0 && (
          <span style={{ color: 'var(--surface-500)', fontSize: 12 }}>
            This spec has no tags — all endpoints will appear in the next step.
          </span>
        )}
        {allTags.map((t) => {
          const on = active.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                border: on ? '1px solid var(--forge-400)' : '1px solid var(--rule)',
                background: on ? 'rgb(194 65 12 / 0.12)' : 'transparent',
                color: on ? 'var(--forge-400)' : 'var(--surface-400)',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'Inter, system-ui, sans-serif',
              }}
            >
              {t}
            </button>
          );
        })}
      </div>
      <div style={{ ...eyebrow, color: 'var(--surface-500)' }}>
        {visibleCount} of {endpointsCount} endpoints visible
      </div>
    </div>
  );
}

function StepEndpoints({
  visible,
  picked,
  toggle,
  selectAll,
  clearAll,
}: {
  visible: SpecEndpoint[];
  picked: Set<string>;
  toggle: (key: string) => void;
  selectAll: () => void;
  clearAll: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <p style={{ color: 'var(--surface-300)', fontSize: 13, margin: 0 }}>
          Pick the operations to expose in the sandbox. Only checked operations are reachable
          via the mock engine.
        </p>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={selectAll} style={btnSubtle()}>
            Select all
          </button>
          <button type="button" onClick={clearAll} style={btnSubtle()}>
            Clear
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.map((e) => {
          const key = `${e.method} ${e.path}`;
          const on = picked.has(key);
          return (
            <label
              key={key}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 70px 1fr',
                gap: 10,
                alignItems: 'center',
                padding: '6px 8px',
                borderRadius: 4,
                background: on ? 'rgb(194 65 12 / 0.06)' : 'transparent',
                cursor: 'pointer',
                fontSize: 12.5,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(key)}
                data-testid={`sandbox-wizard-endpoint-${key}`}
                style={{ accentColor: 'var(--forge-400)' }}
              />
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11,
                  color:
                    e.method === 'GET'
                      ? 'var(--primary-400)'
                      : e.method === 'POST'
                        ? 'var(--forge-400)'
                        : 'var(--surface-400)',
                  fontWeight: 600,
                }}
              >
                {e.method}
              </span>
              <span style={{ color: 'var(--surface-100)' }}>
                <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
                  {e.path}
                </span>
                {e.summary && (
                  <span
                    style={{
                      color: 'var(--surface-500)',
                      fontSize: 11,
                      marginLeft: 8,
                    }}
                  >
                    — {e.summary}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function StepReview({
  connector,
  spec,
  picked,
  label,
  setLabel,
  baseUrl,
  setBaseUrl,
}: {
  connector?: Connector;
  spec?: OpenAPISpec;
  picked: Set<string>;
  label: string;
  setLabel: (s: string) => void;
  baseUrl: string;
  setBaseUrl: (s: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ color: 'var(--surface-300)', fontSize: 13, margin: 0 }}>
        Last look. The sandbox connection lands in <code>synthetic</code> mode — switch to
        live by changing the base URL on the connection later.
      </p>
      <Field label="Connector" value={connector?.display_name ?? '—'} />
      <Field label="Spec" value={spec ? `${spec.name} v${spec.version}` : '—'} />
      <Field label="Endpoints" value={`${picked.size} operations`} />
      <FieldInput label="Connection label" value={label} onChange={setLabel} />
      <FieldInput
        label="Base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder="https://demo-api.ramp.com"
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ ...eyebrow, marginBottom: 2 }}>{label}</div>
      <div style={{ color: 'var(--surface-100)', fontSize: 13 }}>{value}</div>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ ...eyebrow, marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '8px 10px',
          background: 'var(--container-fill)',
          color: 'var(--surface-50)',
          border: '1px solid var(--rule)',
          borderRadius: 4,
          fontSize: 13,
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      />
    </label>
  );
}

function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    background: 'var(--forge-500)',
    border: 'none',
    color: 'white',
    padding: '8px 14px',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 11,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontWeight: 600,
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

function btnGhost(disabled: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--rule)',
    color: 'var(--surface-300)',
    padding: '8px 14px',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 11,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

function btnSubtle(): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--rule)',
    color: 'var(--surface-300)',
    padding: '4px 10px',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 10.5,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    borderRadius: 3,
    cursor: 'pointer',
  };
}
