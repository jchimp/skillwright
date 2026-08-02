import { Editor, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import { chat, ProviderId } from "./providers";
import { importSkillsZip, loadSkills, resolveSkillRefs, Skill } from "./skills";
import { skillSlug } from "./skillref";
import { resolveStores } from "./store";
import { ResultModal, RewriteModal, type ResultMeta, type RewriteChoice } from "./modals";
import { InlineRewriteBar } from "./inlinebar";
import { selectionAnchor } from "./editor-geometry";
import {
  DEFAULT_SETTINGS,
  PromptUi,
  SkillwrightSettings,
  SkillwrightSettingTab,
} from "./settings";

const SYSTEM_BASE = [
  "You are a precise text-editing assistant embedded in a markdown editor.",
  "You will be given a selected passage and an editing task.",
  "Return ONLY the rewritten passage: no preamble, no explanation, no code fences,",
  "no quotation marks around the result. Preserve markdown formatting unless the",
  "task says otherwise. Match the original's language unless asked to translate.",
].join(" ");

export default class SkillwrightPlugin extends Plugin {
  settings: SkillwrightSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SkillwrightSettingTab(this.app, this));

    this.addCommand({
      id: "rewrite-selection",
      name: "Rewrite selection…",
      editorCallback: (editor) => this.startRewrite(editor),
    });

    // A second entry point so the full dialog stays reachable no matter what
    // "Prompt style" is set to — the inline bar deliberately hides the skill
    // picker and the per-run model override.
    this.addCommand({
      id: "rewrite-selection-options",
      name: "Rewrite selection (all options)…",
      editorCallback: (editor) => this.startRewrite(editor, "modal"),
    });

    this.addCommand({
      id: "import-skills-zip",
      name: "Import skills from zip…",
      callback: () => this.pickAndImportZip(),
    });

    this.addCommand({
      id: "reload-skills",
      name: "List loaded skills",
      callback: async () => {
        const { skills, counts, shadowed } = await this.getSkills();
        if (!skills.length) {
          const where = counts.map((c) => c.label).join(", ");
          new Notice(`No skills found in: ${where}.`, 8000);
          return;
        }
        const lines = [
          `${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`,
          ...counts.map((c) => `  ${c.label}: ${c.count}`),
        ];
        if (shadowed.length) lines.push(`  shadowed: ${shadowed.join(", ")}`);
        new Notice(lines.join("\n"), 10000);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) =>
          item
            .setTitle("Skillwright: rewrite selection…")
            .setIcon("wand-2")
            .onClick(() => this.startRewrite(editor))
        );
      })
    );
  }

  /**
   * Loads skills from every configured source. Earlier stores win name collisions,
   * so a vault skill shadows a same-named one on disk — and the slash-token
   * resolver in skillref.ts never sees two skills with the same slug.
   *
   * @returns Merged skills sorted by name, plus what each source contributed.
   */
  private async getSkills(): Promise<{
    skills: Skill[];
    counts: Array<{ label: string; count: number }>;
    shadowed: string[];
  }> {
    const stores = await resolveStores(this.app, this.settings);
    const skills: Skill[] = [];
    const counts: Array<{ label: string; count: number }> = [];
    const shadowed: string[] = [];
    const seen = new Set<string>();

    for (const store of stores) {
      const loaded = await loadSkills(store);
      let kept = 0;
      for (const skill of loaded) {
        const slug = skillSlug(skill.name);
        if (seen.has(slug)) {
          shadowed.push(`${skill.name} (${store.label})`);
          continue;
        }
        seen.add(slug);
        skills.push(skill);
        kept++;
      }
      counts.push({ label: store.label, count: kept });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { skills, counts, shadowed };
  }

  /**
   * Collects an instruction for the current selection, then runs the rewrite.
   *
   * @param editor - editor holding the selection
   * @param force - overrides the "Prompt style" setting; used by the
   *   all-options command so the dialog is always reachable
   */
  private async startRewrite(editor: Editor, force?: PromptUi): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice("Select some text first.");
      return;
    }

    const { skills } = await this.getSkills();
    const s = this.settings;
    const run = (choice: RewriteChoice) => this.runRewrite(editor, selection, choice);

    // Falls back to the dialog when the selection can't be located on screen —
    // a bar with nothing to anchor to is worse than the dialog it replaced.
    const anchor = (force ?? s.promptUi) === "inline" ? selectionAnchor(editor) : null;
    if (anchor) {
      const provider = s.defaultProvider;
      new InlineRewriteBar(editor, {
        skills,
        provider,
        model: s[provider].model,
        onSubmit: run,
      }).open();
      return;
    }

    new RewriteModal(
      this.app,
      skills,
      {
        provider: s.defaultProvider,
        models: {
          ollama: s.ollama.model,
          openai: s.openai.model,
          anthropic: s.anthropic.model,
        },
      },
      run
    ).open();
  }

  /** Builds the prompts, calls the provider, and hands the result to the review dialog. */
  private async runRewrite(
    editor: Editor,
    selection: string,
    choice: RewriteChoice
  ): Promise<void> {
    const s = this.settings;
    const provider = choice.provider;
    const cfg = { ...s[provider] } as { baseUrl: string; apiKey?: string; model: string };
    if (choice.model) cfg.model = choice.model;
    if (!cfg.model) {
      new Notice(`No model configured for ${provider}.`);
      return;
    }
    if (provider !== "ollama" && !("apiKey" in cfg && cfg.apiKey)) {
      new Notice(`No API key configured for ${provider}.`);
      return;
    }

    const { system, skipped, missing } = await this.buildSystem(choice.skill);
    const user = this.buildUser(selection, choice.instruction, choice.skill);

    if (skipped.length || missing.length) {
      const warnings = [
        skipped.length ? `${skipped.length} reference(s) over budget (${skipped.join(", ")})` : "",
        missing.length ? `${missing.length} not found (${missing.join(", ")})` : "",
      ].filter(Boolean);
      new Notice(`Skillwright: ${warnings.join("; ")}.`, 8000);
    }

    // Closes over the original system/user built above, so Re-Run always re-rewrites
    // the original passage rather than the most recent attempt's output. Temperature
    // is the one exception: the result modal passes it per request, and the stored
    // setting is only ever read for the first run.
    const runOnce = async (temperature: number): Promise<{ text: string; meta: ResultMeta }> => {
      const text = (
        await chat(
          provider as ProviderId,
          { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey ?? "", model: cfg.model },
          { system, user, temperature, maxTokens: s.maxTokens }
        )
      ).trim();
      if (!text) throw new Error("Empty response from model.");
      return {
        text,
        meta: { provider, model: cfg.model, skill: choice.skill?.name ?? null, temperature },
      };
    };

    const notice = new Notice(`Skillwright: asking ${provider} (${cfg.model})…`, 0);
    try {
      const first = await runOnce(s.temperature);
      notice.hide();
      this.showResult(editor, selection, choice, first, runOnce);
    } catch (e) {
      notice.hide();
      new Notice(`Skillwright error: ${(e as Error).message}`, 8000);
    }
  }

  private async buildSystem(
    skill: Skill | null
  ): Promise<{ system: string; skipped: string[]; missing: string[] }> {
    if (!skill) return { system: SYSTEM_BASE, skipped: [], missing: [] };

    const { refs, skipped, missing } = await resolveSkillRefs(skill, this.settings.refBudgetChars);

    const parts = [
      SYSTEM_BASE,
      "",
      `## Active skill: ${skill.name}`,
      skill.description ? `(${skill.description})` : "",
      `Skill folder: ${skill.displayPath}`,
      "",
      skill.body,
    ];

    if (refs.length) {
      parts.push(
        "",
        "## Reference files",
        "Files referenced by this skill are reproduced in full below. You have no file",
        "access — do not ask for other files, and do not mention these paths in your output."
      );
      for (const ref of refs) {
        parts.push("", `### ${ref.name}  (${ref.path})`, "", ref.body);
      }
    }

    return { system: parts.join("\n"), skipped, missing };
  }

  private buildUser(selection: string, instruction: string, skill: Skill | null): string {
    const task =
      instruction ||
      (skill ? `Apply the "${skill.name}" skill to the passage.` : "Improve the passage.");
    return [`Task: ${task}`, "", "Passage:", "<<<", selection, ">>>"].join("\n");
  }

  private showResult(
    editor: Editor,
    original: string,
    choice: { skill: Skill | null; instruction: string },
    first: { text: string; meta: ResultMeta },
    onRerun: (temperature: number) => Promise<{ text: string; meta: ResultMeta }>
  ): void {
    const title = choice.skill ? `Result — ${choice.skill.name}` : "Result";
    new ResultModal(this.app, {
      title,
      original,
      first,
      onRerun,
      onAction: async (action, text) => {
        switch (action) {
          case "replace":
            editor.replaceSelection(text);
            break;
          case "insert": {
            const to = editor.getCursor("to");
            editor.replaceRange(`\n\n${text}`, {
              line: to.line,
              ch: editor.getLine(to.line).length,
            });
            break;
          }
          case "copy":
            await navigator.clipboard.writeText(text);
            new Notice("Copied.");
            break;
          case "dismiss":
            break;
        }
      },
    }).open();
  }

  private pickAndImportZip(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const { written, rejected } = await importSkillsZip(
          this.app,
          this.settings.skillsFolder,
          buf
        );
        const msg = `Imported ${written} file(s) into "${this.settings.skillsFolder}".`;
        if (rejected.length) {
          // Named, not just counted: a zip that tries to write outside the skills
          // folder is worth seeing rather than quietly importing minus a few files.
          new Notice(
            `${msg}\nRefused ${rejected.length} entr(y/ies) pointing outside it: ${rejected.join(", ")}`,
            15000
          );
        } else {
          new Notice(msg);
        }
      } catch (e) {
        new Notice(`Zip import failed: ${(e as Error).message}`, 8000);
      }
    };
    input.click();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // deep-merge provider blocks so new fields get defaults
    this.settings.ollama = Object.assign({}, DEFAULT_SETTINGS.ollama, this.settings.ollama);
    this.settings.openai = Object.assign({}, DEFAULT_SETTINGS.openai, this.settings.openai);
    this.settings.anthropic = Object.assign({}, DEFAULT_SETTINGS.anthropic, this.settings.anthropic);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
