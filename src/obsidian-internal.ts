/**
 * Minimal typings and guarded accessors for the Obsidian internals used to surface
 * hotkey configuration. None of this is public API — it can disappear between
 * releases, so every accessor feature-detects and returns null instead of throwing.
 */
import { App, Platform } from "obsidian";

export interface Hotkey {
  /** e.g. ["Mod", "Shift"] — "Mod" is Ctrl on Windows/Linux, Cmd on macOS */
  modifiers: string[];
  key: string;
}

export interface CommandRef {
  id: string;
  name: string;
}

interface HotkeyManager {
  /** User-assigned overrides, if any */
  getHotkeys(commandId: string): Hotkey[] | undefined;
  /** Defaults declared by the command itself */
  getDefaultHotkeys(commandId: string): Hotkey[] | undefined;
}

interface HotkeysTab {
  setQuery?(query: string): void;
}

interface SettingManager {
  openTabById(id: string): HotkeysTab | null;
}

interface CommandManager {
  listCommands(): CommandRef[];
}

/** Shape we hope `app` has. Every field optional — presence is checked at runtime. */
interface InternalApp {
  hotkeyManager?: Partial<HotkeyManager>;
  setting?: Partial<SettingManager>;
  commands?: Partial<CommandManager>;
}

function internals(app: App): InternalApp {
  return app as unknown as InternalApp;
}

/**
 * @param app Obsidian app instance.
 * @returns The hotkey manager, or null if the internal API is missing/changed.
 */
export function getHotkeyManager(app: App): HotkeyManager | null {
  const m = internals(app).hotkeyManager;
  if (!m || typeof m.getHotkeys !== "function" || typeof m.getDefaultHotkeys !== "function") {
    return null;
  }
  return m as HotkeyManager;
}

/**
 * @param app Obsidian app instance.
 * @returns The settings-window manager, or null if the internal API is missing/changed.
 */
export function getSettingManager(app: App): SettingManager | null {
  const m = internals(app).setting;
  if (!m || typeof m.openTabById !== "function") return null;
  return m as SettingManager;
}

/**
 * @param app Obsidian app instance.
 * @returns The command registry, or null if the internal API is missing/changed.
 */
export function getCommandManager(app: App): CommandManager | null {
  const m = internals(app).commands;
  if (!m || typeof m.listCommands !== "function") return null;
  return m as CommandManager;
}

/**
 * Every command this plugin registered, discovered rather than hardcoded.
 *
 * @param app Obsidian app instance.
 * @param manifestId The plugin's manifest id; commands are namespaced `<id>:<command>`.
 * @returns Matching commands, or an empty array if the registry is unavailable.
 */
export function pluginCommands(app: App, manifestId: string): CommandRef[] {
  const cmds = getCommandManager(app);
  if (!cmds) return [];
  const prefix = `${manifestId}:`;
  return cmds.listCommands().filter((c) => c.id.startsWith(prefix));
}

const MAC_GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Meta: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};

const PC_NAMES: Record<string, string> = {
  Mod: "Ctrl",
  Meta: "Win",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
};

/**
 * Render a hotkey for display, using platform-appropriate modifier names.
 *
 * @param hk The hotkey to format.
 * @returns e.g. "Ctrl + Shift + K" on Windows/Linux, "⌘⇧K" on macOS.
 */
export function formatHotkey(hk: Hotkey): string {
  const key = hk.key.length === 1 ? hk.key.toUpperCase() : hk.key;
  if (Platform.isMacOS) {
    return hk.modifiers.map((m) => MAC_GLYPHS[m] ?? m).join("") + key;
  }
  return [...hk.modifiers.map((m) => PC_NAMES[m] ?? m), key].join(" + ");
}
