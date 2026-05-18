/*
 * Procurement-vocab regex → emoji/glyph mapping.
 *
 * Drives the icon shown on ObjectCard / Inspector / Run drawer steps.
 * Falls back to the object's `glyph` field (then to kind-specific
 * default) when no keyword matches.
 *
 * Plain-English readability beats "engineering charm" here — a
 * non-IT-stakeholder should glance at a Bill card and know it's a Bill
 * because the icon is 🧾, not because they can decode `⊕`.
 */

import type { ObjectKind } from './process-diagram';


interface IconRule {
  pattern: RegExp;
  icon: string;
}

const RULES: IconRule[] = [
  // Order: most-specific first; the first match wins.
  { pattern: /purchase\s?order|^po\b|\bpo[-\s_]?(num|number)/i, icon: '📋' },
  { pattern: /vendor|supplier|merchant/i, icon: '🏢' },
  { pattern: /\bbill\b|invoice/i, icon: '🧾' },
  { pattern: /receipt|goods received|grn/i, icon: '📦' },
  { pattern: /payment|disburs|remit|ach\b|wire\b/i, icon: '💳' },
  { pattern: /approval|approver|review/i, icon: '✅' },
  { pattern: /contract|agreement|nda/i, icon: '📝' },
  { pattern: /category|account|gl|ledger/i, icon: '🗂' },
  { pattern: /entity|subsidiary|company|org/i, icon: '🏛' },
  { pattern: /tax|w-?9|w-?8/i, icon: '🧮' },
  { pattern: /card|virtual\s?card/i, icon: '💳' },
  { pattern: /budget|spend|expense/i, icon: '💸' },
  { pattern: /report|export|sync/i, icon: '🔄' },
  { pattern: /trip|travel|booking/i, icon: '✈️' },
  { pattern: /reimburs/i, icon: '↩️' },
  { pattern: /audit|log|trail/i, icon: '🔍' },
  { pattern: /trigger|webhook|event/i, icon: '⚡' },
  { pattern: /match/i, icon: '🔗' },
];


const KIND_FALLBACK: Record<ObjectKind, string> = {
  primary: '🔷',
  mirror: '🔁',
  reference: '🔖',
  computed: '⚙️',
};


export function iconForLabel(label: string | undefined, kind: ObjectKind): string {
  if (label) {
    for (const rule of RULES) {
      if (rule.pattern.test(label)) return rule.icon;
    }
  }
  return KIND_FALLBACK[kind] || '◷';
}


/**
 * One-line plain-English story for an object card. Built deterministically
 * from `kind + label + source flow cadence` so non-IT readers see the action
 * not the schema.
 */
export function storyForObject(opts: {
  kind: ObjectKind;
  label: string;
  sample?: number;
  /** Cadence of any inbound flow — pulled from the diagram doc by the caller. */
  inboundCadence?: string;
  /** True when this object is the source of a 3-way match merge. */
  feedsMatch?: boolean;
  /** Count of mapping inputs when kind === 'computed'. */
  inputCount?: number;
}): string {
  const { kind, sample, inboundCadence, feedsMatch, inputCount } = opts;
  const cadenceTail = inboundCadence ? ` · ${inboundCadence}` : '';
  const sampleTail = sample ? ` · ${sample} in bank` : '';
  switch (kind) {
    case 'primary':
      return inboundCadence
        ? `Source of truth${cadenceTail}`
        : `Source of truth${sampleTail}`;
    case 'mirror':
      return feedsMatch
        ? `Mirrored copy · feeds 3-way match`
        : `Mirrored from upstream${cadenceTail || sampleTail}`;
    case 'reference':
      return `Lookup table${sampleTail}`;
    case 'computed':
      return inputCount
        ? `Computed from ${inputCount} inputs · 3-way matched`
        : `Computed · derived from upstream`;
    default:
      return sampleTail.replace(/^ · /, '');
  }
}
