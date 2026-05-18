/*
 * MatchPill — the draggable 3-way match trigger.
 *
 * Sits between Ramp and Sage by default; user can drag elsewhere or tap
 * to open the full MatchingView. 4px movement threshold distinguishes
 * drag from tap.
 */
import type { CSSProperties } from 'react';

export interface MatchPillProps {
  x: number;
  y: number;
  isDragging: boolean;
  isAnchored: boolean; // true when matchPos is null (snapped to default)
  onPointerDown: (e: React.PointerEvent) => void;
  onTap: () => void;
  onResetAnchor?: () => void;
}

export default function MatchPill({
  x,
  y,
  isDragging,
  isAnchored,
  onPointerDown,
  onTap,
  onResetAnchor,
}: MatchPillProps) {
  const style: CSSProperties = {
    position: 'absolute',
    left: x,
    top: y,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 999,
    border: isAnchored
      ? '1px dashed var(--forge-500)'
      : '1px solid var(--forge-500)',
    background: 'rgba(194,65,12,0.10)',
    cursor: isDragging ? 'grabbing' : 'grab',
    transition: isDragging
      ? 'none'
      : 'left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1)',
    boxShadow: '0 0 18px rgba(194,65,12,0.20)',
    zIndex: 5,
    userSelect: 'none',
  };

  return (
    <div
      style={style}
      onPointerDown={onPointerDown}
      onClick={onTap}
      data-testid="process-match-pill"
      title="3-way match — click to open · drag to reposition"
    >
      <span aria-hidden style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
        ⋮⋮
      </span>
      <svg width="22" height="16" viewBox="0 0 22 18" aria-hidden>
        <circle cx="7" cy="7" r="4" fill="var(--forge-500)" fillOpacity="0.22" stroke="var(--forge-500)" strokeWidth="1" />
        <circle cx="15" cy="7" r="4" fill="var(--primary-500)" fillOpacity="0.22" stroke="var(--primary-500)" strokeWidth="1" />
        <circle cx="11" cy="12" r="4" fill="var(--violet-400)" fillOpacity="0.22" stroke="var(--violet-400)" strokeWidth="1" />
      </svg>
      <span
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'var(--forge-500)',
        }}
      >
        3-way match
      </span>
      <span
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 9.5,
          color: 'var(--surface-500)',
        }}
      >
        open ↗
      </span>
      {!isAnchored && onResetAnchor && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResetAnchor();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--surface-500)',
            cursor: 'pointer',
            fontSize: 11,
            padding: '0 2px',
          }}
          title="snap back to default anchor"
        >
          ↺
        </button>
      )}
    </div>
  );
}
