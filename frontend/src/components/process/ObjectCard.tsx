/*
 * ObjectCard — one entity card inside a swimlane.
 *
 * 188×64. Kind glyph + label. Meta row shows kind, field count, sample
 * count. Left accent color depends on `kind` (primary/computed = forge,
 * mirror = primary-500, reference = violet-400).
 */
import type { ObjectNode, ObjectKind } from '@/lib/process-diagram';

const CARD_WIDTH = 188;
const CARD_HEIGHT = 64;

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
  onSelect: () => void;
  onHandlePointerDown?: (side: 'left' | 'right', e: React.PointerEvent) => void;
}

export default function ObjectCard({
  obj,
  isSelected,
  isFlowEndpoint = false,
  onSelect,
  onHandlePointerDown,
}: ObjectCardProps) {
  const accent = accentForKind(obj.kind);
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
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            width: 18,
            color: accent,
          }}
        >
          {obj.glyph || '◷'}
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
          }}
        >
          {obj.label}
        </span>
      </div>
      <div
        style={{
          marginTop: 4,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5,
          color: 'var(--surface-400)',
          letterSpacing: '0.02em',
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
