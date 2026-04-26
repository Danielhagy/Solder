/**
 * Shared DnD MIME constants and payload shapes for the builder canvas.
 *
 * Two MIMEs flow through the native HTML5 DnD channel:
 *  - DND_MIME_EXISTING: moves an existing node on the canvas (payload = node id string).
 *  - DND_MIME_NEW:      drops a brand-new node from the sidebar palette
 *                       (payload = JSON-encoded `NewNodePayload`).
 *
 * Drop handlers inspect `dataTransfer.types` to decide which branch to take.
 */
export const DND_MIME_EXISTING = 'application/x-solder-node';
export const DND_MIME_NEW = 'application/x-solder-new-node';

export interface NewNodePayload {
  kind: string;
  action: string;
}
