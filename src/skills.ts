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
  /** Vault path to the SKILL.md file itself */
  filePath: string;
}

/** A reference file pulled in because the skill body points at it. */
export interface SkillRef {
  /** Vault path */
  path: string;
  /** Path relative to the skill folder, as the body would write it */
  name: string;
  /** File contents */
  body: string;
}

export interface ResolvedRefs {
  refs: SkillRef[];
  /** Names of files dropped because the budget was exhausted */
  skipped: string[];
  /** Reference targets that didn't resolve to a file inside the skills folder */
  missing: string[];
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

  return { name, description, body: body.trim(), folder, filePath: file.path };
}

/**
 * Markdown links `[text](target)`, wikilinks `[[target]]` / `[[target|alias]]`, and bare
 * or backticked `some-file.md` mentions. Imported Claude Code skills often just write
 * "read reference.md" with no link syntax at all, so the bare form has to count.
 */
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;
const BARE_FILE_RE = /(?<![\w/([.:-])[\w][\w.\-/]*\.md\b/g;

/** How many hops out from SKILL.md we follow; refs-of-refs, then stop. */
const MAX_DEPTH = 2;

function extractTargets(body: string): string[] {
  const out: string[] = [];
  for (const re of [MD_LINK_RE, WIKILINK_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(body); m; m = re.exec(body)) out.push(m[1]);
  }
  BARE_FILE_RE.lastIndex = 0;
  for (let m = BARE_FILE_RE.exec(body); m; m = BARE_FILE_RE.exec(body)) out.push(m[0]);
  return out;
}

/**
 * `ignore` — not a local markdown reference at all (a URL, an anchor, an image); silent.
 * `reject` — looks like a local reference but lands outside the skills folder; reported,
 * because a link that silently does nothing is worth telling the user about.
 */
type TargetResult = { kind: "ignore" } | { kind: "reject" } | { kind: "path"; path: string };

const IGNORE: TargetResult = { kind: "ignore" };
const REJECT: TargetResult = { kind: "reject" };

/**
 * Turns a raw link target into a vault path. The containment check is what keeps a
 * `../../../secrets.md` from being read out of the vault and shipped to a provider.
 */
function resolveTarget(target: string, fromFolder: string, skillsFolder: string): TargetResult {
  let t = target.trim();
  if (!t || t.startsWith("#")) return IGNORE;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) return IGNORE; // http:, mailto:, …

  t = t.split("#")[0].split("?")[0];
  try {
    t = decodeURIComponent(t);
  } catch {
    /* not percent-encoded: use as-is */
  }
  if (!t) return IGNORE;
  if (!t.toLowerCase().endsWith(".md")) {
    if (/\.[a-z0-9]+$/i.test(t)) return IGNORE; // some other file type
    t = `${t}.md`; // extensionless wikilink
  }

  const base = t.startsWith("/") ? t.slice(1) : `${fromFolder}/${t}`;
  const parts: string[] = [];
  for (const part of normalizePath(base).split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (parts.length === 0) return REJECT;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const path = parts.join("/");

  const root = normalizePath(skillsFolder).replace(/\/+$/, "");
  if (path !== root && !path.startsWith(`${root}/`)) return REJECT;
  return { kind: "path", path };
}

/**
 * Reads the files a skill's body points at so they can be inlined into the prompt.
 * The providers here are plain chat completions with no tool loop, so anything the
 * model needs has to be in the message; there is no "go open that file" fallback.
 */
export async function resolveSkillRefs(
  app: App,
  skill: Skill,
  skillsFolder: string,
  budgetChars: number
): Promise<ResolvedRefs> {
  const refs: SkillRef[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  const skillPath = normalizePath(skill.filePath);
  const visited = new Set<string>([skillPath]);
  const seenMissing = new Set<string>();
  let queue = [{ body: skill.body, folder: skill.folder }];
  let used = 0;

  const reportMissing = (target: string): void => {
    if (seenMissing.has(target)) return;
    seenMissing.add(target);
    missing.push(target);
  };

  for (let depth = 0; depth < MAX_DEPTH && queue.length > 0; depth++) {
    const next: { body: string; folder: string }[] = [];

    for (const node of queue) {
      for (const target of extractTargets(node.body)) {
        const result = resolveTarget(target, node.folder, skillsFolder);
        if (result.kind === "ignore") continue;
        if (result.kind === "reject") {
          reportMissing(target);
          continue;
        }

        const path = result.path;
        if (visited.has(path)) continue;
        visited.add(path);

        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          reportMissing(target);
          continue;
        }

        const body = (await app.vault.cachedRead(file)).trim();
        const name = relativeName(path, skill.folder);
        if (used + body.length > budgetChars) {
          skipped.push(name);
          continue; // skip whole files, never truncate mid-rule
        }
        used += body.length;

        refs.push({ path, name, body });
        next.push({ body, folder: file.parent?.path ?? node.folder });
      }
    }

    queue = next;
  }

  return { refs, skipped, missing };
}

function relativeName(path: string, folder: string): string {
  const f = normalizePath(folder).replace(/\/+$/, "");
  return path.startsWith(`${f}/`) ? path.slice(f.length + 1) : path;
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
