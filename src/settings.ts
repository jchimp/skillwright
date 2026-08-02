import { App, PluginSettingTab, Setting } from "obsidian";
import type SkillwrightPlugin from "./main";
import type { ProviderId } from "./providers";

export interface SkillwrightSettings {
  defaultProvider: ProviderId;
  skillsFolder: string;
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
  skillsFolder: "_skills",
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
      .setName("Skills folder")
      .setDesc("Vault folder containing Claude Code-style skills (subfolders with SKILL.md).")
      .addText((t) =>
        t.setValue(s.skillsFolder).onChange(async (v) => {
          s.skillsFolder = v.trim() || "_skills";
          await this.plugin.saveSettings();
        })
      );

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
  }
}
