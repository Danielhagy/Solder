import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useIntegrationStore } from '@/stores/integration';
import { getReferenceableScope } from '@/stores/integration';
import RefPicker from '../RefPicker';

/**
 * A textarea-shaped reference field with inline reference chips.
 *
 * The visible text is rendered in a div overlay layered on top of the
 * textarea. The textarea keeps the literal `{{$.…}}` characters as the
 * source of truth (it owns selection, undo/redo, the `{` keystroke
 * trigger) but its text color is transparent so the overlay's chip
 * rendering shows through. Because the overlay shares the textarea's
 * exact font, padding, and box-sizing — and because chips render the
 * full canonical chars (with `{{` `}}` dimmed but not removed) — the
 * caret stays aligned with the visible glyphs through soft-wraps.
 *
 * The picker still inserts canonical `{{$.…}}` tokens; chip rendering
 * is a pure read concern.
 */

/** Match `{{$.…}}` and `{{$item}}` / `{{$index}}`. The capture group is
 *  the inner expression sans braces — what the chip displays. */
const TOKEN_RE = /\{\{(\$[^}]+)\}\}/g;

interface Segment {
  type: 'text' | 'token';
  text: string; // raw substring (including braces for tokens)
  inner?: string; // for tokens, the inner expression
  /** Visible inner label — strips JSONPath cruft from `inner` so a token
   *  like `{{$.steps.X.output.body}}` reads as `steps.X.output.body`,
   *  while `{{$item}}` keeps `$item` (only the braces are stripped). */
  display?: string;
  /** Length of the leading hidden chars (`{{` or `{{$.`) — kept rendered
   *  for caret-width alignment with the textarea below. */
  hiddenPrefixLen?: number;
  start: number; // index in the source value
  end: number;
}

function buildTokenSegment(
  text: string,
  inner: string,
  start: number
): Segment {
  // For `{{$.foo.bar}}` we hide `{{$.` and `}}` so the chip shows
  // `foo.bar`; for `{{$item}}` we hide just `{{` and `}}` so the chip
  // keeps `$item` (which IS the variable name). Suffix is always `}}`.
  const hasDotPrefix = inner.startsWith('$.');
  const hiddenPrefixLen = hasDotPrefix ? 4 /* '{{$.' */ : 2 /* '{{' */;
  const display = hasDotPrefix ? inner.slice(2) : inner;
  return {
    type: 'token',
    text,
    inner,
    display,
    hiddenPrefixLen,
    start,
    end: start + text.length
  };
}

function parseSegments(value: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(value)) !== null) {
    if (m.index > last) {
      segs.push({
        type: 'text',
        text: value.slice(last, m.index),
        start: last,
        end: m.index
      });
    }
    segs.push(buildTokenSegment(m[0], m[1], m.index));
    last = m.index + m[0].length;
  }
  if (last < value.length) {
    segs.push({
      type: 'text',
      text: value.slice(last),
      start: last,
      end: value.length
    });
  }
  return segs;
}

interface ReferenceFieldProps {
  /** Owning node id — used to scope the picker. */
  nodeId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  /** When true, render as a single-line `<input>` instead of a textarea. */
  singleLine?: boolean;
  /** ARIA label / data-testid passthrough. */
  ariaLabel?: string;
  testId?: string;
}

export default function ReferenceField({
  nodeId,
  value,
  onChange,
  placeholder,
  className,
  rows = 3,
  singleLine = false,
  ariaLabel,
  testId
}: ReferenceFieldProps) {
  // Always a textarea. `singleLine` now means "row=1, Enter is blocked, the
  // textarea auto-grows as the content wraps." The previous <input> swap
  // broke caret alignment — input doesn't wrap, the overlay does, so the
  // caret stayed pinned to row 1 while wrapped glyphs ran below it.
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // When non-null, the inspect popover is showing for the chip whose
  // segment index matches. Kept by segment index (stable across renders
  // for a given `value`) rather than absolute position so we don't have
  // to chase DOM nodes across reflow.
  const [inspectingIdx, setInspectingIdx] = useState<number | null>(null);

  function openPicker() {
    setPickerOpen(true);
  }
  function closePicker() {
    setPickerOpen(false);
    fieldRef.current?.focus();
  }

  function insertToken(token: string) {
    const el = fieldRef.current;
    if (!el) {
      onChange((value || '') + token);
      setPickerOpen(false);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    // If the user opened the picker by typing `{`, that brace is
    // already in the field — replace it (and any partial token they'd
    // started). Heuristic: if the char immediately before the cursor
    // is `{` and the next char isn't `{`, swap the brace for the token.
    const before = value.slice(0, start);
    const after = value.slice(end);
    const beforeWithoutOpenBrace =
      before.endsWith('{') && !before.endsWith('{{')
        ? before.slice(0, -1)
        : before;
    const next = beforeWithoutOpenBrace + token + after;
    onChange(next);
    setPickerOpen(false);
    requestAnimationFrame(() => {
      const el2 = fieldRef.current;
      if (!el2) return;
      const caret = beforeWithoutOpenBrace.length + token.length;
      el2.focus();
      el2.setSelectionRange(caret, caret);
    });
  }

  function handleKeyDown(
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) {
    // Single-line mode: swallow Enter so URL / cursor-path / items-path
    // fields can't sneak a literal `\n` into the value.
    if (singleLine && e.key === 'Enter') {
      e.preventDefault();
      return;
    }
    if (e.key === '{') {
      setTimeout(openPicker, 0);
    }
  }

  // Sync the overlay's scroll with the textarea's scroll. With long or
  // multi-line content, the textarea internally scrolls; the overlay
  // mirror stays put unless we follow.
  function handleScroll() {
    if (!overlayRef.current || !fieldRef.current) return;
    overlayRef.current.scrollTop = fieldRef.current.scrollTop;
    overlayRef.current.scrollLeft = fieldRef.current.scrollLeft;
  }

  // Re-sync overlay scroll when value changes (the textarea may auto-
  // scroll on input).
  useLayoutEffect(() => {
    handleScroll();
  }, [value]);

  // Auto-grow the textarea so wrapped content stays visible and the caret
  // can land on the new line. Without this, `rows={1}` would clip after
  // one wrap and the caret would dive below the visible area. Multi-line
  // mode also benefits when the user types past the initial `rows`.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, singleLine, rows]);

  // Esc closes the inspect popover (mirrors how the picker dismisses).
  useEffect(() => {
    if (inspectingIdx === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setInspectingIdx(null);
      }
    }
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (t.closest('[data-ref-popover]')) return;
      if (t.closest('.ref-chip')) return;
      setInspectingIdx(null);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [inspectingIdx]);

  // Pull current scope from the store. Subscribed via Zustand so the
  // picker re-renders if upstream nodes change while it's open.
  const scope = useIntegrationStore((s) => getReferenceableScope(s, nodeId));

  const segments = parseSegments(value);

  // Replace one chip's canonical token with empty text. Used by the
  // inspect popover's Remove action.
  function removeTokenAt(segIdx: number) {
    const seg = segments[segIdx];
    if (!seg || seg.type !== 'token') return;
    const next = value.slice(0, seg.start) + value.slice(seg.end);
    onChange(next);
    setInspectingIdx(null);
    requestAnimationFrame(() => {
      const el = fieldRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seg.start, seg.start);
    });
  }

  // Shared classes for both the textarea and the overlay so they line
  // up character-for-character. `whitespace-pre-wrap` and `break-words`
  // are critical: the overlay must wrap at the same char positions as
  // the textarea.
  const sharedShape = `w-full font-mono text-sm leading-[1.45] px-3 py-2 ${
    className ?? ''
  }`;

  // The textarea keeps `.input` styling (border, focus ring) — the
  // overlay layers on top with an absolute fill. `resize-none` +
  // `overflow-hidden` lets the JS auto-grow above own the vertical
  // height without a scrollbar fighting it. `overflow-wrap-anywhere`
  // matches the overlay's `break-words` so long URLs / tokens wrap at
  // the same character index in both layers.
  const sharedProps = {
    ref: fieldRef,
    value,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
      onChange(e.currentTarget.value),
    onKeyDown: handleKeyDown,
    onScroll: handleScroll,
    placeholder,
    'aria-label': ariaLabel,
    'data-testid': testId,
    spellCheck: false,
    // `caret-current` keeps the caret visible even though the text is
    // transparent. Right-padding leaves room for the `{·}` icon button.
    className: `input ${sharedShape} pr-9 caret-surface-900 dark:caret-surface-50 resize-none overflow-hidden`,
    style: {
      color: 'transparent' as const,
      overflowWrap: 'anywhere' as const,
    },
  };

  return (
    <div className="relative">
      <textarea {...sharedProps} rows={singleLine ? 1 : rows} />

      {/*
       * Overlay — paints the visible glyphs. `aria-hidden` because the
       * textarea is the accessible source. `pointer-events: none` lets
       * clicks fall through to the textarea (positioning the caret),
       * EXCEPT on `.ref-chip` spans which re-enable pointer events for
       * inspect-on-click. Dimensions/padding match the textarea exactly
       * so character widths line up.
       */}
      <div
        ref={overlayRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 ${sharedShape} pr-9 overflow-hidden whitespace-pre-wrap text-surface-900 dark:text-surface-50`}
        style={{ overflowWrap: 'anywhere' }}
      >
        {segments.length === 0 || (segments.length === 1 && !value) ? (
          // Empty value — let the textarea's own `placeholder` show.
          // Render nothing in the overlay.
          <span />
        ) : (
          segments.map((seg, i) => {
            if (seg.type === 'text') {
              return <span key={i}>{seg.text}</span>;
            }
            const open = inspectingIdx === i;
            const prefixLen = seg.hiddenPrefixLen ?? 2;
            const hiddenPrefix = seg.text.slice(0, prefixLen);
            const hiddenSuffix = seg.text.slice(seg.text.length - 2);
            return (
              <span
                key={i}
                className="ref-chip pointer-events-auto"
                data-ref-token={seg.text}
                data-open={open || undefined}
                title={seg.text}
                onClick={(e) => {
                  e.stopPropagation();
                  setInspectingIdx(open ? null : i);
                }}
                role="button"
                tabIndex={-1}
              >
                <span className="ref-chip-hidden">{hiddenPrefix}</span>
                <span className="ref-chip-inner">{seg.display}</span>
                <span className="ref-chip-hidden">{hiddenSuffix}</span>
              </span>
            );
          })
        )}
      </div>

      {/* Inspect popover — anchored to the bottom of the field, shows
          the canonical token text plus a Remove action. Sits inside the
          field's relative wrap so it follows scroll naturally. */}
      {inspectingIdx !== null && segments[inspectingIdx]?.type === 'token' && (
        <div
          data-ref-popover
          className="absolute z-30 left-2 top-full mt-1 glass-rail rounded-md px-2 py-1.5 flex items-center gap-2 text-xs"
        >
          <span className="font-mono text-surface-700 dark:text-surface-200">
            {segments[inspectingIdx]!.text}
          </span>
          <button
            type="button"
            onClick={() => removeTokenAt(inspectingIdx)}
            className="text-surface-500 hover:text-red-500 dark:text-surface-400 dark:hover:text-red-400 px-1"
            aria-label="Remove reference"
            title="Remove reference"
          >
            ✕
          </button>
        </div>
      )}

      {/*
       * Discoverability handle. Not a button-shaped affordance because
       * it would compete with the field's own click target; small,
       * forge-tinted on hover, with a tooltip via title attribute.
       */}
      <button
        type="button"
        aria-label="Insert reference"
        title="Insert reference (or type `{`)"
        onClick={openPicker}
        className="absolute top-1.5 right-1.5 w-6 h-6 inline-flex items-center justify-center rounded text-[11px] font-mono text-surface-400 hover:text-forge-600 hover:bg-forge-500/[0.08] dark:text-surface-500 dark:hover:text-forge-400 transition-colors z-20"
      >
        {'{·}'}
      </button>
      {pickerOpen && scope && (
        <RefPicker
          scope={scope}
          anchorEl={fieldRef.current}
          onSelect={insertToken}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
