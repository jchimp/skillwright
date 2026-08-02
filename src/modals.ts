import {
  App,
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  Modal,
  Notice,
  Setting,
  TextComponent,
} from "obsidian";
import type { Skill } from "./skills";
import type { ProviderId } from "./providers";
import { renderSideBySideDiff } from "./diffview";
import { resolveSkillToken } from "./skillref";
import { SkillSuggest } from "./suggest";

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
  private defaults: { provider: ProviderId; models: Record<ProviderId, string> };
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
  private suggest: SkillSuggest | null = null;
  private modelInput: TextComponent | null = null;

  constructor(
    app: App,
    skills: Skill[],
    defaults: { provider: ProviderId; models: Record<ProviderId, string> },
    onSubmit: (choice: RewriteChoice) => void
  ) {
    super(app);
    this.skills = skills;
    this.defaults = defaults;
    this.provider = defaults.provider;
    this.model = defaults.models[defaults.provider] ?? "";
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
          this.suggest = new SkillSuggest(wrap, ta.inputEl, this.skills, (skill) =>
            this.setSkill(skill, "text")
          );
          this.suggest.attach();
        }

        window.setTimeout(() => ta.inputEl.focus(), 0);
        ta.inputEl.addEventListener("input", () => (this.instruction = ta.inputEl.value));
        ta.inputEl.addEventListener("keydown", (e) => this.onInputKeydown(e));
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
            const skill = this.selectedSkill;
            if (!skill) return;
            new InfoModal(this.app, {
              heading: skill.name,
              body: skill.description || "No description in this skill's frontmatter.",
              muted: !skill.description,
              footnote: skill.filePath,
            }).open();
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
        dd.onChange((v) => {
          this.provider = v as ProviderId;
          // Show the newly picked provider's configured model, so the field
          // always names the model that would actually run.
          this.model = this.defaults.models[this.provider] ?? "";
          this.modelInput?.setValue(this.model);
        });
      })
      .addText((t) => {
        this.modelInput = t;
        t.setPlaceholder("model (from settings)");
        t.setValue(this.model);
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
    this.infoButton?.setDisabled(!skill);
    this.infoButton?.setTooltip(skill ? `About "${skill.name}"` : "Show skill description");
    if (source === "dropdown") this.suggest?.markExternalSelection();
    if (source === "text") {
      const i = skill ? this.skills.indexOf(skill) : -1;
      this.skillDropdown?.setValue(i >= 0 ? String(i) : "");
    }
  }

  private onInputKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      this.submit();
      return;
    }
    this.suggest?.handleKeydown(e);
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
      // Blank falls back to the provider's configured model in main.ts.
      model: this.model,
    });
  }

  onClose(): void {
    this.suggest?.destroy();
    this.suggest = null;
    this.contentEl.empty();
  }
}

/** Options for {@link InfoModal}. */
export interface InfoModalOptions {
  heading: string;
  /** Body text; newlines are preserved. */
  body: string;
  /** Renders the body muted and italic, for placeholder text. */
  muted?: boolean;
  /** Small monospace line under the body, e.g. a source path. */
  footnote?: string;
}

/** Small read-only explainer behind the (i) buttons. */
export class InfoModal extends Modal {
  private opts: InfoModalOptions;

  constructor(app: App, opts: InfoModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("skillwright-modal", "skillwright-info");
    contentEl.createEl("h3", { text: this.opts.heading });
    contentEl.createEl("div", {
      text: this.opts.body,
      cls: this.opts.muted ? "skillwright-info-desc is-empty" : "skillwright-info-desc",
    });
    if (this.opts.footnote) {
      contentEl.createEl("div", { text: this.opts.footnote, cls: "skillwright-info-path" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const TEMP_TOOLTIP =
  "Lower is steadier, higher is more varied. Click for detail.";

const TEMP_EXPLAINER = [
  "Temperature controls how much the model varies its wording from one run to the next.",
  "",
  "0.0 – 0.3   Near-deterministic. Re-runs come back nearly identical. Best when you want a skill's voice followed closely, or when comparing two prompts fairly.",
  "",
  "0.7   The default. Attempts differ noticeably in phrasing while still following the instruction.",
  "",
  "1.0 – 2.0   Progressively looser and more inventive, and progressively more likely to drift off the instruction or out of the skill's voice.",
  "",
  "The same prompt at the same temperature still varies — only 0 is close to repeatable. To compare, re-run a few times and step through the attempts with ‹ ›.",
].join("\n");

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
  /** Sampling temperature this attempt ran at; may differ per attempt. */
  temperature: number;
}

/** Bounds matching the settings tab, so the two can't disagree. */
const TEMP_MIN = 0;
const TEMP_MAX = 2;

/**
 * Reads a temperature out of the input box.
 *
 * @param raw - the field's current text
 * @param fallback - value to keep if the field is blank or unparseable
 * @returns a temperature clamped to the accepted range
 */
function clampTemperature(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, n));
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
  /**
   * Re-issues the same prompt at `temperature`. Rejects on provider error.
   * The override applies to that request only; it never touches the setting.
   */
  onRerun: (temperature: number) => Promise<{ text: string; meta: ResultMeta }>;
}

/** Shows original vs. result (diff or editable text), with attempt history and Re-Run. */
export class ResultModal extends Modal {
  private title: string;
  private original: string;
  private onAction: (action: ResultAction, text: string) => void;
  private onRerun: (temperature: number) => Promise<{ text: string; meta: ResultMeta }>;

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
  private tempInput!: HTMLInputElement;
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

    // Sits at the left end of the row (CSS pushes the buttons right) so it reads
    // as an input to Re-Run rather than another action.
    const temp = row.createEl("div", { cls: "skillwright-temp" });
    const tempId = "skillwright-temp-input";
    temp.createEl("label", { text: "Temp", attr: { for: tempId } });
    this.tempInput = temp.createEl("input", {
      attr: { id: tempId, type: "number", min: String(TEMP_MIN), max: String(TEMP_MAX), step: "0.1" },
    });
    this.tempInput.title = "Sampling temperature for the next Re-Run. Does not change the setting.";
    // Enter in the field is the same intent as clicking Re-Run.
    this.tempInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.rerun();
      }
    });

    new ExtraButtonComponent(temp)
      .setIcon("info")
      .setTooltip(TEMP_TOOLTIP)
      .onClick(() =>
        new InfoModal(this.app, { heading: "Temperature", body: TEMP_EXPLAINER }).open()
      );

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
    this.metaEl.createEl("span", {
      text: `Temp: ${current.meta.temperature}`,
      cls: "skillwright-meta-item",
    });

    // Refilled every repaint, so stepping through attempts shows the temperature
    // each one actually ran at rather than a stale edit.
    this.tempInput.value = String(current.meta.temperature);
    this.tempInput.disabled = this.busy;

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
    // Read before anything repaints, and fall back to the current attempt's value
    // so a blank or junk field re-runs at what you can see rather than at 0.
    const temperature = clampTemperature(
      this.tempInput.value,
      this.attempts[this.index].meta.temperature
    );

    this.busy = true;
    this.tempInput.disabled = true;
    this.rerunButton.setDisabled(true);
    this.rerunButton.setButtonText("Re-running…");
    this.setActionsEnabled(false);
    try {
      const { text, meta } = await this.onRerun(temperature);
      if (this.closed) return;
      this.attempts.push({ text, edited: text, meta });
      this.index = this.attempts.length - 1;
      this.render();
    } catch (e) {
      if (!this.closed) new Notice(`Skillwright error: ${(e as Error).message}`, 8000);
    } finally {
      if (!this.closed) {
        this.busy = false;
        this.tempInput.disabled = false;
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
