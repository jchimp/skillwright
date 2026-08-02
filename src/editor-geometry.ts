/**
 * Screen geometry for the current editor selection, so an overlay can be pinned
 * to it. Obsidian's `Editor` exposes no coordinates, so this reaches through to
 * the CodeMirror view underneath. That handle is not public API — every accessor
 * feature-detects and returns null instead of throwing, following the same
 * pattern as obsidian-internal.ts.
 */
import type { Editor } from "obsidian";

/** The one CodeMirror method we need, structurally typed so CM isn't a dependency. */
interface CmView {
  coordsAtPos(pos: number): { left: number; right: number; top: number; bottom: number } | null;
}

function cmView(editor: Editor): CmView | null {
  const cm = (editor as unknown as { cm?: Partial<CmView> }).cm;
  if (!cm || typeof cm.coordsAtPos !== "function") return null;
  return cm as CmView;
}

/** Where an overlay should be anchored, in viewport coordinates. */
export interface SelectionAnchor {
  /** Left edge of the selection's first line. */
  left: number;
  /** Top of the selection's first line — the flip-above reference. */
  top: number;
  /** Bottom of the selection's last line — the normal drop-below reference. */
  bottom: number;
}

/**
 * Locates the current selection on screen.
 *
 * Measures both ends: the head anchors the horizontal position, the tail decides
 * how far down the bar has to clear. Both are needed because a selection can run
 * over many lines.
 *
 * @param editor - editor whose selection to measure
 * @returns viewport-relative anchor, or null if CodeMirror internals are
 *   unavailable or either end is scrolled out of the rendered viewport
 */
export function selectionAnchor(editor: Editor): SelectionAnchor | null {
  const cm = cmView(editor);
  if (!cm) return null;

  try {
    const head = cm.coordsAtPos(editor.posToOffset(editor.getCursor("from")));
    const tail = cm.coordsAtPos(editor.posToOffset(editor.getCursor("to")));
    if (!head || !tail) return null;
    return { left: head.left, top: head.top, bottom: tail.bottom };
  } catch {
    // A position outside the rendered range throws rather than returning null in
    // some CM builds; treat it the same as "can't measure".
    return null;
  }
}
