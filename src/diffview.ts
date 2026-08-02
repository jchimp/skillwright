import { diffWordsWithSpace } from "diff";
import "obsidian"; // brings createEl's HTMLElement augmentation into scope

// diffWordsWithSpace is O(n·d); above this combined length the UI would stutter noticeably,
// so skip diffing and just show the result.
const MAX_DIFF_CHARS = 20000;

/**
 * Renders a word-level diff of `original` -> `revised` into `parent` as spans.
 * @param parent - element to append the diff spans to; caller owns clearing it
 * @param original - text before the rewrite
 * @param revised - text after the rewrite
 */
export function renderInlineDiff(parent: HTMLElement, original: string, revised: string): void {
  if (original === revised) {
    parent.createEl("span", { text: revised });
    parent.createEl("div", { text: "No changes.", cls: "skillwright-diff-note" });
    return;
  }

  if (original.length + revised.length > MAX_DIFF_CHARS) {
    parent.createEl("span", { text: revised });
    parent.createEl("div", {
      text: "Selection too large to diff — showing result only.",
      cls: "skillwright-diff-note",
    });
    return;
  }

  const parts = diffWordsWithSpace(original, revised);
  for (const part of parts) {
    if (part.added) {
      parent.createEl("span", { text: part.value, cls: "skillwright-ins" });
    } else if (part.removed) {
      parent.createEl("span", { text: part.value, cls: "skillwright-del" });
    } else {
      parent.createEl("span", { text: part.value });
    }
  }
}
