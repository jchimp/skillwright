import { App, PluginSettingTab, Setting } from "obsidian";
import type SkillwrightPlugin from "./main";
import type { ProviderId } from "./providers";
import {
  formatHotkey,
  getHotkeyManager,
  getSettingManager,
  pluginCommands,
} from "./obsidian-internal";

/** Which UI the rewrite command opens to collect an instruction. */
export type PromptUi = "inline" | "modal";

export interface SkillwrightSettings {
  defaultProvider: ProviderId;
  /** `inline` = compact bar pinned to the selection; `modal` = the full dialog */
  promptUi: PromptUi;
  skillsFolder: string;
  /** Auto-detect `~/.claude/skills` and `~/.codex/skills` (desktop only) */
  includeAgentSkillFolders: boolean;
  /** Extra skill folders, one absolute path per line; `~` and `#` comments allowed */
  extraSkillFolders: string;
  temperature: number;
  maxTokens: number;
  /** Char cap on skill reference files inlined into the system prompt */
  refBudgetChars: number;
  ollama: { baseUrl: string; model: string };
  openai: { baseUrl: string; apiKey: string; model: string };
  anthropic: { baseUrl: string; apiKey: string; model: string };
}

export const DEFAULT_SETTINGS: SkillwrightSettings = {
  defaultProvider: "ollama",
  promptUi: "inline",
  skillsFolder: "_skills",
  includeAgentSkillFolders: true,
  extraSkillFolders: "",
  temperature: 0.7,
  maxTokens: 2048,
  refBudgetChars: 40000,
  ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
  openai: { baseUrl: "https://api.openai.com", apiKey: "", model: "gpt-4o-mini" },
  anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "", model: "claude-sonnet-4-6" },
};

export class SkillwrightSettingTab extends PluginSettingTab {
  plugin: SkillwrightPlugin;

  constructor(app: App, plugin: SkillwrightPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default provider")
      .addDropdown((dd) => {
        dd.addOption("ollama", "Ollama");
        dd.addOption("openai", "OpenAI");
        dd.addOption("anthropic", "Anthropic");
        dd.setValue(s.defaultProvider);
        dd.onChange(async (v) => {
          s.defaultProvider = v as ProviderId;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Prompt style")
      .setDesc(
        'How "Rewrite selection…" asks for an instruction. "Rewrite selection (all options)…" ' +
          "always opens the dialog."
      )
      .addDropdown((dd) => {
        dd.addOption("inline", "Inline bar (compact, at the selection)");
        dd.addOption("modal", "Dialog (all options)");
        dd.setValue(s.promptUi);
        dd.onChange(async (v) => {
          s.promptUi = v as PromptUi;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Skill sources" });

    new Setting(containerEl)
      .setName("Skills folder")
      .setDesc(
        "Vault folder containing Claude Code-style skills (subfolders with SKILL.md). " +
          'Skills here shadow same-named skills from the folders below, and "Import skills ' +
          'from zip…" writes here — but skills you already have on disk need no import.'
      )
      .addText((t) =>
        t.setValue(s.skillsFolder).onChange(async (v) => {
          s.skillsFolder = v.trim() || "_skills";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Include agent skill folders")
      .setDesc(
        "Read ~/.claude/skills and ~/.codex/skills in place, no import needed. Desktop only."
      )
      .addToggle((t) =>
        t.setValue(s.includeAgentSkillFolders).onChange(async (v) => {
          s.includeAgentSkillFolders = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Extra skill folders")
      .setDesc(
        "One folder per line, read in place. Absolute paths, `~` allowed; lines starting " +
          "with # are ignored. Desktop only."
      )
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setPlaceholder("~/my-skills\nD:\\shared\\skills");
        t.setValue(s.extraSkillFolders).onChange(async (v) => {
          s.extraSkillFolders = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Reference budget (characters)")
      .setDesc(
        "Cap on the reference files a skill pulls into the prompt. Files past the cap are skipped, with a notice."
      )
      .addText((t) =>
        t.setValue(String(s.refBudgetChars)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n > 0) s.refBudgetChars = n;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Generation" });

    new Setting(containerEl)
      .setName("Temperature")
      .addText((t) =>
        t.setValue(String(s.temperature)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isNaN(n)) s.temperature = Math.min(2, Math.max(0, n));
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max output tokens")
      .addText((t) =>
        t.setValue(String(s.maxTokens)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n > 0) s.maxTokens = n;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Ollama" });
    new Setting(containerEl).setName("Base URL").addText((t) =>
      t.setValue(s.ollama.baseUrl).onChange(async (v) => {
        s.ollama.baseUrl = v.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Model").addText((t) =>
      t.setValue(s.ollama.model).onChange(async (v) => {
        s.ollama.model = v.trim();
        await this.plugin.saveSettings();
      })
    );

    containerEl.createEl("h3", { text: "OpenAI" });
    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored in plain text in this vault's plugin data. Don't sync it anywhere you don't trust.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.openai.apiKey).onChange(async (v) => {
          s.openai.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("Base URL").addText((t) =>
      t.setValue(s.openai.baseUrl).onChange(async (v) => {
        s.openai.baseUrl = v.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Model").addText((t) =>
      t.setValue(s.openai.model).onChange(async (v) => {
        s.openai.model = v.trim();
        await this.plugin.saveSettings();
      })
    );

    containerEl.createEl("h3", { text: "Anthropic" });
    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored in plain text in this vault's plugin data.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.anthropic.apiKey).onChange(async (v) => {
          s.anthropic.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("Base URL").addText((t) =>
      t.setValue(s.anthropic.baseUrl).onChange(async (v) => {
        s.anthropic.baseUrl = v.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Model").addText((t) =>
      t.setValue(s.anthropic.model).onChange(async (v) => {
        s.anthropic.model = v.trim();
        await this.plugin.saveSettings();
      })
    );

    this.renderHotkeys(containerEl);
  }

  /**
   * List this plugin's commands with their current bindings. Bindings live in
   * Obsidian's own config, so nothing here is persisted to plugin settings —
   * the buttons just shortcut to the Hotkeys pane.
   *
   * @param containerEl Element to append the section to.
   */
  private renderHotkeys(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Hotkeys" });

    const cmds = pluginCommands(this.app, this.plugin.manifest.id);
    const hotkeys = getHotkeyManager(this.app);

    if (!cmds.length || !hotkeys) {
      this.addHotkeyPaneButton(
        new Setting(containerEl).setDesc(
          'Assign keys under Settings → Hotkeys, searching for "Skillwright".'
        )
      );
      return;
    }

    for (const cmd of cmds) {
      const custom = hotkeys.getHotkeys(cmd.id);
      const bound = custom?.length ? custom : hotkeys.getDefaultHotkeys(cmd.id);
      const isDefault = !custom?.length && !!bound?.length;

      const desc = bound?.length
        ? bound.map(formatHotkey).join(", ") + (isDefault ? " (default)" : "")
        : "Not set";

      this.addHotkeyPaneButton(
        new Setting(containerEl).setName(stripPluginPrefix(cmd.name)).setDesc(desc)
      );
    }
  }

  /** Adds the button that jumps to Obsidian's Hotkeys pane, pre-filtered to this plugin. */
  private addHotkeyPaneButton(setting: Setting): void {
    const settingMgr = getSettingManager(this.app);
    if (!settingMgr) return;
    setting.addButton((b) =>
      b.setButtonText("Set hotkey").onClick(() => {
        const tab = settingMgr.openTabById("hotkeys");
        // setQuery is internal and may not exist; the pane still opens without it.
        tab?.setQuery?.("skillwright");
      })
    );
  }
}

/** Obsidian prefixes command names with the plugin name; drop it for an in-plugin list. */
function stripPluginPrefix(name: string): string {
  const sep = name.indexOf(": ");
  return sep === -1 ? name : name.slice(sep + 2);
}
