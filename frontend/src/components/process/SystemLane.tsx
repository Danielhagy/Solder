/*
 * SystemLane — one draggable swimlane column.
 *
 * 212px wide, equalized height. Left accent bar in the system's tint.
 * Header includes glyph, label, role, env chip, status pip. Click anywhere
 * to select; drag the header to reposition. Snaps to 8px grid.
 */
import type { CSSProperties } from 'react';
import { brandLogoUrl } from '@/api/client';
import type { System } from '@/lib/process-diagram';

export interface SystemLaneProps {
  system: System;
  x: number;
  y: number;
  height: number;
  isSelected: boolean;
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onSelect: () => void;
  children?: React.ReactNode;
}

const LANE_WIDTH = 212;
const LANE_HEADER_HEIGHT = 90;

export default function SystemLane({
  system,
  x,
  y,
  height,
  isSelected,
  isDragging,
  onPointerDown,
  onSelect,
  children,
}: SystemLaneProps) {
  const style: CSSProperties = {
    position: 'absolute',
    left: x,
    top: y,
    width: LANE_WIDTH,
    minHeight: height,
    background: 'var(--container-fill)',
    border: '1px solid var(--rule)',
    borderRadius: 12,
    boxShadow: isSelected
      ? '0 0 0 1px var(--forge-500), 0 0 24px rgba(194,65,12,0.18)'
      : '0 1px 2px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
    transition: isDragging ? 'none' : 'left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1)',
    cursor: isDragging ? 'grabbing' : 'default',
  };

  return (
    <div style={style} onClick={onSelect} data-testid={`system-lane-${system.id}`}>
      {/* Left accent bar */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: system.tint || 'var(--forge-500)',
          borderTopLeftRadius: 12,
          borderBottomLeftRadius: 12,
        }}
      />
      {/* Header — draggable */}
      <div
        onPointerDown={onPointerDown}
        style={{
          height: LANE_HEADER_HEIGHT,
          padding: '12px 14px 8px 18px',
          borderBottom: '1px solid var(--rule)',
          cursor: 'grab',
          userSelect: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SystemLogo system={system} />

          <span
            style={{
              fontFamily: '"Space Grotesk", Inter, sans-serif',
              fontSize: 17,
              fontWeight: 500,
              color: 'var(--surface-50)',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {system.label}
          </span>
          <span
            aria-hidden
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              color: 'var(--surface-500)',
              cursor: 'grab',
            }}
            title="drag to reposition"
          >
            ⋮⋮
          </span>
        </div>
        <div
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            color: 'var(--surface-400)',
            letterSpacing: '0.02em',
          }}
        >
          {system.role}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 9.5,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: system.env === 'sandbox' ? 'var(--forge-500)' : 'var(--primary-500)',
              border: '1px solid currentColor',
              borderRadius: 999,
              padding: '1px 6px',
            }}
          >
            {system.env}
          </span>
          <span
            aria-label={`connection ${system.connection}`}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background:
                system.connection === 'healthy'
                  ? 'var(--emerald-400)'
                  : system.connection === 'degraded'
                    ? 'var(--forge-500)'
                    : 'var(--rose-400)',
            }}
          />
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 9.5,
              color: 'var(--surface-500)',
            }}
          >
            {system.connection}
          </span>
        </div>
      </div>
      {/* Body — children = object cards */}
      <div style={{ padding: '12px 12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

export { LANE_WIDTH, LANE_HEADER_HEIGHT };


/** 28×28 logo tile. Pulls from Brandfetch via `brandLogoUrl`; falls
 *  back to a monogram tile (first letter of the system label) in the
 *  system's tint color when no brand domain is set or the image fails. */
function SystemLogo({ system }: { system: System }) {
  const url = brandLogoUrl(system.brandDomain || null);
  const monogram = (system.label || '?').slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: 'var(--surface-800)',
        border: '1px solid var(--rule)',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          style={{ width: 22, height: 22, objectFit: 'contain' }}
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: '"Space Grotesk", Inter, sans-serif',
            fontSize: 14,
            fontWeight: 600,
            color: system.tint || 'var(--surface-500)',
          }}
        >
          {monogram}
        </span>
      )}
    </span>
  );
}
