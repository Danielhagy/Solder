import type {
  CompletionContext,
  CompletionResult,
  Completion,
} from '@codemirror/autocomplete';

/**
 * CodeMirror 6 completion source for `data["..."]` access in the
 * `code.python` editor.
 *
 * Inputs:
 *   - `paths`: dotted JSONPath strings the upstream node declared via
 *     its catalog `referenceableOutputs`. For an `http.request` node
 *     these are `status_code`, `headers`, `body`, `body.id`,
 *     `body.email`, etc.
 *   - `samples`: optional sibling map `path → sample value` used to
 *     derive a type chip on each completion.
 *
 * What it offers:
 *   - When the user types `data["` (or just inside an open dict
 *     subscript), every top-level key of the upstream output becomes a
 *     completion. Selecting one inserts the closing `"]` automatically.
 *   - When the user types `data.get("` we offer the same completions.
 *   - We do NOT try to nest into sub-paths (`body.id`) here — Python's
 *     `data["body"]["id"]` syntax means continuation completions need a
 *     second pass, kept out of v1 to keep the surface tight.
 *
 * Pure CM6 — no external deps. Designed to be passed via:
 *   `pythonLanguage.data.of({autocomplete: dataSubscriptCompletions(...)})`
 * or registered as an additional source through `autocompletion()`.
 */

const SUBSCRIPT_RE = /data(?:\.get)?\(?\[?["']([^"']*)$/;

export interface SchemaCompletionSourceOpts {
  /** Top-level keys of `data`. Derived from the upstream node's
   *  `referenceableOutputs` paths (first segment of each dotted path). */
  topKeys: string[];
  /** Optional map: top-level key → human description for the popup detail. */
  describedBy?: Record<string, string>;
  /** Optional map: top-level key → JS-typeof of the sample value, used
   *  for the `int` / `str` / `list` type chip in the popup. */
  typeOf?: Record<string, string>;
}

export function schemaCompletions(
  opts: SchemaCompletionSourceOpts
): (ctx: CompletionContext) => CompletionResult | null {
  const { topKeys, describedBy = {}, typeOf = {} } = opts;
  return (ctx: CompletionContext): CompletionResult | null => {
    if (topKeys.length === 0) return null;
    // Match the source up to the cursor for either `data["...` or
    // `data.get("...`. We deliberately use a regex over the line
    // because tracking Python tokens via the CM6 syntax tree adds a
    // lot of complexity for no UX win.
    const before = ctx.matchBefore(SUBSCRIPT_RE);
    if (!before) return null;
    const partial = before.text.match(/["']([^"']*)$/)?.[1] ?? '';
    const quoteIdx = before.text.lastIndexOf(partial.length > 0 ? partial : '"');
    const from = before.from + (quoteIdx === -1 ? before.text.length : quoteIdx);
    const options: Completion[] = topKeys.map((key) => ({
      label: key,
      // Insert the key + closing quote + closing bracket so
      // `data["` becomes `data["key"]` in one shot.
      apply: (view, _completion, fromPos, toPos) => {
        view.dispatch({
          changes: { from: fromPos, to: toPos, insert: `${key}"]` },
          selection: { anchor: fromPos + key.length + 2 },
        });
      },
      detail: typeOf[key],
      info: describedBy[key],
      type: 'property',
      boost: 99,
    }));
    return {
      from,
      options,
      validFor: /^[\w_]*$/,
    };
  };
}

/** Turn a list of dotted paths into the unique top-level keys + a
 *  type/description map for each, derived from the FIRST sample seen. */
export function paramsFromReferenceableOutputs(
  outputs: Array<{ path: string; description: string; sample?: unknown }>
): SchemaCompletionSourceOpts {
  const seen = new Set<string>();
  const topKeys: string[] = [];
  const describedBy: Record<string, string> = {};
  const typeOf: Record<string, string> = {};
  for (const o of outputs) {
    if (!o.path) continue;
    const head = o.path.split('.')[0];
    if (!head || seen.has(head)) continue;
    seen.add(head);
    topKeys.push(head);
    if (o.path === head && o.description) describedBy[head] = o.description;
    if (o.sample !== undefined) typeOf[head] = sampleType(o.sample);
  }
  return { topKeys, describedBy, typeOf };
}

function sampleType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `list[${v.length}]`;
  switch (typeof v) {
    case 'string':
      return 'str';
    case 'number':
      return Number.isInteger(v) ? 'int' : 'float';
    case 'boolean':
      return 'bool';
    case 'object':
      return 'dict';
    default:
      return typeof v;
  }
}
