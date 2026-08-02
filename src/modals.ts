import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { Skill } from "./skills";
import type { ProviderId } from "./providers";
import { renderSideBySideDiff } from "./diffview";

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

/** Skill picker + freeform instruction + provider/model override. */
export class RewriteModal extends Modal {
  private skills: Skill[];
  private defaults: { provider: ProviderId; model: string };
  private onSubmit: (choice: RewriteChoice) => void;

  private selectedSkill: Skill | null = null;
  private instruction = "";
  private provider: ProviderId;
  private model: string;

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

    new Setting(contentEl)
      .setName("Skill")
      .setDesc("Optional. Loaded from your skills folder.")
      .addDropdown((dd) => {
        dd.addOption("", "— none (instruction only) —");
        for (const s of this.skills) dd.addOption(s.name, s.name);
        dd.onChange((v) => {
          this.selectedSkill = this.skills.find((s) => s.name === v) ?? null;
          descEl.setText(this.selectedSkill?.description ?? "");
        });
      });

    const descEl = contentEl.createEl("div", { cls: "skillwright-skill-desc" });

    new Setting(contentEl)
      .setName("Instruction")
      .setDesc('e.g. "rewrite in Lab Notes voice", "tighten to half length"')
      .addTextArea((ta) => {
        ta.setPlaceholder("What should happen to the selection?");
        ta.inputEl.rows = 3;
        ta.inputEl.addClass("skillwright-instruction");
        ta.onChange((v) => (this.instruction = v));
        window.setTimeout(() => ta.inputEl.focus(), 0);
        ta.inputEl.addEventListener("keydown", (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") this.submit();
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

  private submit(): void {
    if (!this.selectedSkill && !this.instruction.trim()) {
      new Notice("Pick a skill or type an instruction.");
      return;
    }
    this.close();
    this.onSubmit({
      skill: this.selectedSkill,
      instruction: this.instruction.trim(),
      provider: this.provider,
      model: this.model || (this.provider === this.defaults.provider ? this.defaults.model : ""),
    });
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
