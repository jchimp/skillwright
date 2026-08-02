import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { Skill } from "./skills";
import type { ProviderId } from "./providers";

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

export type ResultAction = "replace" | "insert" | "copy" | "dismiss";

/** What actually produced the result, shown back to the user for verification. */
export interface ResultMeta {
  provider: ProviderId;
  model: string;
  skill: string | null;
}

/** Shows original vs. result, editable, with Replace / Insert Below / Copy. */
export class ResultModal extends Modal {
  private original: string;
  private result: string;
  private title: string;
  private meta: ResultMeta;
  private onAction: (action: ResultAction, text: string) => void;
  private edited: string;

  constructor(
    app: App,
    title: string,
    original: string,
    result: string,
    meta: ResultMeta,
    onAction: (action: ResultAction, text: string) => void
  ) {
    super(app);
    this.title = title;
    this.original = original;
    this.result = result;
    this.meta = meta;
    this.edited = result;
    this.onAction = onAction;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("skillwright-modal", "skillwright-result");
    contentEl.createEl("h3", { text: this.title });

    const meta = contentEl.createEl("div", { cls: "skillwright-meta" });
    meta.createEl("span", {
      text: `${PROVIDER_LABELS[this.meta.provider] ?? this.meta.provider} · ${this.meta.model}`,
      cls: "skillwright-meta-item",
    });
    meta.createEl("span", {
      text: this.meta.skill ? `Skill: ${this.meta.skill}` : "Skill: none (instruction only)",
      cls: "skillwright-meta-item",
    });

    contentEl.createEl("div", { text: "Original", cls: "skillwright-label" });
    contentEl.createEl("div", { text: this.original, cls: "skillwright-original" });

    contentEl.createEl("div", { text: "Result (editable)", cls: "skillwright-label" });
    const ta = contentEl.createEl("textarea", { cls: "skillwright-result-text" });
    ta.value = this.result;
    ta.rows = Math.min(16, Math.max(4, this.result.split("\n").length + 1));
    ta.addEventListener("input", () => (this.edited = ta.value));

    const row = contentEl.createEl("div", { cls: "skillwright-actions" });
    new ButtonComponent(row)
      .setButtonText("Replace")
      .setCta()
      .onClick(() => this.act("replace"));
    new ButtonComponent(row).setButtonText("Insert below").onClick(() => this.act("insert"));
    new ButtonComponent(row).setButtonText("Copy").onClick(() => this.act("copy"));
    new ButtonComponent(row).setButtonText("Dismiss").onClick(() => this.act("dismiss"));
  }

  private act(action: ResultAction): void {
    this.close();
    this.onAction(action, this.edited);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
