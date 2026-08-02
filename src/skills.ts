import { App, Notice, TFile, TFolder, normalizePath, parseYaml } from "obsidian";
import JSZip from "jszip";

export interface Skill {
  /** Frontmatter `name`, falls back to folder name */
  name: string;
  /** Frontmatter `description` */
  description: string;
  /** SKILL.md body (frontmatter stripped) */
  body: string;
  /** Vault path to the skill folder */
  folder: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Loads skills in Claude Code layout:
 *
 *   <skillsFolder>/
 *     my-skill/
 *       SKILL.md        <- frontmatter: name, description; body = instructions
 *       ref-whatever.md <- referenced files stay on disk; body can point to them
 *     another-skill/
 *       SKILL.md
 *
 * A bare `<skillsFolder>/loose-skill.md` is also accepted for quick one-offs.
 */
export async function loadSkills(app: App, skillsFolder: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const root = app.vault.getAbstractFileByPath(normalizePath(skillsFolder));
  if (!(root instanceof TFolder)) return skills;

  for (const child of root.children) {
    if (child instanceof TFolder) {
      const skillFile = child.children.find(
        (f): f is TFile => f instanceof TFile && f.name.toLowerCase() === "skill.md"
      );
      if (skillFile) {
        skills.push(await parseSkill(app, skillFile, child.name, child.path));
      }
    } else if (child instanceof TFile && child.extension === "md") {
      skills.push(await parseSkill(app, child, child.basename, root.path));
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

async function parseSkill(
  app: App,
  file: TFile,
  fallbackName: string,
  folder: string
): Promise<Skill> {
  const raw = await app.vault.cachedRead(file);
  let name = fallbackName;
  let description = "";
  let body = raw;

  const m = raw.match(FRONTMATTER_RE);
  if (m) {
    body = raw.slice(m[0].length);
    try {
      const fm = parseYaml(m[1]) ?? {};
      if (typeof fm.name === "string") name = fm.name;
      if (typeof fm.description === "string") description = fm.description;
    } catch {
      /* malformed frontmatter: keep fallbacks */
    }
  }

  return { name, description, body: body.trim(), folder };
}

/**
 * Unpacks a skills zip into the skills folder. Accepts either:
 *   skills.zip -> my-skill/SKILL.md            (skills at zip root)
 *   skills.zip -> skills/my-skill/SKILL.md     (one wrapping dir, auto-stripped)
 */
export async function importSkillsZip(
  app: App,
  skillsFolder: string,
  data: ArrayBuffer
): Promise<number> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length === 0) {
    new Notice("Zip is empty.");
    return 0;
  }

  // Detect a single wrapping directory and strip it.
  const tops = new Set(entries.map((e) => e.name.split("/")[0]));
  const strip =
    tops.size === 1 && entries.every((e) => e.name.includes("/"))
      ? `${[...tops][0]}/`
      : "";

  await ensureFolder(app, skillsFolder);

  let written = 0;
  for (const entry of entries) {
    const rel = entry.name.startsWith(strip) ? entry.name.slice(strip.length) : entry.name;
    if (!rel || rel.startsWith("__MACOSX") || rel.endsWith(".DS_Store")) continue;

    const dest = normalizePath(`${skillsFolder}/${rel}`);
    const destDir = dest.substring(0, dest.lastIndexOf("/"));
    if (destDir) await ensureFolder(app, destDir);

    const content = await entry.async("arraybuffer");
    const existing = app.vault.getAbstractFileByPath(dest);
    if (existing instanceof TFile) {
      await app.vault.modifyBinary(existing, content);
    } else {
      await app.vault.createBinary(dest, content);
    }
    written++;
  }
  return written;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  if (app.vault.getAbstractFileByPath(p)) return;
  const parts = p.split("/");
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        /* race with another create: fine */
      }
    }
  }
}
