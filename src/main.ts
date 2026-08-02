import { Editor, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import { chat, ProviderId } from "./providers";
import { importSkillsZip, loadSkills, resolveSkillRefs, Skill } from "./skills";
import { skillSlug } from "./skillref";
import { resolveStores } from "./store";
import { ResultModal, RewriteModal, type ResultMeta } from "./modals";
import { DEFAULT_SETTINGS, SkillwrightSettings, SkillwrightSettingTab } from "./settings";

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

  private async startRewrite(editor: Editor): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice("Select some text first.");
      return;
    }

    const { skills } = await this.getSkills();
    const s = this.settings;
    const defaults = {
      provider: s.defaultProvider,
      models: {
        ollama: s.ollama.model,
        openai: s.openai.model,
        anthropic: s.anthropic.model,
      },
    };

    new RewriteModal(this.app, skills, defaults, async (choice) => {
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
          skipped.length
            ? `${skipped.length} reference(s) over budget (${skipped.join(", ")})`
            : "",
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
    }).open();
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
        const n = await importSkillsZip(this.app, this.settings.skillsFolder, buf);
        new Notice(`Imported ${n} file(s) into "${this.settings.skillsFolder}".`);
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
