/*
 * Process diagram types — port of the design handoff's `scenario.js`
 * shape (`design_handoff_workflow_builder/src/scenario.js`) plus the
 * UI-state extensions the v3 plan calls for (lane positions, match
 * pill position, asked-questions log, AI caches).
 *
 * The shape lives in `ProcessDiagram.document` JSONB on the backend.
 */

export type SystemId = string;
export type ObjectId = string;
export type FlowId = string;
export type EdgeGuardId = string;
export type TriggerId = string;

export type ObjectKind = 'primary' | 'mirror' | 'reference' | 'computed';
export type FlowDirection = 'push' | 'pull' | 'merge';
export type FlowMode = 'sync' | 'async';
export type FlowRole = 'primary' | 'lookup' | 'native' | '3-way match';
export type EdgeKind = 'retry' | 'fallback' | 'guard';
export type TriggerVerb = 'on_create' | 'on_update' | 'manual' | 'schedule';
export type ConnectionStatus = 'healthy' | 'degraded' | 'down';

export interface System {
  id: SystemId;
  label: string;
  role: string;
  env: 'sandbox' | 'production';
  auth: string;
  connection: ConnectionStatus;
  connectionId: string | null;
  openapiSpecId: string | null;
  objectCount: number;
  glyph: string;
  tint: string; // CSS var name, e.g. 'var(--forge-500)'
  /** Brandfetch domain for the company logo. e.g. 'ramp.com', 'sageintacct.com'.
   *  Renders via `brandLogoUrl()` in the lane head. Falls back to monogram. */
  brandDomain?: string;
}

export interface Field {
  name: string;
  /** 'string' | 'uuid' | 'datetime' | 'money' | 'array' | 'enum' | 'ref → X' */
  type: string;
  sample?: unknown;
  required?: boolean;
  pii?: boolean;
  enums?: string[];
}

export interface ObjectNode {
  id: ObjectId;
  system: SystemId;
  label: string;
  kind: ObjectKind;
  /** Entity type used by the compiler to look up samplePath/createPath. */
  entityType?: string;
  glyph: string;
  sample: number; // count of synth records in the bank
  fields: Field[];
}

export type MappingSource =
  | { kind: 'path'; expression: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'transform'; expression: string }
  | { kind: 'lookup'; targetEntity: string; matchOn: string };

export interface FieldMapping {
  id: string;
  targetPath: string;
  source: MappingSource;
  confidence?: number;
  notes?: string;
  required?: boolean;
  reviewed?: boolean;
  rationale?: string;
  needs_review?: boolean;
}

export interface Flow {
  id: FlowId;
  from: ObjectId;
  to: ObjectId;
  direction: FlowDirection;
  mode: FlowMode;
  role: FlowRole;
  cadence: string;
  frequency?: 'rare' | 'frequent' | 'continuous';
  mapped: number;
  total: number;
  label: string;
  note?: string;
  native?: boolean;
  action?: 'create' | 'upsert' | 'attach';
  mappings?: FieldMapping[];
}

export interface EdgeGuard {
  id: EdgeGuardId;
  label: string;
  kind: EdgeKind;
  detail: string;
  attaches: FlowId[];
}

export interface TriggerSpec {
  id: TriggerId;
  verb: TriggerVerb;
  sourceObjectId: ObjectId;
  schedule?: { interval_seconds?: number; cron?: string };
}

export interface SampleRunStep {
  id: string;
  label: string;
  /** ObjectId or FlowId — particle anchor */
  node: string;
  ms: number;
}

export interface SampleRun {
  id: string;
  started: string;
  steps: SampleRunStep[];
}

export interface AIMappingCacheEntry {
  mappings: FieldMapping[];
  source: 'live' | 'cache' | 'fallback';
}

export interface GapFinderCacheEntry {
  questions: Array<{ tag: string; q: string }>;
  source?: 'live' | 'cache' | 'fallback';
}

export interface ReadinessSnapshot {
  score: number;
  at: string;
}

export interface ProcessDiagramDoc {
  schemaVersion: 1;
  client: string;
  title: string;
  subtitle?: string;
  goal?: string;
  systems: System[];
  objects: ObjectNode[];
  flows: Flow[];
  edges: EdgeGuard[];
  triggers: TriggerSpec[];
  sampleRun?: SampleRun;
  variables: Record<string, unknown>;

  // UI state — persisted so refresh restores pixel-perfect arrangement
  lanePositions: Record<SystemId, { x: number; y: number }>;
  matchPos: { x: number; y: number } | null;
  askedQuestions: Record<string, boolean>; // keyed by `slug(tag)+sha1(q)[0:8]`
  readinessSnapshot?: ReadinessSnapshot;

  // AI caches (per plan v3 — server-side, not localStorage)
  aiMappingCache?: Record<FlowId, AIMappingCacheEntry>;
  gapFinderCache?: GapFinderCacheEntry;
}


// ── Pure helpers ───────────────────────────────────────────────────────


/** Build a sensible default for a freshly-created diagram. */
export function blankDiagramDoc(opts: { client?: string; title?: string } = {}): ProcessDiagramDoc {
  return {
    schemaVersion: 1,
    client: opts.client || 'Untitled',
    title: opts.title || 'New process',
    systems: [],
    objects: [],
    flows: [],
    edges: [],
    triggers: [],
    variables: {},
    lanePositions: {},
    matchPos: null,
    askedQuestions: {},
  };
}


/** Build a stable key for an asked-question record — survives "regenerate
 *  · new angle" because tag+question hash > positional index. */
export async function askedQuestionKey(tag: string, q: string): Promise<string> {
  const slug = (tag || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  // sha1 first 8 hex chars via SubtleCrypto for browser compatibility
  const enc = new TextEncoder().encode(q);
  const hash = await crypto.subtle.digest('SHA-1', enc);
  const arr = Array.from(new Uint8Array(hash)).slice(0, 4);
  const hex = arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${slug}-${hex}`;
}


/** Build-readiness score — port of design's `computeReadiness` in
 *  `ai-gap.jsx:14-21`. Deterministic over the diagram. */
export function computeReadiness(doc: ProcessDiagramDoc): number {
  const flows = doc.flows || [];
  if (flows.length === 0) return 0;
  const totalMapped = flows.reduce((s, f) => s + (f.mapped || 0), 0);
  const totalNeeded = flows.reduce((s, f) => s + (f.total || 0), 0) || 1;
  const mapPct = totalMapped / totalNeeded;
  const dirSet =
    flows.filter((f) => !!f.direction && !!f.mode && !!f.cadence).length / flows.length;
  const errCov = Math.min(1, (doc.edges || []).length / 5);
  return Math.round((mapPct * 0.55 + dirSet * 0.3 + errCov * 0.15) * 100);
}
