import {
  App,
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  Modal,
  Notice,
  Setting,
} from "obsidian";
import type { Skill } from "./skills";
import type { ProviderId } from "./providers";
import { renderSideBySideDiff } from "./diffview";
import { matchSkills, resolveSkillToken, skillSlug, tokenAtCursor } from "./skillref";

/** Rows shown in the `/` autocomplete before it starts scrolling. */
const MAX_SUGGESTIONS = 8;

/** Box and text metrics the caret mirror has to copy for its wrapping to match. */
const MIRROR_PROPS = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
] as const;

/**
 * Pixel position of a character offset inside a textarea, relative to the
 * element's own top-left corner.
 *
 * A textarea exposes no caret geometry, so this measures an off-screen div that
 * mirrors the element's box and text metrics with a zero-width marker at the
 * offset. The text after the marker is included so line wrapping matches.
 *
 * @param ta - the textarea to measure
 * @param index - character offset to locate
 * @returns caret left/top in pixels, plus the line height at that point
 */
function caretCoords(
  ta: HTMLTextAreaElement,
  index: number
): { left: number; top: number; height: number } {
  const cs = window.getComputedStyle(ta);
  const mirror = document.body.createDiv();
  const style = mirror.style as unknown as Record<string, string>;
  const computed = cs as unknown as Record<string, string>;
  for (const p of MIRROR_PROPS) style[p] = computed[p];
  style.position = "absolute";
  style.top = "0";
  style.left = "-9999px";
  style.visibility = "hidden";
  style.height = "auto";
  style.whiteSpace = "pre-wrap";
  style.overflowWrap = "break-word";

  mirror.setText(ta.value.slice(0, index));
  // Zero-width space: occupies a line box to measure, but no horizontal room,
  // so it can't shift the very position it is measuring.
  const marker = mirror.createSpan({ text: "​" });
  mirror.createSpan({ text: ta.value.slice(index) });

  const left = marker.offsetLeft;
  const top = marker.offsetTop;
  const height = marker.offsetHeight || parseFloat(cs.lineHeight) || 16;
  mirror.remove();

  return { left: left - ta.scrollLeft, top: top - ta.scrollTop, height };
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export interface RewriteChoice {
  skill: Skill | null;
  instruction: string;
  provider: ProviderId;
  model: string;
}

/**
 * Freeform instruction with `/skill` autocomplete, plus a dropdown picker and a
 * provider/model override.
 */
export class RewriteModal extends Modal {
  private skills: Skill[];
  private defaults: { provider: ProviderId; model: string };
  private onSubmit: (choice: RewriteChoice) => void;

  private selectedSkill: Skill | null = null;
  private instruction = "";
  private provider: ProviderId;
  private model: string;

  // Built in onOpen(); every handler runs after that, so the null checks at
  // their use sites never actually fire.
  private infoButton: ExtraButtonComponent | null = null;
  private skillDropdown: DropdownComponent | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private suggestEl: HTMLElement | null = null;

  /** Skills currently listed in the popup; empty means the popup is closed. */
  private suggestions: Skill[] = [];
  private activeIndex = 0;
  /** Offset of the `/` the popup is anchored to. */
  private tokenStart = 0;
  /** True when the current selection came from a `/token`, so deleting it clears. */
  private skillFromText = false;

  constructor(
    app: App,
    skills: Skill[],
    defaults: { provider: ProviderId; model: string },
    onSubmit: (choice: RewriteChoice) => void
  ) {
    super(app);
    this.skills = skills;
    this.defaults = defaults;
    this.provider = defaults.provider;
    this.model = defaults.model;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("skillwright-modal");
    contentEl.createEl("h3", { text: "Rewrite selection" });

    // setClass flips this row to a stacked layout in CSS, so the textarea reads
    // as a full-width chat field under its label rather than a right-hand control.
    new Setting(contentEl)
      .setName("Instruction")
      .setDesc('e.g. "rewrite in Lab Notes voice /jchimp-brand", "tighten to half length"')
      .setClass("skillwright-instruction-row")
      .addTextArea((ta) => {
        ta.setPlaceholder("What should happen to the selection?  Type / to pick a skill.");
        ta.inputEl.rows = 4;
        ta.inputEl.addClass("skillwright-instruction");
        this.inputEl = ta.inputEl;

        // The popup is absolutely positioned against this wrapper, so it has to
        // sit between the textarea and its Setting row rather than alongside.
        const wrap = ta.inputEl.parentElement?.createDiv({ cls: "skillwright-instruction-wrap" });
        if (wrap) {
          wrap.appendChild(ta.inputEl);
          this.suggestEl = wrap.createDiv({ cls: "skillwright-suggest" });
          this.suggestEl.hide();
        }

        window.setTimeout(() => ta.inputEl.focus(), 0);
        for (const ev of ["input", "keyup", "click"] as const) {
          ta.inputEl.addEventListener(ev, () => this.syncFromText());
        }
        ta.inputEl.addEventListener("keydown", (e) => this.onInputKeydown(e));
        // Deferred so a mousedown on a suggestion row still lands first.
        ta.inputEl.addEventListener("blur", () => window.setTimeout(() => this.closeSuggest(), 100));
      });

    // The description lives behind this button rather than inline: as a live
    // block of text it resized the dialog on every selection change.
    new Setting(contentEl)
      .setName("Skill")
      .setDesc("Optional. Loaded from your skills folder.")
      .addExtraButton((b) => {
        this.infoButton = b;
        b.setIcon("info")
          .setTooltip("Show skill description")
          .setDisabled(true)
          .onClick(() => {
            if (this.selectedSkill) new SkillInfoModal(this.app, this.selectedSkill).open();
          });
      })
      .addDropdown((dd) => {
        this.skillDropdown = dd;
        dd.addOption("", "— none (instruction only) —");
        // Indexes, not names: two skills can share a frontmatter `name`.
        this.skills.forEach((s, i) => dd.addOption(String(i), s.name));
        dd.onChange((v) => {
          this.setSkill(v === "" ? null : this.skills[Number(v)] ?? null, "dropdown");
        });
      });

    new Setting(contentEl)
      .setName("Provider / model")
      .addDropdown((dd) => {
        for (const [id, label] of Object.entries(PROVIDER_LABELS)) dd.addOption(id, label);
        dd.setValue(this.provider);
        dd.onChange((v) => (this.provider = v as ProviderId));
      })
      .addText((t) => {
        t.setPlaceholder("model override (optional)");
        t.onChange((v) => (this.model = v.trim()));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Rewrite (Ctrl+Enter)")
        .setCta()
        .onClick(() => this.submit())
    );
  }

  /**
   * Points every view of the selection at one skill.
   *
   * @param skill - the skill now in effect, or null for none
   * @param source - `"text"` for a `/token`, `"dropdown"` for the picker. A text
   *   change also moves the dropdown; the reverse would fight the user's typing.
   */
  private setSkill(skill: Skill | null, source: "text" | "dropdown"): void {
    this.selectedSkill = skill;
    this.skillFromText = source === "text" && skill !== null;
    this.infoButton?.setDisabled(!skill);
    this.infoButton?.setTooltip(skill ? `About "${skill.name}"` : "Show skill description");
    if (source === "text") {
      const i = skill ? this.skills.indexOf(skill) : -1;
      this.skillDropdown?.setValue(i >= 0 ? String(i) : "");
    }
  }

  /** Re-reads the textarea after any edit: resolves `/tokens`, repaints the popup. */
  private syncFromText(): void {
    const el = this.inputEl;
    if (!el) return;
    this.instruction = el.value;

    const { skill } = resolveSkillToken(el.value, this.skills);
    if (skill) this.setSkill(skill, "text");
    // Deleting the token clears it, but a dropdown pick must survive typing.
    else if (this.skillFromText) this.setSkill(null, "text");

    const token = tokenAtCursor(el.value, el.selectionStart);
    if (!token) {
      this.closeSuggest();
      return;
    }
    this.tokenStart = token.start;
    this.openSuggest(matchSkills(token.query, this.skills).slice(0, MAX_SUGGESTIONS));
  }

  private openSuggest(matches: Skill[]): void {
    const box = this.suggestEl;
    if (!box) return;
    if (!matches.length) {
      this.closeSuggest();
      return;
    }

    this.suggestions = matches;
    this.activeIndex = Math.min(this.activeIndex, matches.length - 1);
    box.empty();
    matches.forEach((s, i) => {
      const row = box.createDiv({ cls: "skillwright-suggest-item" });
      row.toggleClass("is-active", i === this.activeIndex);
      row.createDiv({ cls: "skillwright-suggest-name", text: skillSlug(s.name) });
      if (s.description) {
        row.createDiv({ cls: "skillwright-suggest-desc", text: s.description });
      }
      // mousedown, not click: the textarea's blur would close the popup first.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.acceptSuggestion(i);
      });
    });
    box.show();
    this.positionSuggest();
  }

  /**
   * Anchors the popup under the `/` that opened it. Measured after the rows are
   * in the DOM, so the box's own width is known and can be clamped against the
   * textarea's right edge instead of spilling out of the modal.
   */
  private positionSuggest(): void {
    const el = this.inputEl;
    const box = this.suggestEl;
    if (!el || !box) return;

    const { left, top, height } = caretCoords(el, this.tokenStart);
    const maxLeft = Math.max(0, el.offsetWidth - box.offsetWidth);
    box.style.left = `${el.offsetLeft + Math.min(Math.max(left, 0), maxLeft)}px`;
    box.style.top = `${el.offsetTop + top + height + 4}px`;
  }

  private closeSuggest(): void {
    this.suggestions = [];
    this.activeIndex = 0;
    this.suggestEl?.hide();
  }

  private moveActive(delta: number): void {
    const n = this.suggestions.length;
    if (!n) return;
    this.activeIndex = (this.activeIndex + delta + n) % n;
    this.openSuggest(this.suggestions);
  }

  /** Splices `/<slug> ` over the token under the caret. */
  private acceptSuggestion(index: number): void {
    const el = this.inputEl;
    const skill = this.suggestions[index];
    if (!el || !skill) return;

    const token = tokenAtCursor(el.value, el.selectionStart);
    if (!token) {
      this.closeSuggest();
      return;
    }

    const insert = `/${skillSlug(skill.name)} `;
    el.value = el.value.slice(0, token.start) + insert + el.value.slice(token.end);
    const caret = token.start + insert.length;
    el.setSelectionRange(caret, caret);
    this.instruction = el.value;

    this.closeSuggest();
    this.setSkill(skill, "text");
    el.focus();
  }

  private onInputKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      this.submit();
      return;
    }
    if (!this.suggestions.length) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.moveActive(-1);
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        this.acceptSuggestion(this.activeIndex);
        break;
      case "Escape":
        // Stop it reaching Obsidian's modal scope, which would close the dialog.
        e.preventDefault();
        e.stopPropagation();
        this.closeSuggest();
        break;
    }
  }

  private submit(): void {
    // The text is authoritative: a `/token` overrides whatever the dropdown holds.
    const text = this.inputEl?.value ?? this.instruction;
    const { skill, cleaned } = resolveSkillToken(text, this.skills);
    const chosen = skill ?? this.selectedSkill;
    const instruction = cleaned.trim();

    if (!chosen && !instruction) {
      new Notice("Pick a skill or type an instruction.");
      return;
    }
    this.close();
    this.onSubmit({
      skill: chosen,
      instruction,
      provider: this.provider,
      model: this.model || (this.provider === this.defaults.provider ? this.defaults.model : ""),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Read-only detail view for one skill, opened from the info button. */
export class SkillInfoModal extends Modal {
  private skill: Skill;

  constructor(app: App, skill: Skill) {
    super(app);
    this.skill = skill;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("skillwright-modal", "skillwright-info");
    contentEl.createEl("h3", { text: this.skill.name });
    contentEl.createEl("div", {
      text: this.skill.description || "No description in this skill's frontmatter.",
      cls: this.skill.description ? "skillwright-info-desc" : "skillwright-info-desc is-empty",
    });
    contentEl.createEl("div", { text: this.skill.filePath, cls: "skillwright-info-path" });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Grows a textarea to fit its content. CSS caps it with max-height, so the
 * element scrolls internally past that point instead of running off the modal.
 * @param ta - textarea to resize in place
 */
function fitToContent(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto"; // collapse first, or scrollHeight can only ever grow
  ta.style.height = `${ta.scrollHeight}px`;
}

export type ResultAction = "replace" | "insert" | "copy" | "dismiss";

/** What actually produced the result, shown back to the user for verification. */
export interface ResultMeta {
  provider: ProviderId;
  model: string;
  skill: string | null;
}

/** One rewrite attempt: the model's raw output plus the user's hand-edits to it. */
export interface Attempt {
  text: string;
  edited: string;
  meta: ResultMeta;
}

/** Options for {@link ResultModal}. */
export interface ResultModalOptions {
  title: string;
  original: string;
  first: { text: string; meta: ResultMeta };
  onAction: (action: ResultAction, text: string) => void;
  /** Re-issues the identical request. Rejects on provider error. */
  onRerun: () => Promise<{ text: string; meta: ResultMeta }>;
}

/** Shows original vs. result (diff or editable text), with attempt history and Re-Run. */
export class ResultModal extends Modal {
  private title: string;
  private original: string;
  private onAction: (action: ResultAction, text: string) => void;
  private onRerun: () => Promise<{ text: string; meta: ResultMeta }>;

  private attempts: Attempt[];
  private index = 0;
  private view: "diff" | "edit" = "diff";
  private busy = false;
  private closed = false;

  private metaEl!: HTMLElement;
  private diffToggleBtn!: HTMLButtonElement;
  private editToggleBtn!: HTMLButtonElement;
  private navEl!: HTMLElement;
  private navPrevBtn!: HTMLButtonElement;
  private navNextBtn!: HTMLButtonElement;
  private navLabelEl!: HTMLElement;
  private paneEl!: HTMLElement;
  private rerunButton!: ButtonComponent;
  private replaceButton!: ButtonComponent;
  private insertButton!: ButtonComponent;
  private copyButton!: ButtonComponent;
  private dismissButton!: ButtonComponent;

  constructor(app: App, opts: ResultModalOptions) {
    super(app);
    this.title = opts.title;
    this.original = opts.original;
    this.onAction = opts.onAction;
    this.onRerun = opts.onRerun;
    this.attempts = [{ text: opts.first.text, edited: opts.first.text, meta: opts.first.meta }];
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("skillwright-modal", "skillwright-result");
    contentEl.createEl("h3", { text: this.title });

    this.metaEl = contentEl.createEl("div", { cls: "skillwright-meta" });

    const toolbar = contentEl.createEl("div", { cls: "skillwright-toolbar" });

    const toggle = toolbar.createEl("div", { cls: "skillwright-toggle" });
    this.diffToggleBtn = toggle.createEl("button", { text: "Diff" });
    this.diffToggleBtn.type = "button";
    this.diffToggleBtn.addEventListener("click", () => {
      this.view = "diff";
      this.render();
    });
    this.editToggleBtn = toggle.createEl("button", { text: "Edit" });
    this.editToggleBtn.type = "button";
    this.editToggleBtn.addEventListener("click", () => {
      this.view = "edit";
      this.render();
    });

    this.navEl = toolbar.createEl("div", { cls: "skillwright-nav" });
    this.navPrevBtn = this.navEl.createEl("button", { text: "‹" });
    this.navPrevBtn.type = "button";
    this.navPrevBtn.addEventListener("click", () => {
      if (this.index > 0) {
        this.index -= 1;
        this.render();
      }
    });
    this.navLabelEl = this.navEl.createEl("span", { cls: "skillwright-nav-label" });
    this.navNextBtn = this.navEl.createEl("button", { text: "›" });
    this.navNextBtn.type = "button";
    this.navNextBtn.addEventListener("click", () => {
      if (this.index < this.attempts.length - 1) {
        this.index += 1;
        this.render();
      }
    });

    this.paneEl = contentEl.createEl("div", { cls: "skillwright-pane" });

    const row = contentEl.createEl("div", { cls: "skillwright-actions" });
    this.rerunButton = new ButtonComponent(row)
      .setButtonText("Re-Run")
      .onClick(() => this.rerun());
    this.replaceButton = new ButtonComponent(row)
      .setButtonText("Replace")
      .setCta()
      .onClick(() => this.act("replace"));
    this.insertButton = new ButtonComponent(row)
      .setButtonText("Insert below")
      .onClick(() => this.act("insert"));
    this.copyButton = new ButtonComponent(row).setButtonText("Copy").onClick(() => this.act("copy"));
    this.dismissButton = new ButtonComponent(row)
      .setButtonText("Dismiss")
      .onClick(() => this.act("dismiss"));

    this.render();
  }

  /** Repaints meta chips, toggle state, nav, and the diff/edit pane for the current attempt. */
  private render(): void {
    const current = this.attempts[this.index];

    this.metaEl.empty();
    this.metaEl.createEl("span", {
      text: `${PROVIDER_LABELS[current.meta.provider] ?? current.meta.provider} · ${current.meta.model}`,
      cls: "skillwright-meta-item",
    });
    this.metaEl.createEl("span", {
      text: current.meta.skill ? `Skill: ${current.meta.skill}` : "Skill: none (instruction only)",
      cls: "skillwright-meta-item",
    });

    this.diffToggleBtn.toggleClass("is-active", this.view === "diff");
    this.editToggleBtn.toggleClass("is-active", this.view === "edit");

    const multi = this.attempts.length > 1;
    this.navEl.style.display = multi ? "" : "none";
    this.navPrevBtn.disabled = this.busy || this.index === 0;
    this.navNextBtn.disabled = this.busy || this.index === this.attempts.length - 1;
    this.navLabelEl.setText(`attempt ${this.index + 1} / ${this.attempts.length}`);

    this.paneEl.empty();
    // Edit mode's children carry their own chrome, so the pane drops its own.
    this.paneEl.toggleClass("skillwright-pane-edit", this.view === "edit");
    if (this.view === "diff") {
      renderSideBySideDiff(this.paneEl, this.original, current.edited);
    } else {
      this.paneEl.createEl("div", { text: "Original", cls: "skillwright-label" });
      this.paneEl.createEl("div", { text: this.original, cls: "skillwright-original" });

      this.paneEl.createEl("div", { text: "Result (editable)", cls: "skillwright-label" });
      const ta = this.paneEl.createEl("textarea", { cls: "skillwright-result-text" });
      ta.value = current.edited;
      ta.addEventListener("input", () => {
        this.attempts[this.index].edited = ta.value;
        fitToContent(ta);
      });
      fitToContent(ta);
      // scrollHeight reads 0 until the modal has been laid out, so measure again next tick.
      window.setTimeout(() => fitToContent(ta), 0);
    }
  }

  private setActionsEnabled(enabled: boolean): void {
    this.replaceButton.setDisabled(!enabled);
    this.insertButton.setDisabled(!enabled);
    this.copyButton.setDisabled(!enabled);
    this.dismissButton.setDisabled(!enabled);
    this.navPrevBtn.disabled = !enabled || this.index === 0;
    this.navNextBtn.disabled = !enabled || this.index === this.attempts.length - 1;
  }

  private async rerun(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.rerunButton.setDisabled(true);
    this.rerunButton.setButtonText("Re-running…");
    this.setActionsEnabled(false);
    try {
      const { text, meta } = await this.onRerun();
      if (this.closed) return;
      this.attempts.push({ text, edited: text, meta });
      this.index = this.attempts.length - 1;
      this.render();
    } catch (e) {
      if (!this.closed) new Notice(`Skillwright error: ${(e as Error).message}`, 8000);
    } finally {
      if (!this.closed) {
        this.busy = false;
        this.rerunButton.setDisabled(false);
        this.rerunButton.setButtonText("Re-Run");
        this.setActionsEnabled(true);
      }
    }
  }

  private act(action: ResultAction): void {
    this.close();
    this.onAction(action, this.attempts[this.index].edited);
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}
