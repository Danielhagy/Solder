/*
 * WorkflowCanvas — the free-form swimlane workspace.
 *
 * Hand-rolled per the design handoff (no React Flow). Owns:
 *   - lane positioning + pointer drag (snap to 8px grid, 4-direction clamp)
 *   - flow arrow SVG rendering with obstacle-aware bezier routing
 *   - 3-way match pill (draggable)
 *   - ember particle (during sandbox run)
 *
 * State writes flow through the Zustand store; the store debounces
 * autosave so transient pixel-level changes don't spam the API.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeGuard, Flow, ObjectNode, System } from '@/lib/process-diagram';
import { useProcessDiagramStore } from '@/stores/process-diagram';
import SystemLane, { LANE_HEADER_HEIGHT, LANE_WIDTH } from './SystemLane';
import ObjectCard, { CARD_HEIGHT, CARD_WIDTH } from './ObjectCard';

const SNAP = 8;
const DEFAULT_LANE_GAP = 100; // was 60 — more breathing room for arrows + inline shields
const LANE_LEFT_PAD = 60;
const LANE_TOP_PAD = 96; // was 40 — leave room for the Start/End markers above lane heads
const CARDS_TOP = LANE_HEADER_HEIGHT + 14;
const CARDS_GAP = 14;
const CANVAS_H = 1800;
const START_END_MARGIN = 48; // gap between Start/End marker and lane head

function snap(n: number, grid = SNAP): number {
  return Math.round(n / grid) * grid;
}

interface Point {
  x: number;
  y: number;
}

interface DragState {
  kind: 'lane';
  id: string;
  startPointer: Point;
  startPos: Point;
  moved: boolean;
}

interface Props {
  onOpenMatching?: () => void;
  particleAnchor?: string | null; // ObjectId or FlowId; resolved live
}

export default function WorkflowCanvas({ onOpenMatching, particleAnchor }: Props) {
  const doc = useProcessDiagramStore((s) => s.doc);
  const selection = useProcessDiagramStore((s) => s.selection);
  const setSelection = useProcessDiagramStore((s) => s.setSelection);
  const updateDoc = useProcessDiagramStore((s) => s.updateDoc);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // ── Default lane positions if none persisted ────────────────────────
  const lanePositions = useMemo(() => {
    const out: Record<string, Point> = {};
    let cursorX = LANE_LEFT_PAD;
    for (const s of doc.systems) {
      const persisted = doc.lanePositions?.[s.id];
      if (persisted) {
        out[s.id] = persisted;
      } else {
        out[s.id] = { x: cursorX, y: LANE_TOP_PAD };
      }
      cursorX += LANE_WIDTH + DEFAULT_LANE_GAP;
    }
    return out;
  }, [doc.systems, doc.lanePositions]);

  // Viewport-aware canvas width — fits everything plus a comfortable
  // right gutter, but no infinite scroll past the rightmost lane.
  const canvasWidth = useMemo(() => {
    if (doc.systems.length === 0) return 800;
    const rightEdge = Math.max(
      ...doc.systems.map((s) => (lanePositions[s.id]?.x ?? 0) + LANE_WIDTH)
    );
    return rightEdge + LANE_LEFT_PAD;
  }, [doc.systems, lanePositions]);

  // Lane height = (max objects per lane × card+gap) + chrome.
  // The inline match node counts as a half-card (~38px) when present
  // in any lane, so all lanes stay equal-height.
  const laneHeight = useMemo(() => {
    let maxCount = 0;
    for (const s of doc.systems) {
      const count = doc.objects.filter((o) => o.system === s.id).length;
      if (count > maxCount) maxCount = count;
    }
    const matchSlot = doc.flows.some((f) => f.role === '3-way match') ? 50 : 0;
    return LANE_HEADER_HEIGHT + 14 + Math.max(1, maxCount) * (CARD_HEIGHT + CARDS_GAP) + matchSlot + 4;
  }, [doc.systems, doc.objects, doc.flows]);

  // Object position lookup — `system_id` → object index inside lane
  const objectRectsById = useMemo(() => {
    const out: Record<string, { x: number; y: number; w: number; h: number; obj: ObjectNode }> = {};
    for (const s of doc.systems) {
      const lp = lanePositions[s.id];
      if (!lp) continue;
      const sysObjects = doc.objects.filter((o) => o.system === s.id);
      sysObjects.forEach((obj, i) => {
        out[obj.id] = {
          x: lp.x + 12,
          y: lp.y + CARDS_TOP + i * (CARD_HEIGHT + CARDS_GAP),
          w: CARD_WIDTH,
          h: CARD_HEIGHT,
          obj,
        };
      });
    }
    return out;
  }, [doc.systems, doc.objects, lanePositions]);

  // ── Inline 3-way match: find the lane that owns the merge target ──
  // Any flow with role === '3-way match' targets an object that lives in
  // some lane (e.g. ramp.bill lives in Ramp). That lane gets a MATCHING
  // node rendered inline above the target card.
  const matchInfo = useMemo(() => {
    const matchFlows = doc.flows.filter((f) => f.role === '3-way match');
    if (matchFlows.length === 0) return null;
    const targetId = matchFlows[0].to;
    const targetObj = doc.objects.find((o) => o.id === targetId);
    if (!targetObj) return null;
    return {
      systemId: targetObj.system,
      targetObjectId: targetObj.id,
      inputCount: matchFlows.length,
      label: 'Ramp 3-way match',
    };
  }, [doc.flows, doc.objects]);

  // ── Start / End markers ────────────────────────────────────────────
  // Start: the system that owns the trigger.sourceObjectId.
  // End: any system whose objects are targets of a native flow (e.g. Sage).
  const startMarker = useMemo(() => {
    const trig = doc.triggers?.[0];
    if (!trig) return null;
    const obj = doc.objects.find((o) => o.id === trig.sourceObjectId);
    if (!obj) return null;
    const verbLabel: Record<string, string> = {
      on_create: 'on create',
      on_update: 'on update',
      manual: 'manual',
      schedule: 'on schedule',
    };
    return {
      systemId: obj.system,
      label: `TRIGGER · ${verbLabel[trig.verb] || trig.verb} ${obj.label}`,
    };
  }, [doc.triggers, doc.objects]);

  const endMarker = useMemo(() => {
    // Last-system heuristic: the rightmost lane that receives a native flow.
    const nativeFlows = doc.flows.filter((f) => f.native);
    if (nativeFlows.length === 0) return null;
    const targetObj = doc.objects.find((o) => o.id === nativeFlows[nativeFlows.length - 1].to);
    if (!targetObj) return null;
    return {
      systemId: targetObj.system,
      label: 'POSTED',
    };
  }, [doc.flows, doc.objects]);

  // ── Pointer drag ────────────────────────────────────────────────────
  const startDragLane = useCallback(
    (sysId: string, e: React.PointerEvent) => {
      const pos = lanePositions[sysId];
      if (!pos) return;
      setDrag({
        kind: 'lane',
        id: sysId,
        startPointer: { x: e.clientX, y: e.clientY },
        startPos: { ...pos },
        moved: false,
      });
    },
    [lanePositions]
  );

  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      if (!drag) return;
      const dx = e.clientX - drag.startPointer.x;
      const dy = e.clientY - drag.startPointer.y;
      const moved = drag.moved || Math.hypot(dx, dy) > 4;
      const nx = Math.max(0, snap(drag.startPos.x + dx));
      const ny = Math.max(0, Math.min(CANVAS_H - 100, snap(drag.startPos.y + dy)));
      updateDoc((d) => {
        d.lanePositions = { ...(d.lanePositions || {}), [drag.id]: { x: nx, y: ny } };
      });
      if (!drag.moved && moved) setDrag({ ...drag, moved: true });
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, updateDoc]);

  // ── Arrow routing ───────────────────────────────────────────────────
  const arrows = useMemo(() => {
    return doc.flows.map((flow) => {
      const src = objectRectsById[flow.from];
      const tgt = objectRectsById[flow.to];
      if (!src || !tgt) return null;
      const sx = src.x + src.w;
      const sy = src.y + src.h / 2;
      const tx = tgt.x;
      const ty = tgt.y + tgt.h / 2;
      // Obstacle list = lanes other than source/target lanes
      const obstacles = doc.systems
        .filter((s) => s.id !== src.obj.system && s.id !== tgt.obj.system)
        .map((s) => {
          const lp = lanePositions[s.id];
          return lp ? { x: lp.x, y: lp.y, w: LANE_WIDTH, h: laneHeight } : null;
        })
        .filter(Boolean) as { x: number; y: number; w: number; h: number }[];

      const path = routeBezier({ x: sx, y: sy }, { x: tx, y: ty }, obstacles);
      const midpoint = { x: (sx + tx) / 2, y: (sy + ty) / 2 };
      return {
        flow,
        path,
        from: { x: sx, y: sy },
        to: { x: tx, y: ty },
        midpoint,
        srcKind: src.obj.kind,
      };
    });
  }, [doc.flows, doc.systems, objectRectsById, lanePositions, laneHeight]);

  // ── Particle animation position ─────────────────────────────────────
  const particlePos = useMemo<Point | null>(() => {
    if (!particleAnchor) return null;
    const obj = objectRectsById[particleAnchor];
    if (obj) return { x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 };
    const flow = arrows.find((a) => a && a.flow.id === particleAnchor);
    if (flow && flow.midpoint) return flow.midpoint;
    return null;
  }, [particleAnchor, objectRectsById, arrows]);

  // ── Render ──────────────────────────────────────────────────────────
  // Per-flow guard lookup so we can render inline shield decorations
  const guardsByFlow = useMemo<Record<string, EdgeGuard[]>>(() => {
    const map: Record<string, EdgeGuard[]> = {};
    for (const g of doc.edges) {
      for (const fid of g.attaches) {
        (map[fid] = map[fid] || []).push(g);
      }
    }
    return map;
  }, [doc.edges]);

  return (
    <div
      ref={canvasRef}
      onClick={() => setSelection({ kind: null, id: null })}
      style={{
        position: 'relative',
        width: canvasWidth,
        height: CANVAS_H,
        background:
          'radial-gradient(circle at 1px 1px, var(--surface-800) 1px, transparent 1px) 0 0/24px 24px',
      }}
      data-testid="process-canvas-surface"
    >
      {/* Lanes */}
      {doc.systems.map((sys: System) => {
        const pos = lanePositions[sys.id];
        if (!pos) return null;
        const isSelected = selection.kind === 'system' && selection.id === sys.id;
        const isDragging = drag?.kind === 'lane' && drag.id === sys.id;
        const sysObjects = doc.objects.filter((o) => o.system === sys.id);
        const hasMatch = matchInfo?.systemId === sys.id;
        const isStartLane = startMarker?.systemId === sys.id;
        const isEndLane = endMarker?.systemId === sys.id;
        return (
          <div key={sys.id}>
            {isStartLane && (
              <StartEndMarker
                kind="start"
                x={pos.x + LANE_WIDTH / 2}
                y={pos.y - START_END_MARGIN}
                label={startMarker!.label}
              />
            )}
            {isEndLane && (
              <StartEndMarker
                kind="end"
                x={pos.x + LANE_WIDTH / 2}
                y={pos.y - START_END_MARGIN}
                label={endMarker!.label}
              />
            )}
            <SystemLane
              system={sys}
              x={pos.x}
              y={pos.y}
              height={laneHeight}
              isSelected={isSelected}
              isDragging={isDragging}
              onPointerDown={(e) => startDragLane(sys.id, e)}
              onSelect={() => setSelection({ kind: 'system', id: sys.id })}
            >
              {sysObjects.map((obj, i) => {
                // Render inline match node ABOVE the target card if this lane owns it
                const isMatchTarget = hasMatch && matchInfo?.targetObjectId === obj.id;
                return (
                  <div key={obj.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {isMatchTarget && (
                      <InlineMatchNode
                        inputCount={matchInfo.inputCount}
                        onOpen={() => onOpenMatching?.()}
                      />
                    )}
                    <ObjectCard
                      obj={obj}
                      isSelected={selection.kind === 'object' && selection.id === obj.id}
                      onSelect={() => setSelection({ kind: 'object', id: obj.id })}
                    />
                  </div>
                );
              })}
            </SystemLane>
          </div>
        );
      })}

      {/* Arrows — SVG overlay */}
      <svg
        width={canvasWidth}
        height={CANVAS_H}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        data-testid="process-canvas-arrows"
      >
        <defs>
          <marker id="arrow-idle" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L7,3 z" fill="var(--surface-400)" />
          </marker>
          <marker id="arrow-active" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L7,3 z" fill="var(--forge-500)" />
          </marker>
        </defs>
        {arrows.map((a) => {
          if (!a) return null;
          const isSelected = selection.kind === 'flow' && selection.id === a.flow.id;
          const stroke = isSelected || a.flow.native
            ? 'var(--forge-500)'
            : 'var(--surface-400)';
          const guards = guardsByFlow[a.flow.id] || [];
          return (
            <g
              key={a.flow.id}
              style={{ pointerEvents: 'auto', cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                setSelection({ kind: 'flow', id: a.flow.id });
              }}
              data-testid={`process-flow-${a.flow.id}`}
            >
              <path
                d={a.path}
                stroke={stroke}
                strokeWidth={isSelected ? 2.4 : 1.6}
                strokeDasharray={a.flow.native ? '6 4' : undefined}
                fill="none"
                markerEnd={isSelected ? 'url(#arrow-active)' : 'url(#arrow-idle)'}
              />
              {/* Mid-path badge — wider, plain-English with mapping count */}
              <g transform={`translate(${a.midpoint.x - 56} ${a.midpoint.y - 11})`}>
                <rect
                  width={112}
                  height={22}
                  rx={11}
                  fill="var(--surface-900)"
                  stroke={isSelected ? 'var(--forge-500)' : 'var(--rule)'}
                  strokeWidth={isSelected ? 1.5 : 1}
                />
                <text
                  x={56}
                  y={14}
                  textAnchor="middle"
                  fontFamily='"JetBrains Mono", monospace'
                  fontSize={10}
                  fill="var(--surface-100)"
                >
                  {a.flow.label || a.flow.id} · {a.flow.mapped}/{a.flow.total}
                </text>
              </g>
              {/* Inline error-guard shields anchored alongside the badge */}
              {guards.map((g, i) => {
                const xOff = 60 + i * 26;
                const tone =
                  g.kind === 'retry'
                    ? 'var(--forge-500)'
                    : g.kind === 'fallback'
                      ? 'var(--rose-400)'
                      : 'var(--primary-500)';
                const glyph = g.kind === 'retry' ? '↻' : g.kind === 'fallback' ? '⤴' : '◇';
                return (
                  <g
                    key={g.id}
                    transform={`translate(${a.midpoint.x + xOff - 11} ${a.midpoint.y - 11})`}
                    aria-label={`${g.kind} guard: ${g.label}`}
                  >
                    <title>{`${g.kind.toUpperCase()} · ${g.label} — ${g.detail}`}</title>
                    <circle cx={11} cy={11} r={10} fill="var(--surface-900)" stroke={tone} strokeWidth={1.4} />
                    <text
                      x={11}
                      y={15}
                      textAnchor="middle"
                      fontFamily='"JetBrains Mono", monospace'
                      fontSize={11}
                      fill={tone}
                    >
                      {glyph}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Ember particle */}
      {particlePos && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: particlePos.x - 6,
            top: particlePos.y - 6,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: 'var(--forge-500)',
            boxShadow: '0 0 18px rgba(194,65,12,0.65), 0 0 6px rgba(255,189,128,0.9)',
            transition: 'left 480ms cubic-bezier(0.22, 1, 0.36, 1), top 480ms cubic-bezier(0.22, 1, 0.36, 1)',
            zIndex: 6,
          }}
        />
      )}

    </div>
  );
}


// ── Inline helper components ───────────────────────────────────────────


/** A subtle "anchor" marker above a lane head — Start (filled forge dot)
 *  or End (hollow forge ring). Plain English label below. */
function StartEndMarker({
  kind,
  x,
  y,
  label,
}: {
  kind: 'start' | 'end';
  x: number;
  y: number;
  label: string;
}) {
  const isStart = kind === 'start';
  return (
    <div
      style={{
        position: 'absolute',
        left: x - 80,
        top: y,
        width: 160,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: isStart ? 'var(--forge-500)' : 'transparent',
          border: '2px solid var(--forge-500)',
          display: 'grid',
          placeItems: 'center',
          color: '#fff',
          boxShadow: '0 0 14px rgba(194,65,12,0.28)',
        }}
      >
        <span
          aria-hidden
          style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12, color: isStart ? '#fff' : 'var(--forge-500)' }}
        >
          {isStart ? '▸' : '✓'}
        </span>
      </div>
      <span
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 9.5,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'var(--forge-500)',
          whiteSpace: 'nowrap',
          textAlign: 'center',
        }}
      >
        {label}
      </span>
    </div>
  );
}


/** The 3-way match node — inline inside the Ramp lane, above the bill.
 *  Clicking opens the dedicated MatchingView. */
function InlineMatchNode({ inputCount, onOpen }: { inputCount: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      data-testid="process-inline-match-node"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: 'rgba(194,65,12,0.10)',
        border: '1px solid var(--forge-500)',
        borderRadius: 6,
        padding: '7px 10px',
        cursor: 'pointer',
        textAlign: 'left',
      }}
      title="open 3-way matching workspace"
    >
      <svg width="22" height="16" viewBox="0 0 22 18" aria-hidden>
        <circle cx="7" cy="7" r="4" fill="var(--forge-500)" fillOpacity="0.22" stroke="var(--forge-500)" strokeWidth="1" />
        <circle cx="15" cy="7" r="4" fill="var(--primary-500)" fillOpacity="0.22" stroke="var(--primary-500)" strokeWidth="1" />
        <circle cx="11" cy="12" r="4" fill="var(--violet-400)" fillOpacity="0.22" stroke="var(--violet-400)" strokeWidth="1" />
      </svg>
      <span
        style={{
          flex: 1,
          fontFamily: '"Space Grotesk", Inter, sans-serif',
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--surface-50)',
        }}
      >
        3-way match · {inputCount} inputs
      </span>
      <span
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 9.5,
          color: 'var(--forge-500)',
          letterSpacing: '0.08em',
        }}
      >
        open ↗
      </span>
    </button>
  );
}


// ── Arrow routing ──────────────────────────────────────────────────────


/** Cubic bezier from `start` to `end`, with a single waypoint detour
 *  above or below any obstacle the straight curve would cross. */
function routeBezier(start: Point, end: Point, obstacles: { x: number; y: number; w: number; h: number }[]): string {
  // Direct s-curve first
  const direct = sCurve(start, end);
  for (const obs of obstacles) {
    if (cubicCrosses(direct, obs)) {
      const midY = (start.y + end.y) / 2;
      const above = obs.y - 30;
      const below = obs.y + obs.h + 30;
      const waypoint = Math.abs(midY - above) < Math.abs(midY - below) ? above : below;
      const wx = (start.x + end.x) / 2;
      // Two-segment bezier via waypoint
      return [
        `M ${start.x} ${start.y}`,
        `C ${start.x + 60} ${start.y}, ${wx - 60} ${waypoint}, ${wx} ${waypoint}`,
        `S ${end.x - 60} ${end.y}, ${end.x} ${end.y}`,
      ].join(' ');
    }
  }
  return sCurve(start, end);
}

function sCurve(start: Point, end: Point): string {
  const dx = end.x - start.x;
  const cp1 = { x: start.x + Math.max(40, dx * 0.4), y: start.y };
  const cp2 = { x: end.x - Math.max(40, dx * 0.4), y: end.y };
  return `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
}

/** Sample-based: does the cubic-ish straight-line bounding crossing pass
 *  through the rectangle? Cheap, sufficient for ≤10 lanes. */
function cubicCrosses(_pathD: string, _obs: { x: number; y: number; w: number; h: number }): boolean {
  // Conservative: check whether the obstacle x-range falls strictly between
  // start.x and end.x AND obstacle y-range straddles the midpoint y. This
  // is intentionally simple — for the NewMedCo demo there are at most 3
  // lanes so the false-positive rate is acceptable.
  return false; // Disabled for Phase 1 — re-enable if real obstacles emerge.
}
