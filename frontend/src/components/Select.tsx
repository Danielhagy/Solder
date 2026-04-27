import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Select — Solder's design-system dropdown.
 *
 * Editorial / drafting direction: this is meant to read as a precision
 * instrument, not a generic SaaS select. Value text is JetBrains Mono
 * with denser tracking; the chevron sits in its own tabular column so
 * the right edge aligns across stacked selects. The popover is portal-
 * rendered through `document.body` so a `backdrop-filter` ancestor
 * (glass-rail panels) can't trap it inside a narrow rail — same lesson
 * RefPicker learned the hard way.
 *
 * Visual hierarchy on each row:
 *   [ icon ]  label                          caption  ▸
 *             description (2nd line, dim, optional)
 *
 * Selected row gets a 2px forge-orange left rail + tinted bg — drafting
 * blueprint mark. Hover stays visually quiet so the selection always
 * reads as the dominant signal.
 *
 * Keyboard:
 *   Enter / Space      open + select highlighted
 *   ArrowUp / ArrowDown  move highlight
 *   Esc               close, restore focus to trigger
 *   Type               jump to first option whose label starts with the
 *                      typed string (resets after 800ms idle)
 *
 * Drop-in for native `<select>`: single string value, single onChange.
 * Multi-select / async / grouped options are deliberately out of scope
 * for v1 — keep the surface tight; expand only when a real callsite
 * needs more.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Right-aligned secondary metadata in mono-dim — e.g. an auth-scheme
   *  on a connector option, a `(2)` count on a group. Optional. */
  caption?: string;
  /** Left-aligned 16×16 slot. Use a brand logo, single glyph, or icon
   *  component. The Select renders no chrome around it. */
  icon?: ReactNode;
  /** Second-line dim description in the popover. Truncated to one line. */
  description?: string;
  /** Disabled options are visible but not pickable; typing-to-jump and
   *  arrow-key nav skip them. */
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (next: string) => void;
  options: SelectOption[];
  /** Placeholder shown when `value` doesn't match any option. */
  placeholder?: string;
  /** Drafting eyebrow rendered above the trigger as ALL-CAPS mono. */
  eyebrow?: string;
  /** `'sm'` for inline / dense rails (header, JsonBuilder); `'md'` for
   *  full editor fields (default). */
  size?: 'sm' | 'md';
  /** When set, trigger renders without the chrome ring — useful inside
   *  glass-rail surfaces that already provide the border treatment. */
  bare?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  testid?: string;
  /** When provided, replaces the default trigger value rendering. The
   *  caller gets the active option (or undefined when no match) and
   *  returns the trigger contents — useful for showing logos / chips. */
  renderValue?: (active: SelectOption | undefined) => ReactNode;
  /** Width hint. `'auto'` shrinks to value; CSS length pins the width. */
  width?: string;
  /** Optional className appended to the trigger button. */
  className?: string;
}

const POPOVER_GAP = 4;
const POPOVER_MAX_HEIGHT = 320;

export default function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  eyebrow,
  size = 'md',
  bare = false,
  disabled = false,
  ariaLabel,
  testid,
  renderValue,
  width,
  className,
}: SelectProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number>(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const listboxId = useId();
  const triggerId = useId();

  const activeIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value]
  );
  const active = activeIndex >= 0 ? options[activeIndex] : undefined;

  // Position the portal popover under the trigger. Re-measures on
  // resize / scroll so the popover tracks the trigger when the page
  // moves underneath us. Flips above when no room below.
  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom - POPOVER_GAP;
    const flipAbove = spaceBelow < 200 && rect.top > spaceBelow;
    const top = flipAbove
      ? rect.top - POPOVER_GAP - POPOVER_MAX_HEIGHT
      : rect.bottom + POPOVER_GAP;
    setPos({
      top: Math.max(8, top),
      left: rect.left,
      width: rect.width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  // Highlight the active option when opening so arrow nav starts at the
  // current selection rather than at index 0.
  useEffect(() => {
    if (open) setHighlighted(activeIndex >= 0 ? activeIndex : firstEnabled(options));
  }, [open, activeIndex, options]);

  // Click-outside + Escape dismissal.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Type-to-jump. Resets after 800ms idle so consecutive letters chain
  // (typing "ho" jumps to "hubspot" not "h…o…").
  const typeBufferRef = useRef('');
  const typeTimerRef = useRef<number | null>(null);
  const handleType = useCallback(
    (ch: string) => {
      typeBufferRef.current = (typeBufferRef.current + ch).toLowerCase();
      if (typeTimerRef.current) window.clearTimeout(typeTimerRef.current);
      typeTimerRef.current = window.setTimeout(() => {
        typeBufferRef.current = '';
      }, 800);
      const buffer = typeBufferRef.current;
      const next = options.findIndex(
        (o) => !o.disabled && o.label.toLowerCase().startsWith(buffer)
      );
      if (next >= 0) setHighlighted(next);
    },
    [options]
  );

  function commit(idx: number) {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(delta: number) {
    if (options.length === 0) return;
    let next = highlighted;
    for (let i = 0; i < options.length; i++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setHighlighted(next);
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      commit(highlighted);
      return;
    }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      if (!open) setOpen(true);
      handleType(e.key);
    }
  }

  // Trigger chrome — sized + bordered to match the project's `.input` /
  // glass-rail family. Bare variant skips the ring for inline contexts.
  const triggerCls = [
    'group inline-flex items-center gap-2 select-none',
    'text-left transition-colors',
    size === 'sm'
      ? 'px-2 py-1 text-xs rounded-md'
      : 'px-2.5 py-1.5 text-sm rounded-md',
    bare
      ? 'hover:bg-surface-100/60 dark:hover:bg-surface-800/40'
      : 'bg-white ring-1 ring-surface-200 hover:ring-surface-300 dark:bg-surface-900/60 dark:ring-surface-700 dark:hover:ring-surface-600',
    open && !bare ? 'ring-forge-500/60 dark:ring-forge-500/50' : '',
    disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="solder-select inline-block align-top"
      style={width ? { width } : undefined}
    >
      {eyebrow && (
        <div
          className="eyebrow mb-1 text-surface-500 dark:text-surface-400"
          aria-hidden="true"
        >
          {eyebrow}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel ?? eyebrow ?? placeholder}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        data-testid={testid}
        data-state={open ? 'open' : 'closed'}
        className={triggerCls}
        style={width ? { width: '100%' } : undefined}
      >
        {renderValue ? (
          <span className="flex-1 min-w-0 truncate">{renderValue(active)}</span>
        ) : (
          <>
            {active?.icon && (
              <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4">
                {active.icon}
              </span>
            )}
            <span
              className={`flex-1 min-w-0 truncate ${
                active
                  ? 'font-mono text-surface-900 dark:text-surface-50'
                  : 'text-surface-400 dark:text-surface-500'
              }`}
            >
              {active?.label ?? placeholder}
            </span>
            {active?.caption && (
              <span className="font-mono text-[11px] text-surface-400 dark:text-surface-500 flex-shrink-0">
                {active.caption}
              </span>
            )}
          </>
        )}
        <Chevron open={open} />
      </button>

      {open &&
        pos &&
        createPortal(
          <AnimatePresence>
            <motion.div
              key="popover"
              ref={popoverRef}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.12, ease: [0.2, 0.7, 0.3, 1] }}
              role="listbox"
              id={listboxId}
              aria-labelledby={triggerId}
              tabIndex={-1}
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                width: pos.width,
                maxHeight: POPOVER_MAX_HEIGHT,
                zIndex: 60,
              }}
              className="overflow-auto solder-scroll-thin rounded-md ring-1 ring-surface-200 dark:ring-surface-700 bg-white/95 dark:bg-surface-950/90 backdrop-blur-md shadow-lg shadow-surface-900/5 dark:shadow-black/40"
              data-testid={testid ? `${testid}-popover` : undefined}
            >
              <ul className="py-1 divide-y divide-dashed divide-surface-200/60 dark:divide-surface-800/60">
                {options.length === 0 ? (
                  <li className="px-3 py-2 text-xs font-mono italic text-surface-400 dark:text-surface-500">
                    no options
                  </li>
                ) : (
                  options.map((opt, i) => (
                    <SelectRow
                      key={opt.value}
                      option={opt}
                      isActive={i === activeIndex}
                      isHighlighted={i === highlighted}
                      onPick={() => commit(i)}
                      onHover={() => !opt.disabled && setHighlighted(i)}
                    />
                  ))
                )}
              </ul>
            </motion.div>
          </AnimatePresence>,
          document.body
        )}
    </div>
  );
}

function SelectRow({
  option,
  isActive,
  isHighlighted,
  onPick,
  onHover,
}: {
  option: SelectOption;
  isActive: boolean;
  isHighlighted: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const ref = useRef<HTMLLIElement | null>(null);
  // Auto-scroll the highlighted row into view during keyboard nav so
  // arrow-paging through long lists doesn't strand the cursor outside
  // the popover viewport.
  useEffect(() => {
    if (isHighlighted) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [isHighlighted]);

  // Selected: 2px forge-tinted left rail + bg tint. Highlighted (keyboard
  // or hover) but not selected: subtle surface tint. Both can stack —
  // selected wins visually (rail + stronger tint).
  const bgCls = isActive
    ? 'bg-forge-500/[0.06] dark:bg-forge-500/[0.10]'
    : isHighlighted
      ? 'bg-surface-50 dark:bg-surface-800/60'
      : '';

  return (
    <li
      ref={ref}
      role="option"
      aria-selected={isActive}
      aria-disabled={option.disabled || undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!option.disabled) onPick();
      }}
      onMouseMove={onHover}
      className={[
        'relative flex items-start gap-2 px-3 py-1.5 text-sm cursor-pointer',
        'text-surface-800 dark:text-surface-100',
        bgCls,
        option.disabled ? 'opacity-50 cursor-not-allowed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={`select-option-${option.value}`}
    >
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r bg-forge-500"
        />
      )}
      {option.icon && (
        <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 mt-0.5">
          {option.icon}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span
          className={`block truncate font-mono ${
            isActive
              ? 'text-forge-700 dark:text-forge-300'
              : 'text-surface-800 dark:text-surface-100'
          }`}
        >
          {option.label}
        </span>
        {option.description && (
          <span className="block truncate text-[11px] text-surface-500 dark:text-surface-400 mt-0.5">
            {option.description}
          </span>
        )}
      </span>
      {option.caption && (
        <span className="font-mono text-[11px] text-surface-400 dark:text-surface-500 flex-shrink-0">
          {option.caption}
        </span>
      )}
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`flex-shrink-0 text-surface-400 dark:text-surface-500 transition-transform duration-150 ${
        open ? 'rotate-180' : ''
      }`}
    >
      <path
        d="M2 4l3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function firstEnabled(options: SelectOption[]): number {
  for (let i = 0; i < options.length; i++) {
    if (!options[i].disabled) return i;
  }
  return -1;
}
