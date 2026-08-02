import { diffLines, diffWordsWithSpace } from "diff";
import "obsidian"; // brings createEl's HTMLElement augmentation into scope

// The diff algorithms are O(n·d); above this combined length the UI would stutter
// noticeably, so skip diffing and just show the result.
const MAX_DIFF_CHARS = 20000;

type RowKind = "equal" | "changed" | "removed" | "added";

interface Row {
  kind: RowKind;
  /** null renders as an alignment filler cell on that side. */
  left: string | null;
  right: string | null;
  leftNo: number | null;
  rightNo: number | null;
}

/** Splits a diff chunk into lines, dropping the empty tail a trailing newline produces. */
function toLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Pairs each removed block with the added block that follows it so the two columns
 * stay aligned; the shorter side gets filler rows.
 */
function buildRows(original: string, revised: string): Row[] {
  const rows: Row[] = [];
  let leftNo = 1;
  let rightNo = 1;

  const flush = (removed: string[], added: string[]): void => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) {
      const l = i < removed.length ? removed[i] : null;
      const r = i < added.length ? added[i] : null;
      rows.push({
        kind: l !== null && r !== null ? "changed" : l !== null ? "removed" : "added",
        left: l,
        right: r,
        leftNo: l !== null ? leftNo++ : null,
        rightNo: r !== null ? rightNo++ : null,
      });
    }
  };

  const parts = diffLines(original, revised);
  let pendingRemoved: string[] = [];

  for (const part of parts) {
    const lines = toLines(part.value);
    if (part.removed) {
      pendingRemoved = pendingRemoved.concat(lines);
      continue;
    }
    if (part.added) {
      flush(pendingRemoved, lines);
      pendingRemoved = [];
      continue;
    }
    flush(pendingRemoved, []);
    pendingRemoved = [];
    for (const line of lines) {
      rows.push({ kind: "equal", left: line, right: line, leftNo: leftNo++, rightNo: rightNo++ });
    }
  }
  flush(pendingRemoved, []);

  return rows;
}

/**
 * Fills both cells of a changed row from a single word diff.
 *
 * One shared walk rather than one diff per cell: each part belongs to the left
 * unless it was added, and to the right unless it was removed, so neither side
 * can drift out of the other's frame of reference.
 *
 * @param left - cell for the original line
 * @param right - cell for the rewritten line
 * @param oldText - the original line
 * @param newText - the rewritten line
 */
function renderChangedRow(
  left: HTMLElement,
  right: HTMLElement,
  oldText: string,
  newText: string
): void {
  for (const part of diffWordsWithSpace(oldText, newText)) {
    if (!part.added) {
      left.createEl("span", {
        text: part.value,
        cls: part.removed ? "skillwright-del" : undefined,
      });
    }
    if (!part.removed) {
      right.createEl("span", {
        text: part.value,
        cls: part.added ? "skillwright-ins" : undefined,
      });
    }
  }
}

/**
 * Renders a side-by-side line diff of `original` -> `revised` into `parent`.
 * @param parent - element to append the diff into; caller owns clearing it
 * @param original - text before the rewrite
 * @param revised - text after the rewrite
 */
export function renderSideBySideDiff(parent: HTMLElement, original: string, revised: string): void {
  if (original === revised) {
    parent.createEl("div", { text: revised, cls: "skillwright-diff-plain" });
    parent.createEl("div", { text: "No changes.", cls: "skillwright-diff-note" });
    return;
  }

  if (original.length + revised.length > MAX_DIFF_CHARS) {
    parent.createEl("div", { text: revised, cls: "skillwright-diff-plain" });
    parent.createEl("div", {
      text: "Selection too large to diff — showing result only.",
      cls: "skillwright-diff-note",
    });
    return;
  }

  const grid = parent.createEl("div", { cls: "skillwright-sbs" });

  // Cells are direct grid children (rather than nested row elements) so the layout
  // works without subgrid support.
  grid.createEl("div", { cls: "skillwright-sbs-gutter skillwright-sbs-head" });
  grid.createEl("div", { text: "Original", cls: "skillwright-sbs-title skillwright-sbs-head" });
  grid.createEl("div", { cls: "skillwright-sbs-gutter skillwright-sbs-head" });
  grid.createEl("div", { text: "Result", cls: "skillwright-sbs-title skillwright-sbs-head" });

  for (const row of buildRows(original, revised)) {
    grid.createEl("div", {
      text: row.leftNo === null ? "" : String(row.leftNo),
      cls: "skillwright-sbs-gutter",
    });
    const left = grid.createEl("div", { cls: `skillwright-sbs-cell is-left is-${row.kind}` });
    grid.createEl("div", {
      text: row.rightNo === null ? "" : String(row.rightNo),
      cls: "skillwright-sbs-gutter",
    });
    const right = grid.createEl("div", { cls: `skillwright-sbs-cell is-right is-${row.kind}` });

    if (row.left === null) left.addClass("is-filler");
    if (row.right === null) right.addClass("is-filler");

    if (row.kind === "changed") {
      renderChangedRow(left, right, row.left as string, row.right as string);
    } else {
      if (row.left !== null) left.setText(row.left);
      if (row.right !== null) right.setText(row.right);
    }
  }
}
