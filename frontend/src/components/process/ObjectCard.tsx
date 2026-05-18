/*
 * ObjectCard — one entity card inside a swimlane.
 *
 * Procurement-vocab icon (regex-mapped from label) + label header,
 * one-line plain-English STORY ("8 active POs · webhook on .approved"),
 * compact metadata foot. Left accent color depends on `kind`.
 *
 * Right edge intentionally exposes a 2px space for the intra-lane
 * "feeds into" rail rendered by WorkflowCanvas.
 */
import type { ObjectNode, ObjectKind } from '@/lib/process-diagram';
import { iconForLabel, storyForObject } from '@/lib/procurement-icons';

const CARD_WIDTH = 196; // was 188 — slight bump for the story row
const CARD_HEIGHT = 80; // was 64 — accommodates the new story line

function accentForKind(kind: ObjectKind): string {
  switch (kind) {
    case 'mirror':
      return 'var(--primary-500)';
    case 'reference':
      return 'var(--violet-400)';
    case 'computed':
      return 'var(--forge-500)';
    case 'primary':
    default:
      return 'var(--forge-500)';
  }
}

export interface ObjectCardProps {
  obj: ObjectNode;
  isSelected: boolean;
  /** True if this card is being hovered as a flow source/target candidate. */
  isFlowEndpoint?: boolean;
  /** Cadence of the inbound flow this card receives (e.g. "webhook + 15m").
   *  Drives the plain-English story line. */
  inboundCadence?: string;
  /** True when this card is the source of a flow feeding the 3-way match. */
  feedsMatch?: boolean;
  /** True when this card is the merge target of multiple flows (computed). */
  inputCount?: number;
  onSelect: () => void;
  onHandlePointerDown?: (side: 'left' | 'right', e: React.PointerEvent) => void;
}

export default function ObjectCard({
  obj,
  isSelected,
  isFlowEndpoint = false,
  inboundCadence,
  feedsMatch,
  inputCount,
  onSelect,
  onHandlePointerDown,
}: ObjectCardProps) {
  const accent = accentForKind(obj.kind);
  const icon = iconForLabel(obj.label, obj.kind);
  const story = storyForObject({
    kind: obj.kind,
    label: obj.label,
    sample: obj.sample,
    inboundCadence,
    feedsMatch,
    inputCount,
  });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      data-testid={`object-card-${obj.id}`}
      data-object-id={obj.id}
      style={{
        position: 'relative',
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        background: 'var(--surface-900)',
        border: `1px solid ${isSelected ? accent : 'var(--rule)'}`,
        borderLeftWidth: 3,
        borderLeftColor: accent,
        borderRadius: 6,
        padding: '8px 10px 8px 12px',
        cursor: 'pointer',
        boxShadow: isSelected
          ? `0 0 0 1px ${accent}, 0 0 18px rgba(194,65,12,0.18)`
          : '0 1px 2px rgba(9,9,11,0.04), 0 4px 12px rgba(9,9,11,0.04)',
        transition: 'box-shadow 180ms, border-color 180ms',
        outline: isFlowEndpoint ? `2px dashed ${accent}` : 'none',
        outlineOffset: 2,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            fontSize: 16,
            width: 20,
            display: 'inline-grid',
            placeItems: 'center',
            // emoji are colored — no need for an accent override
          }}
        >
          {icon}
        </span>
        <span
          style={{
            fontFamily: '"Space Grotesk", Inter, sans-serif',
            fontSize: 13.5,
            fontWeight: 500,
            color: 'var(--surface-50)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {obj.label}
        </span>
      </div>
      <div
        style={{
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 11,
          color: 'var(--surface-300)',
          lineHeight: 1.35,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 1,
        }}
        title={story}
      >
        {story}
      </div>
      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 9.5,
          color: 'var(--surface-500)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {obj.kind} · {(obj.fields || []).length}f · {obj.sample}s
      </div>
      {/* Connection handles for drawing new flows */}
      {onHandlePointerDown && (
        <>
          <span
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandlePointerDown('left', e);
            }}
            style={{
              position: 'absolute',
              left: -5,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: 'var(--surface-700)',
              border: '1px solid var(--rule)',
              cursor: 'crosshair',
            }}
            aria-label="connect from left"
          />
          <span
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandlePointerDown('right', e);
            }}
            style={{
              position: 'absolute',
              right: -5,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: 'var(--surface-700)',
              border: '1px solid var(--rule)',
              cursor: 'crosshair',
            }}
            aria-label="connect from right"
          />
        </>
      )}
    </div>
  );
}

export { CARD_WIDTH, CARD_HEIGHT, accentForKind };
