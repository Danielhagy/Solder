/**
 * Schema inference for the reference picker + Python `data` autocomplete.
 *
 * Turns an arbitrary JSON value (the actual output of a past run) into a
 * flat list of dotted paths the picker / autocomplete can offer:
 *
 *   { id: 'po_001', vendor: { name: 'Acme', tier: 'gold' }, items: [...] }
 *
 *   →  [
 *     { path: 'id',          type: 'str' },
 *     { path: 'vendor',      type: 'dict' },
 *     { path: 'vendor.name', type: 'str' },
 *     { path: 'vendor.tier', type: 'str' },
 *     { path: 'items',       type: 'list[3]' },
 *   ]
 *
 * Lists of objects are surfaced as their TYPE (`list[N]`) at the parent
 * key, AND we walk into a representative element to expose its inner
 * paths. The representative element is chosen as the "richest" one —
 * the dict with the most leaf keys after recursive flattening — so the
 * picker shows the broadest possible field set, not just whatever
 * sparse first record happened to land. Ties go to the first match.
 *
 * Primitive top-level outputs ("string", 42, true) collapse to a
 * single root entry with no path; the picker's existing `path: ''`
 * fallback shape handles them.
 *
 * Pure / sync / no deps — safe to call on every render. Caps array
 * sample size + nesting depth so a 50k-record output doesn't melt the
 * UI thread.
 */

export interface InferredField {
  path: string;
  /** Friendly type chip for the picker / completion popup. */
  type: string;
  /** Hand-derived sample value for the leaf — small primitives only.
   *  Object / list samples are omitted (the picker can show a count). */
  sample?: unknown;
  /** One-line description. Currently only set for representative
   *  `list[N]` parents — describes which element we sampled. */
  description?: string;
}

const MAX_DEPTH = 6;
const MAX_KEYS_PER_OBJECT = 200;
const MAX_LIST_SCAN = 50;

export function inferSchema(value: unknown): InferredField[] {
  if (value === null || value === undefined) {
    return [{ path: '', type: 'null' }];
  }
  if (typeof value !== 'object') {
    return [{ path: '', type: friendlyType(value), sample: value }];
  }
  if (Array.isArray(value)) {
    return inferFromList(value, '');
  }
  return inferFromObject(value as Record<string, unknown>, '', 0);
}

function inferFromObject(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number
): InferredField[] {
  if (depth >= MAX_DEPTH) return [];
  const out: InferredField[] = [];
  let i = 0;
  for (const k of Object.keys(obj)) {
    if (i++ >= MAX_KEYS_PER_OBJECT) break;
    const path = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v === null || v === undefined) {
      out.push({ path, type: 'null' });
      continue;
    }
    if (typeof v !== 'object') {
      out.push({ path, type: friendlyType(v), sample: v });
      continue;
    }
    if (Array.isArray(v)) {
      out.push(...inferFromList(v, path));
      continue;
    }
    // Nested object — emit the parent type, then recurse.
    out.push({ path, type: 'dict' });
    out.push(...inferFromObject(v as Record<string, unknown>, path, depth + 1));
  }
  return out;
}

function inferFromList(list: unknown[], prefix: string): InferredField[] {
  const out: InferredField[] = [];
  const head = prefix || '';
  // Pick the richest element — the dict with the most leaf keys after
  // flattening — so the picker reflects the maximum-information shape
  // even when the first record is sparse. Ties: first wins.
  const sample = pickRichest(list);
  out.push({
    path: head,
    type: `list[${list.length}]`,
    description: sampleNote(list, sample),
  });
  if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
    // Walk the representative element under the same parent path so
    // tokens render as `items.id`, `items.vendor.name` — drop the [0]
    // index so the picker shows the *shape*, not a specific element.
    out.push(
      ...inferFromObject(sample as Record<string, unknown>, head, 0).filter(
        (f) => f.path !== head
      )
    );
  }
  return out;
}

function pickRichest(list: unknown[]): unknown {
  if (list.length === 0) return null;
  let best = list[0];
  let bestScore = score(best);
  const limit = Math.min(list.length, MAX_LIST_SCAN);
  for (let i = 1; i < limit; i++) {
    const s = score(list[i]);
    if (s > bestScore) {
      best = list[i];
      bestScore = s;
    }
  }
  return best;
}

/** Recursive leaf count — the heuristic for "richest" record. Caps
 *  depth so deeply-nested objects don't dominate the score. */
function score(v: unknown, depth = 0): number {
  if (v === null || v === undefined || depth >= MAX_DEPTH) return 0;
  if (typeof v !== 'object') return 1;
  if (Array.isArray(v)) {
    let s = 0;
    for (let i = 0; i < Math.min(v.length, 4); i++) s += score(v[i], depth + 1);
    return s + 1;
  }
  let s = 0;
  for (const k of Object.keys(v as object)) {
    s += score((v as Record<string, unknown>)[k], depth + 1);
  }
  return s;
}

function friendlyType(v: unknown): string {
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

function sampleNote(list: unknown[], sample: unknown): string | undefined {
  if (list.length === 0) return 'empty list';
  const idx = list.indexOf(sample);
  if (idx <= 0) return 'sampled from element 0';
  return `sampled from element ${idx} (richest of ${list.length})`;
}
