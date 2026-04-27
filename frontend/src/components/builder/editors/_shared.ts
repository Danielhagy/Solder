import type { SolderNode } from '@/stores/integration';

/**
 * Contract for every per-kind editor in this directory.
 *
 * Editors render only the kind-specific configuration UI. Cross-cutting
 * fields (the user-authored `label`, the `when` gate, the delete button,
 * and the aside chrome) stay in `PropertiesPanel.tsx`, which dispatches
 * by `node.kind.action` to the right editor.
 *
 * `set(key, value)` writes to `node.config` via the integration store —
 * editors don't reach into Zustand themselves so swapping persistence
 * later (e.g. transactional commits during an active run) only touches
 * the dispatcher.
 */
export interface EditorProps {
  node: SolderNode;
  set: (key: string, value: unknown) => void;
}
