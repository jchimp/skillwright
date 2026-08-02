import { Editor, Notice, setIcon } from "obsidian";
import type { Skill } from "./skills";
import type { ProviderId } from "./providers";
import type { RewriteChoice } from "./modals";
import { resolveSkillToken } from "./skillref";
import { selectionAnchor } from "./editor-geometry";
import { SkillSuggest } from "./suggest";

/** Gap between the selection and the bar, in pixels. */
const OFFSET = 6;
/** Minimum breathing room between the bar and the window edge. */
const MARGIN = 8;

/** Set on `<body>` while a bar is open, so CSS can keep the selection visible. */
export const BAR_OPEN_CLASS = "skillwright-bar-open";

export interface InlineBarOptions {
  skills: Skill[];
  /** Provider and model the run will actually use; shown as a muted label. */
  provider: ProviderId;
  model: string;
  onSubmit: (choice: RewriteChoice) => void;
}

/**
 * Compact command bar pinned under the editor selection.
 *
 * A plain `document.body` child rather than a Modal: it must not take Obsidian's
 * modal focus scope or dim the workspace, because the whole point is to stay
 * next to the text you are rewriting. On submit it hands back the same
 * {@link RewriteChoice} the full dialog produces, so callers treat them alike.
 */
export class InlineRewriteBar {
  private editor: Editor;
  private opts: InlineBarOptions;

  private el: HTMLElement;
  private inputEl: HTMLInputElement;
  private suggest: SkillSuggest;

  private selectedSkill: Skill | null = null;
  private detach: Array<() => void> = [];
  private closed = false;

  /**
   * @param editor - editor holding the selection to anchor to
   * @param opts - skills to autocomplete, the provider/model label, and the submit handler
   */
  constructor(editor: Editor, opts: InlineBarOptions) {
    this.editor = editor;
    this.opts = opts;

    this.el = document.body.createDiv({ cls: "skillwright-bar" });
    const row = this.el.createDiv({ cls: "skillwright-bar-row" });

    this.inputEl = row.createEl("input", { cls: "skillwright-bar-input", type: "text" });
    this.inputEl.placeholder = "Rewrite…  type / for a skill";

    const accept = row.createEl("button", { cls: "skillwright-bar-accept mod-cta", text: "Accept" });
    accept.addEventListener("click", () => this.submit());

    const cancel = row.createEl("button", { cls: "skillwright-bar-cancel clickable-icon" });
    setIcon(cancel, "x");
    cancel.setAttr("aria-label", "Cancel (Esc)");
    cancel.addEventListener("click", () => this.close());

    this.el.createDiv({
      cls: "skillwright-bar-meta",
      text: `${opts.provider} · ${opts.model}`,
    });

    // The popup positions itself against the bar, which is the nearest
    // positioned ancestor of the input.
    this.suggest = new SkillSuggest(this.el, this.inputEl, opts.skills, (skill) => {
      this.selectedSkill = skill;
    });
  }

  /** Renders, positions, and focuses the bar. */
  open(): void {
    this.suggest.attach();
    this.inputEl.addEventListener("keydown", (e) => this.onKeydown(e));

    document.body.addClass(BAR_OPEN_CLASS);
    // reposition() closes the bar if the selection can't be measured, so don't
    // reach for the input afterwards without checking.
    this.reposition();
    if (this.closed) return;
    this.inputEl.focus();

    // Capture phase: workspace leaves scroll their own containers, and those
    // events do not bubble to window.
    this.on(window, "scroll", () => this.reposition(), true);
    this.on(window, "resize", () => this.reposition());
    // pointerdown, not blur — clicking a suggestion row must not kill the bar.
    this.on(document, "pointerdown", (e) => {
      if (!this.el.contains(e.target as Node)) this.close();
    });
  }

  /** Tears the bar down and hands focus back to the editor. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const off of this.detach) off();
    this.detach = [];
    this.suggest.destroy();
    this.el.remove();
    document.body.removeClass(BAR_OPEN_CLASS);
    this.editor.focus();
  }

  private on<K extends keyof WindowEventMap>(
    target: Window | Document,
    type: K,
    handler: (e: WindowEventMap[K]) => void,
    capture = false
  ): void {
    const fn = handler as EventListener;
    target.addEventListener(type, fn, capture);
    this.detach.push(() => target.removeEventListener(type, fn, capture));
  }

  /**
   * Re-anchors the bar under the selection. Closes instead if the selection can
   * no longer be measured — scrolled out of the rendered range, or the editor
   * went away — since a bar floating over unrelated text is worse than none.
   */
  private reposition(): void {
    const anchor = selectionAnchor(this.editor);
    if (!anchor) {
      this.close();
      return;
    }

    const { offsetWidth: w, offsetHeight: h } = this.el;
    const left = Math.min(Math.max(anchor.left, MARGIN), window.innerWidth - w - MARGIN);

    // Drop below by default; flip above when that would run off the bottom.
    let top = anchor.bottom + OFFSET;
    if (top + h > window.innerHeight - MARGIN) top = anchor.top - h - OFFSET;

    this.el.style.left = `${Math.max(left, MARGIN)}px`;
    this.el.style.top = `${Math.max(top, MARGIN)}px`;
  }

  private onKeydown(e: KeyboardEvent): void {
    // The popup gets first refusal: while it is open, Enter and Escape belong to
    // it, not to the bar.
    if (this.suggest.handleKeydown(e)) return;

    if (e.key === "Enter") {
      e.preventDefault();
      this.submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  private submit(): void {
    // The text is authoritative: a `/token` overrides whatever was picked before.
    const { skill, cleaned } = resolveSkillToken(this.inputEl.value, this.opts.skills);
    const chosen = skill ?? this.selectedSkill;
    const instruction = cleaned.trim();

    if (!chosen && !instruction) {
      new Notice("Pick a skill or type an instruction.");
      return;
    }

    this.close();
    this.opts.onSubmit({
      skill: chosen,
      instruction,
      provider: this.opts.provider,
      model: this.opts.model,
    });
  }
}
