/*
 * Process list — index page for all workflow-builder diagrams. The
 * editor itself lives at /processes/:id (ProcessEditor.tsx).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { blankDiagramDoc } from '@/lib/process-diagram';

interface Row {
  id: string;
  name: string;
  description: string | null;
  document: Record<string, unknown>;
  integration_id: string | null;
  updated_at: string;
}

export default function ProcessList() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listDiagrams()
      .then((r) => {
        if (alive) setRows(r as Row[]);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function handleCreate() {
    setCreating(true);
    try {
      const doc = blankDiagramDoc({ client: 'New process', title: 'Untitled process' });
      const row = await api.createDiagram({
        name: 'Untitled process',
        document: doc as unknown as Record<string, unknown>,
      });
      navigate(`/processes/${row.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  }

  return (
    <div
      className="sol-canvas"
      style={{
        padding: '28px 32px',
        minHeight: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
        fontFamily: 'Inter, system-ui, sans-serif',
        borderRadius: 12,
        margin: '0 auto',
        maxWidth: 1400,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBottom: 18,
          marginBottom: 22,
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <div>
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
              letterSpacing: '0.14em',
              color: 'var(--surface-500)',
              textTransform: 'uppercase',
            }}
          >
            SOLDER · WORKFLOW
          </span>
          <h1
            style={{
              fontFamily: '"Space Grotesk", Inter, sans-serif',
              fontSize: 28,
              fontWeight: 600,
              color: 'var(--surface-50)',
              letterSpacing: '-0.02em',
              margin: 0,
              lineHeight: 1,
              marginTop: 6,
            }}
          >
            Processes
          </h1>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="solder-cta-forge"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '7px 12px',
            borderRadius: 4,
            cursor: creating ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}
          data-testid="processes-new"
        >
          + New process
        </button>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 18,
            padding: '10px 14px',
            border: '1px solid var(--rose-400)',
            borderRadius: 6,
            background: 'rgb(179 58 58 / 0.08)',
            color: 'var(--rose-500)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--surface-500)', fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
          loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--surface-700)',
            borderRadius: 8,
            padding: '48px 32px',
            textAlign: 'center',
            background: 'var(--container-fill)',
          }}
        >
          <p
            style={{
              fontSize: 13,
              color: 'var(--surface-400)',
              maxWidth: 460,
              margin: '0 auto 18px',
              lineHeight: 1.5,
            }}
          >
            No process diagrams yet. Draw one with the workflow builder, then click
            <strong> Generate</strong> to produce a runnable integration.
          </p>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="solder-cta-forge"
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '9px 14px',
              borderRadius: 4,
              cursor: creating ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            Draft a process
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((row, idx) => (
            <button
              key={row.id}
              type="button"
              onClick={() => navigate(`/processes/${row.id}`)}
              data-testid={`process-row-${row.id}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr auto auto',
                gap: 12,
                alignItems: 'center',
                padding: '10px 8px',
                borderTop: idx === 0 ? '1px solid var(--rule)' : 'none',
                borderBottom: '1px solid var(--rule)',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 10,
                  color: 'var(--surface-600)',
                }}
              >
                {String(idx + 1).padStart(2, '0')}
              </span>
              <span
                style={{
                  fontFamily: '"Space Grotesk", Inter, sans-serif',
                  fontSize: 14,
                  color: 'var(--surface-50)',
                }}
              >
                {row.name}
              </span>
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 10.5,
                  color: 'var(--surface-500)',
                }}
              >
                {row.integration_id ? 'linked' : 'draft'}
              </span>
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 10.5,
                  color: 'var(--surface-500)',
                }}
              >
                {new Date(row.updated_at).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
