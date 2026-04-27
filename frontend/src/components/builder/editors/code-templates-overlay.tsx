import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { PYTHON_SNIPPETS, type PythonSnippet } from './code-snippets';

/**
 * TemplatesOverlay — portal-rendered gallery of starter Python snippets.
 *
 * Always reachable via the editor's `Templates` toolbar button, so it
 * isn't gated on the source being empty (the inline snippet cards
 * remain a separate first-open affordance — this overlay is the "I
 * already started, I just want to browse and pick one" entry point).
 *
 * Each card shows the snippet's title, one-line description, and a
 * Tokyo-Night-evoking code preview so users can recognise the shape
 * they want without reading every snippet's full source. We don't
 * mount CodeMirror inline (the actual `tokyoNight` theme would
 * double-mount with the editor below) — instead a lightweight regex
 * tints the preview using Tailwind classes calibrated against the
 * CodeMirror palette so the editor and the preview feel cut from the
 * same cloth. Clicking a card fires `onPick(source)` — the editor
 * decides whether to replace (empty source) or insert at cursor
 * (non-empty).
 */

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (snippet: PythonSnippet) => void;
}

export default function TemplatesOverlay({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? PYTHON_SNIPPETS.filter((s) =>
        `${s.title} ${s.description} ${s.source}`.toLowerCase().includes(q)
      )
    : PYTHON_SNIPPETS;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="templates-overlay-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        className="fixed inset-0 z-50 grid place-items-center bg-surface-950/40 backdrop-blur-sm p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="templates-overlay"
      >
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16, ease: [0.2, 0.7, 0.3, 1] }}
          className="glass-rail rounded-xl w-full max-w-3xl px-5 pt-4 pb-4 max-h-[85vh] overflow-y-auto solder-scroll-thin"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header — eyebrow + display title, mirrors the project's
              page-header rhythm. The right cluster carries the result
              count as a quiet mono caption so the user can tell when a
              filter is narrowing the gallery. */}
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="eyebrow">starter / py · templates</p>
              <h3 className="font-display text-lg text-surface-900 dark:text-surface-50 leading-tight">
                Pick a Python pattern
              </h3>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500 tabular-nums">
                {filtered.length.toString().padStart(2, '0')} / {PYTHON_SNIPPETS.length.toString().padStart(2, '0')}
              </span>
              <button
                type="button"
                onClick={onClose}
                className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 text-lg leading-none px-1"
                aria-label="Close templates"
              >
                ×
              </button>
            </div>
          </div>

          {/* Drafting-paper measure rule under the header. */}
          <div className="measure-rule mt-3 mb-3" />

          <input
            type="text"
            className="input w-full text-sm"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Filter templates…"
            autoFocus
            data-testid="templates-search"
          />

          {filtered.length === 0 ? (
            <p className="text-xs font-mono italic text-surface-400 py-6 text-center">
              no templates match
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
              {filtered.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s)}
                  className="group relative text-left flex flex-col gap-1.5 p-2.5 rounded-md ring-1 ring-surface-200 bg-white hover:ring-forge-500/50 hover:bg-forge-500/[0.03] dark:ring-surface-800 dark:bg-surface-900/60 dark:hover:ring-forge-500/40 dark:hover:bg-forge-500/[0.06] transition-colors"
                  data-testid={`template-${s.id}`}
                >
                  {/* 2px forge rail on hover — same drafting-blueprint mark
                      Select.tsx puts on the selected row, here as a hover
                      affordance so the gallery reads as "selectable rows". */}
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-forge-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                  <div className="flex items-baseline justify-between gap-2 pl-1">
                    <span className="text-sm font-medium text-surface-900 dark:text-surface-50 truncate">
                      {s.title}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500 flex-shrink-0">
                      {s.id}
                    </span>
                  </div>
                  <p className="text-[11px] text-surface-500 dark:text-surface-400 leading-snug pl-1">
                    {s.description}
                  </p>
                  {/* Tokyo-Night-evoking preview. Regex-tinted so the
                      shape reads like Python without paying the cost of a
                      second CodeMirror mount per card. Background uses
                      tokyoNight's deep #1a1b26 / #16161e feel, mapped to
                      Tailwind's surface-950 with a slate cast. Lines
                      capped at 7 + ellipsis so two columns stay even. */}
                  <SnippetPreview source={s.source} />
                </button>
              ))}
            </div>
          )}

          {/* Footer hint — measure-rule above so the tip reads as a
              dimensioned annotation rather than a stray line of text. */}
          <div className="measure-rule mt-3 mb-2" />
          <div className="flex items-center justify-between gap-3 text-[10px] font-mono uppercase tracking-[0.15em] text-surface-400 dark:text-surface-500">
            <span>tip · click to drop at cursor</span>
            <span className="hidden sm:inline">esc to close</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

/* ── Snippet preview ─────────────────────────────────────────────── */

/**
 * Lightweight syntax-tinting that EVOKES the Tokyo Night theme without
 * mounting CodeMirror. Tokens picked to match what the user will see
 * in the actual editor below:
 *   - keyword (def, for, if, in, return, …)  → magenta-300 / pink-ish
 *   - builtin (data, result, …)              → cyan-300
 *   - string literals                         → emerald-300 / sage
 *   - numeric literals                        → forge-300 / orange
 *   - comments                                → surface-500 italic
 * Anything not matched stays neutral (surface-300). The regex is
 * deliberately approximate — it only needs to look right, not parse.
 */
function SnippetPreview({ source }: { source: string }) {
  const lines = source.split('\n');
  const truncated = lines.length > 7;
  const shown = truncated ? lines.slice(0, 7) : lines;

  return (
    <div className="mt-1 rounded ring-1 ring-surface-200/70 dark:ring-[#2c2e40] bg-surface-50/80 dark:bg-[#16161e] overflow-hidden">
      {/* Tiny mono ribbon — same trick the wordmark uses (slash-star
          treats the brand as a code annotation). Sets the "this is
          source" context before the preview body. */}
      <div className="flex items-center justify-between gap-2 px-2 py-[3px] bg-surface-100/70 dark:bg-[#1a1b26] border-b border-surface-200/60 dark:border-[#2c2e40]">
        <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-surface-400 dark:text-[#7aa2f7]/70">
          /* py */
        </span>
        <span className="font-mono text-[9px] tabular-nums text-surface-400 dark:text-surface-500">
          {lines.length}L
        </span>
      </div>
      <pre className="text-[10.5px] font-mono leading-[1.45] px-2 py-1.5 overflow-hidden text-surface-700 dark:text-[#a9b1d6] whitespace-pre">
        {shown.map((line, i) => (
          <div key={i}>{tokenize(line)}</div>
        ))}
        {truncated && (
          <div className="text-surface-400 dark:text-[#565f89] italic">…</div>
        )}
      </pre>
    </div>
  );
}

const PY_KEYWORDS = new Set([
  'def', 'for', 'if', 'else', 'elif', 'in', 'return', 'import', 'from',
  'is', 'not', 'and', 'or', 'lambda', 'class', 'try', 'except', 'with',
  'as', 'pass', 'None', 'True', 'False',
]);

const PY_BUILTINS = new Set([
  'data', 'result', 'isinstance', 'dict', 'list', 'str', 'int', 'float',
  'len', 'sum', 'round', 'print', 'range', 'set',
]);

/**
 * Tokenize a single line into React fragments with Tailwind colour
 * classes. Order matters: comments first (they swallow the rest of
 * the line), then strings (so we don't mistakenly highlight inside
 * them), then keywords / builtins / numbers as a single regex pass.
 */
function tokenize(line: string): React.ReactNode[] {
  // Empty / whitespace-only line.
  if (line.length === 0) return [<span key="empty">&nbsp;</span>];

  // Comment line — the whole thing is one token.
  const commentIdx = findCommentStart(line);
  if (commentIdx === 0) {
    return [
      <span key="c" className="italic text-surface-400 dark:text-[#565f89]">
        {line}
      </span>,
    ];
  }

  // Tokenise. We walk the line character-by-character with a tiny
  // state machine: STRING, then everything else handled by a regex
  // sweep over the non-string segments. Cheap and good enough.
  const out: React.ReactNode[] = [];
  let i = 0;
  let buf = '';
  let key = 0;
  const flush = () => {
    if (!buf) return;
    out.push(...sweepNonString(buf, key));
    key += 100;
    buf = '';
  };

  while (i < line.length) {
    const ch = line[i];
    // Inline comment — flush buffer, render the rest as comment.
    if (ch === '#') {
      flush();
      out.push(
        <span key={`c-${key++}`} className="italic text-surface-400 dark:text-[#565f89]">
          {line.slice(i)}
        </span>
      );
      return out;
    }
    // String literal — single or double quote. No escape handling —
    // snippets don't contain escaped quotes inside strings.
    if (ch === '"' || ch === "'") {
      flush();
      const quote = ch;
      let end = i + 1;
      while (end < line.length && line[end] !== quote) end++;
      const literal = line.slice(i, end + 1);
      out.push(
        <span key={`s-${key++}`} className="text-emerald-700 dark:text-[#9ece6a]">
          {literal}
        </span>
      );
      i = end + 1;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Sweep a non-string segment for keywords, builtins, and numeric
 * literals. Uses a single tokeniser regex with named alternatives.
 */
function sweepNonString(segment: string, baseKey: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Match: identifier | number | anything-else (one char at a time
  // for the misc bucket so we don't lose punctuation).
  const re = /([A-Za-z_][A-Za-z0-9_]*)|(\b\d+(?:\.\d+)?\b)|([\s\S])/g;
  let m: RegExpExecArray | null;
  let key = baseKey;
  while ((m = re.exec(segment))) {
    if (m[1]) {
      const word = m[1];
      if (PY_KEYWORDS.has(word)) {
        out.push(
          <span key={key++} className="text-violet-700 dark:text-[#bb9af7]">
            {word}
          </span>
        );
      } else if (PY_BUILTINS.has(word)) {
        out.push(
          <span key={key++} className="text-cyan-700 dark:text-[#7dcfff]">
            {word}
          </span>
        );
      } else {
        out.push(<span key={key++}>{word}</span>);
      }
    } else if (m[2]) {
      out.push(
        <span key={key++} className="text-forge-700 dark:text-[#ff9e64]">
          {m[2]}
        </span>
      );
    } else if (m[3]) {
      out.push(<span key={key++}>{m[3]}</span>);
    }
  }
  return out;
}

/** Index of the first `#` at the start of a line (after optional
 *  leading whitespace). Returns -1 if the line isn't a comment line. */
function findCommentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ' || line[i] === '\t') continue;
    return line[i] === '#' ? i : -1;
  }
  return -1;
}
