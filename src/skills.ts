import { App, Notice, TFile, normalizePath, parseYaml } from "obsidian";
import JSZip from "jszip";
import type { SkillStore } from "./store";

export interface Skill {
  /** Frontmatter `name`, falls back to folder name */
  name: string;
  /** Frontmatter `description` */
  description: string;
  /** SKILL.md body (frontmatter stripped) */
  body: string;
  /** Where this skill was read from */
  store: SkillStore;
  /** Store-relative path to the skill folder ("" for a loose skill at the root) */
  folder: string;
  /** Store-relative path to the SKILL.md file itself */
  filePath: string;
  /** Human-readable location, e.g. `~/.claude/skills/humanizer` */
  displayPath: string;
}

/** A reference file pulled in because the skill body points at it. */
export interface SkillRef {
  /** Store-relative path */
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
  /** Reference targets that didn't resolve to a file inside the skill's store */
  missing: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Joins store-relative path segments, tolerating an empty parent. */
function joinRel(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/**
 * Loads skills in Claude Code layout from one store:
 *
 *   <store root>/
 *     my-skill/
 *       SKILL.md        <- frontmatter: name, description; body = instructions
 *       ref-whatever.md <- referenced files stay on disk; body can point to them
 *     another-skill/
 *       SKILL.md
 *
 * A bare `<store root>/loose-skill.md` is also accepted for quick one-offs.
 *
 * @param store Source to read from (vault folder or an external directory).
 * @returns Skills sorted by name; empty if the root isn't readable.
 */
export async function loadSkills(store: SkillStore): Promise<Skill[]> {
  const skills: Skill[] = [];

  for (const child of await store.list("")) {
    if (child.isDir) {
      const inner = await store.list(child.name);
      const skillFile = inner.find((f) => !f.isDir && f.name.toLowerCase() === "skill.md");
      if (skillFile) {
        skills.push(
          await parseSkill(store, joinRel(child.name, skillFile.name), child.name, child.name)
        );
      }
    } else if (child.name.toLowerCase().endsWith(".md")) {
      const base = child.name.slice(0, -3);
      skills.push(await parseSkill(store, child.name, base, ""));
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

async function parseSkill(
  store: SkillStore,
  filePath: string,
  fallbackName: string,
  folder: string
): Promise<Skill> {
  const raw = await store.read(filePath);
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

  return {
    name,
    description,
    body: body.trim(),
    store,
    folder,
    filePath,
    displayPath: folder ? `${store.label}/${folder}` : store.label,
  };
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
 * `reject` — looks like a local reference but lands outside the store root; reported,
 * because a link that silently does nothing is worth telling the user about.
 */
type TargetResult = { kind: "ignore" } | { kind: "reject" } | { kind: "path"; path: string };

const IGNORE: TargetResult = { kind: "ignore" };
const REJECT: TargetResult = { kind: "reject" };

/**
 * Turns a raw link target into a store-relative path. Walking off the top of the
 * path is what a `../../../secrets.md` looks like, and it's rejected here — the
 * store enforces the same boundary again on the actual read.
 *
 * @param target Raw link target from a skill body.
 * @param fromFolder Store-relative folder of the file the link was found in.
 */
function resolveTarget(target: string, fromFolder: string): TargetResult {
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

  const base = t.startsWith("/") ? t.slice(1) : joinRel(fromFolder, t);
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
  if (parts.length === 0) return REJECT;
  return { kind: "path", path: parts.join("/") };
}

/**
 * Reads the files a skill's body points at so they can be inlined into the prompt.
 * The providers here are plain chat completions with no tool loop, so anything the
 * model needs has to be in the message; there is no "go open that file" fallback.
 *
 * @param skill Skill whose references to resolve; its own store is used for reads.
 * @param budgetChars Cap on total reference characters.
 */
export async function resolveSkillRefs(
  skill: Skill,
  budgetChars: number
): Promise<ResolvedRefs> {
  const store = skill.store;
  const refs: SkillRef[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  const visited = new Set<string>([skill.filePath]);
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
        const result = resolveTarget(target, node.folder);
        if (result.kind === "ignore") continue;
        if (result.kind === "reject") {
          reportMissing(target);
          continue;
        }

        let path = result.path;
        // A skill reads its own folder. Climbing into a sibling (`../other/SKILL.md`)
        // or addressing the store root (`/other/notes.md`) stays inside the store, so
        // resolveTarget allows it — but it's how a skill you didn't write would inline
        // its neighbours into a prompt bound for a provider. Reported rather than
        // dropped, so a legitimate cross-skill link says so instead of going quiet.
        // Loose root-level skills have no folder of their own and keep store scope.
        if (skill.folder && !path.startsWith(`${skill.folder}/`)) {
          reportMissing(target);
          continue;
        }
        if (visited.has(path)) continue;
        visited.add(path);

        let found = await store.isFile(path);

        // A bare prose mention ("see BRAND.md") carries no path, so it lands next to
        // SKILL.md even when the real file sits in references/. Search the skill folder
        // by basename before calling it missing.
        if (!found && !target.includes("/")) {
          const hit = await findByBasename(store, skill.folder, path.split("/").pop() ?? "");
          if (hit) {
            if (visited.has(hit)) continue;
            visited.add(hit);
            path = hit;
            found = true;
          }
        }

        if (!found) {
          reportMissing(target);
          continue;
        }

        const body = (await store.read(path)).trim();
        const name = relativeName(path, skill.folder);
        if (used + body.length > budgetChars) {
          skipped.push(name);
          continue; // skip whole files, never truncate mid-rule
        }
        used += body.length;

        refs.push({ path, name, body });
        next.push({ body, folder: parentFolder(path) });
      }
    }

    queue = next;
  }

  return { refs, skipped, missing };
}

/**
 * Breadth-first search of a skill folder for a file with the given name.
 *
 * @returns Store-relative path of the first case-insensitive match, or null.
 */
async function findByBasename(
  store: SkillStore,
  skillFolder: string,
  basename: string
): Promise<string | null> {
  if (!basename) return null;

  const want = basename.toLowerCase();
  const queue: string[] = [skillFolder];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    for (const child of await store.list(dir)) {
      const path = joinRel(dir, child.name);
      if (child.isDir) queue.push(path);
      else if (child.name.toLowerCase() === want) return path;
    }
  }
  return null;
}

function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function relativeName(path: string, folder: string): string {
  return folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

/** What an import did: files written, plus entries refused for landing outside the folder. */
export interface ImportResult {
  written: number;
  /** Entry names rejected by the containment check, so a hostile zip is visible. */
  rejected: string[];
}

/**
 * Unpacks a skills zip into the vault's skills folder. Accepts either:
 *   skills.zip -> my-skill/SKILL.md            (skills at zip root)
 *   skills.zip -> skills/my-skill/SKILL.md     (one wrapping dir, auto-stripped)
 *
 * Writes through the vault directly — external skill folders are read-only.
 *
 * Entry names come from the zip, so they're whatever whoever built it chose. Every
 * destination is checked back against the skills folder before anything is created;
 * see {@link containedIn}.
 */
export async function importSkillsZip(
  app: App,
  skillsFolder: string,
  data: ArrayBuffer
): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length === 0) {
    new Notice("Zip is empty.");
    return { written: 0, rejected: [] };
  }

  // Detect a single wrapping directory and strip it — unless that directory is itself
  // a skill (holds SKILL.md), which is what a single-skill zip looks like. Stripping
  // there would flatten the skill into the skills folder root.
  const tops = new Set(entries.map((e) => e.name.split("/")[0]));
  const top = [...tops][0];
  const topIsSkill = entries.some((e) => e.name.toLowerCase() === `${top.toLowerCase()}/skill.md`);
  const strip =
    tops.size === 1 && !topIsSkill && entries.every((e) => e.name.includes("/"))
      ? `${top}/`
      : "";

  const root = normalizePath(skillsFolder);
  await ensureFolder(app, root);

  let written = 0;
  const rejected: string[] = [];
  for (const entry of entries) {
    const rel = entry.name.startsWith(strip) ? entry.name.slice(strip.length) : entry.name;
    if (!rel || rel.startsWith("__MACOSX") || rel.endsWith(".DS_Store")) continue;

    // Some zip tools prefix every entry with "./"; normalizePath leaves the segment
    // alone, and it would otherwise become a folder literally named ".".
    const dest = dropCurrentDirSegments(normalizePath(`${root}/${rel}`));
    if (!containedIn(root, dest)) {
      rejected.push(entry.name);
      continue;
    }

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
  return { written, rejected };
}

/** Drops no-op `.` segments a normalized path may still carry. */
function dropCurrentDirSegments(path: string): string {
  return path
    .split("/")
    .filter((seg) => seg !== ".")
    .join("/");
}

/**
 * Whether a destination stays under the skills folder.
 *
 * `normalizePath` tidies separators but leaves `..` segments alone, so a zip entry
 * named `../.obsidian/plugins/<id>/main.js` would otherwise resolve out of the
 * skills folder and overwrite plugin code Obsidian executes on the next load. The
 * check is on the final path rather than a `..` blacklist, so it holds however the
 * entry name is spelled.
 *
 * @param root Normalized skills folder.
 * @param dest Normalized destination path.
 */
function containedIn(root: string, dest: string): boolean {
  if (dest.split("/").some((seg) => seg === "..")) return false;
  // normalizePath maps an empty folder to "/", and nothing is prefixed with "/" once
  // normalized — so the vault root is its own case rather than a prefix test.
  if (root === "/") return dest !== "/";
  return dest !== root && dest.startsWith(`${root}/`);
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
