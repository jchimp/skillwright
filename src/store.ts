import { App, Platform, TFile, TFolder, normalizePath } from "obsidian";
import type { SkillwrightSettings } from "./settings";

/** One directory entry, as the loader cares about it. */
export interface StoreEntry {
  name: string;
  isDir: boolean;
}

/**
 * A rooted, read-only source of skills. Every path handed to a store is relative
 * to its root and "/"-separated; the store is what keeps reads from escaping.
 */
export interface SkillStore {
  /** Stable origin id, e.g. `vault:_skills` or `fs:C:/Users/x/.claude/skills` */
  id: string;
  /** Display label — what the user sees in notices and the system prompt */
  label: string;
  /** Entries of a directory. Empty array for anything unreadable or missing. */
  list(dir: string): Promise<StoreEntry[]>;
  /** File contents. Rejects if the path isn't a readable file inside the root. */
  read(path: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
}

/** Joins a store-relative path onto a root, both "/"-separated. */
function join(root: string, rel: string): string {
  const r = rel.replace(/^\/+/, "");
  if (!r) return root;
  return root ? `${root}/${r}` : r;
}

/** Skills that live in the vault — editable in Obsidian, synced with the vault. */
export class VaultStore implements SkillStore {
  readonly id: string;
  readonly label: string;
  private root: string;

  constructor(private app: App, skillsFolder: string) {
    this.root = normalizePath(skillsFolder).replace(/\/+$/, "");
    this.id = `vault:${this.root}`;
    this.label = this.root;
  }

  async list(dir: string): Promise<StoreEntry[]> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(join(this.root, dir)));
    if (!(folder instanceof TFolder)) return [];
    return folder.children.map((c) => ({ name: c.name, isDir: c instanceof TFolder }));
  }

  async read(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(join(this.root, path)));
    if (!(file instanceof TFile)) throw new Error(`Not a file: ${path}`);
    return this.app.vault.cachedRead(file);
  }

  async isFile(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(join(this.root, path)));
    return file instanceof TFile;
  }
}

/**
 * Skills read in place from a folder on disk — `~/.claude/skills` and friends.
 * Desktop only; `fs` doesn't exist on mobile, so construction is gated on
 * {@link Platform.isDesktopApp} by {@link resolveStores}.
 */
export class NodeStore implements SkillStore {
  readonly id: string;
  readonly label: string;
  /** Symlinks are resolved once here; every read is checked against it. */
  private realRoot: string | null = null;

  /**
   * @param root Absolute path to the skills directory.
   * @param label Display label, usually the `~`-shortened form of `root`.
   */
  constructor(private root: string, label?: string) {
    this.id = `fs:${root}`;
    this.label = label ?? root;
  }

  async list(dir: string): Promise<StoreEntry[]> {
    const target = await this.safePath(dir);
    if (!target) return [];
    try {
      const entries = await fsp().readdir(target, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return []; // missing, permission-denied, or not a directory
    }
  }

  async read(path: string): Promise<string> {
    const target = await this.safePath(path);
    if (!target) throw new Error(`Outside skill folder: ${path}`);
    return fsp().readFile(target, "utf8");
  }

  async isFile(path: string): Promise<boolean> {
    const target = await this.safePath(path);
    if (!target) return false;
    try {
      return (await fsp().stat(target)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Resolves a store-relative path to a real absolute path, or null if it lands
   * outside the root. A symlink inside the skill folder pointing at, say,
   * `~/.ssh` would otherwise get inlined into a prompt and shipped to a provider.
   *
   * @param rel Store-relative path.
   * @returns Absolute path, or null when it escapes the root or can't be resolved.
   */
  private async safePath(rel: string): Promise<string | null> {
    const { resolve, sep } = nodePath();
    if (this.realRoot === null) {
      try {
        this.realRoot = await fsp().realpath(this.root);
      } catch {
        this.realRoot = resolve(this.root); // root itself may not exist yet
      }
    }

    const candidate = resolve(this.realRoot, ...rel.split("/").filter((p) => p && p !== "."));
    let real = candidate;
    try {
      real = await fsp().realpath(candidate);
    } catch {
      /* doesn't exist: the lexical path is enough to reject an escape */
    }
    if (real !== this.realRoot && !real.startsWith(this.realRoot + sep)) return null;
    return real;
  }
}

/** Agent skill directories probed under the home folder when auto-detect is on. */
const AGENT_SKILL_DIRS = [".claude/skills", ".codex/skills"];

/**
 * Builds the ordered list of skill sources. Earlier stores win name collisions,
 * so the vault always shadows a same-named skill on disk.
 *
 * @param app Obsidian app, for the vault store.
 * @param settings Plugin settings.
 * @returns Vault store first, then auto-detected agent folders, then user paths.
 */
export async function resolveStores(
  app: App,
  settings: SkillwrightSettings
): Promise<SkillStore[]> {
  const stores: SkillStore[] = [new VaultStore(app, settings.skillsFolder)];
  if (!Platform.isDesktopApp) return stores;

  const home = os().homedir();
  const seen = new Set<string>();
  const add = async (abs: string, label: string): Promise<void> => {
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!(await isDir(abs))) return;
    stores.push(new NodeStore(abs, label));
  };

  if (settings.includeAgentSkillFolders) {
    for (const rel of AGENT_SKILL_DIRS) {
      await add(nodePath().resolve(home, rel), `~/${rel}`);
    }
  }

  for (const line of settings.extraSkillFolders.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    await add(expandHome(raw, home), raw);
  }

  return stores;
}

/** Expands a leading `~` and makes the path absolute. */
function expandHome(p: string, home: string): string {
  const path = nodePath();
  const t = p.replace(/^~(?=[/\\]|$)/, home);
  return path.resolve(t);
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fsp().stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

// Node builtins are marked external in esbuild.config.mjs, so these `require`
// calls survive the bundle. They stay lazy so the mobile build never runs them.

type FsPromises = typeof import("fs").promises;
type NodePath = typeof import("path");
type NodeOs = typeof import("os");

function fsp(): FsPromises {
  return (require("fs") as typeof import("fs")).promises;
}

function nodePath(): NodePath {
  return require("path") as NodePath;
}

function os(): NodeOs {
  return require("os") as NodeOs;
}
