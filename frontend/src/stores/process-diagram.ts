/*
 * Zustand store for one ProcessDiagram document.
 *
 * Owns the live diagram doc + UI selection. Autosave debounces PATCH
 * /process-diagrams/{id} every 2 seconds (per plan); a `markDirty()`
 * helper kicks the debounce so AI-suggest callers can persist without
 * waiting.
 *
 * The store does NOT swallow server-side responses to AI-suggest — the
 * caller merges the response into the doc, then autosave fires. Resolves
 * the v3 audit's autosave + AI race (no server-side AI writes mutate the
 * doc behind the autosave's back).
 */
import { create } from 'zustand';
import { api } from '@/api/client';
import { ProcessDiagramDoc, blankDiagramDoc } from '@/lib/process-diagram';

export type SelectionKind = 'system' | 'object' | 'flow' | 'edge' | 'match' | null;
export interface Selection {
  kind: SelectionKind;
  id: string | null;
}

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface ProcessDiagramState {
  diagramId: string | null;
  name: string;
  doc: ProcessDiagramDoc;
  selection: Selection;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: number | null;
  integrationId: string | null;

  hydrate: (row: {
    id: string;
    name: string;
    document: Record<string, unknown>;
    integration_id: string | null;
  }) => void;

  setName: (name: string) => void;
  updateDoc: (patch: (doc: ProcessDiagramDoc) => void) => void;
  setSelection: (selection: Selection) => void;
  setIntegrationId: (id: string | null) => void;

  /** Schedule an autosave debounced ~2s. Called automatically by updateDoc. */
  scheduleSave: () => void;
  /** Save immediately (used before navigate-away). */
  saveNow: () => Promise<void>;
}

const AUTOSAVE_DEBOUNCE_MS = 2000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useProcessDiagramStore = create<ProcessDiagramState>((set, get) => ({
  diagramId: null,
  name: '',
  doc: blankDiagramDoc(),
  selection: { kind: null, id: null },
  saveStatus: 'idle',
  saveError: null,
  lastSavedAt: null,
  integrationId: null,

  hydrate: (row) => {
    set({
      diagramId: row.id,
      name: row.name,
      doc: { ...blankDiagramDoc(), ...(row.document as Partial<ProcessDiagramDoc>) } as ProcessDiagramDoc,
      integrationId: row.integration_id,
      saveStatus: 'idle',
      saveError: null,
      lastSavedAt: Date.now(),
    });
  },

  setName: (name) => {
    set({ name });
    get().scheduleSave();
  },

  updateDoc: (patch) => {
    // Immer-style: produce a new doc by calling the patch fn against a clone
    const cloned: ProcessDiagramDoc = JSON.parse(JSON.stringify(get().doc));
    patch(cloned);
    set({ doc: cloned, saveStatus: 'pending' });
    get().scheduleSave();
  },

  setSelection: (selection) => set({ selection }),

  setIntegrationId: (id) => set({ integrationId: id }),

  scheduleSave: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void get().saveNow();
    }, AUTOSAVE_DEBOUNCE_MS);
  },

  saveNow: async () => {
    const { diagramId, name, doc, integrationId } = get();
    if (!diagramId) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({ saveStatus: 'saving', saveError: null });
    try {
      await api.updateDiagram(diagramId, {
        name,
        document: doc as unknown as Record<string, unknown>,
        integration_id: integrationId,
      });
      set({ saveStatus: 'saved', lastSavedAt: Date.now() });
    } catch (e) {
      set({
        saveStatus: 'error',
        saveError: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
