import type { Skill } from "./skills";

/** A `/token` sitting under the caret, as offsets into the instruction text. */
export interface SlashToken {
  /** Offset of the `/` itself */
  start: number;
  /** Offset one past the last token character */
  end: number;
  /** Token text without the leading slash */
  query: string;
}

/** Token characters, shared by the caret scanner and the whole-text scanner. */
const TOKEN_CHARS = /[A-Za-z0-9._-]/;

/** `/token` preceded by start-of-text or whitespace. Group 2 is the token body. */
const TOKEN_RE = /(^|\s)\/([A-Za-z0-9._-]+)/g;

/**
 * Normalises a skill name into the form a user would type after the slash.
 * Frontmatter names may carry spaces and capitals; tokens never do.
 *
 * @param name - skill display name
 * @returns lowercase, hyphen-joined slug
 */
export function skillSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
}

/**
 * Finds the `/token` being typed at the caret.
 *
 * Requires the slash to sit at the start of the text or directly after
 * whitespace, and requires an unbroken run of token characters between it and
 * the caret — so `and/or` and `https://x` never open the popup.
 *
 * @param text - full textarea value
 * @param cursor - caret offset (`selectionStart`)
 * @returns the token under the caret, or null if there isn't one
 */
export function tokenAtCursor(text: string, cursor: number): SlashToken | null {
  let i = cursor;
  while (i > 0 && TOKEN_CHARS.test(text[i - 1])) i--;
  if (i === 0 || text[i - 1] !== "/") return null;

  const start = i - 1;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;

  // Include any token characters to the right of the caret so editing mid-token
  // replaces the whole thing rather than splicing into the middle of it.
  let end = cursor;
  while (end < text.length && TOKEN_CHARS.test(text[end])) end++;

  return { start, end, query: text.slice(i, cursor) };
}

/**
 * Filters skills against a partially typed token.
 *
 * @param query - token body, without the leading slash
 * @param skills - loaded skills
 * @returns prefix matches first, then substring matches; original order within each
 */
export function matchSkills(query: string, skills: Skill[]): Skill[] {
  const q = query.toLowerCase();
  if (!q) return skills.slice();

  const prefix: Skill[] = [];
  const substring: Skill[] = [];
  for (const s of skills) {
    const slug = skillSlug(s.name);
    const name = s.name.toLowerCase();
    if (slug.startsWith(q) || name.startsWith(q)) prefix.push(s);
    else if (slug.includes(q) || name.includes(q)) substring.push(s);
  }
  return [...prefix, ...substring];
}

/**
 * Resolves the skill referenced by a `/token` in the instruction text.
 *
 * Every token naming a real skill is removed from the text, and the last of
 * them wins the selection — so retyping a reference overrides an earlier one
 * without leaving the dead reference in the prompt. Tokens that match nothing
 * are left in place: a stray `and/or` or URL fragment shouldn't silently
 * vanish from what the user wrote.
 *
 * @param text - full instruction text
 * @param skills - loaded skills
 * @returns the referenced skill (or null) and the text with known tokens removed
 */
export function resolveSkillToken(
  text: string,
  skills: Skill[]
): { skill: Skill | null; cleaned: string } {
  let skill: Skill | null = null;
  const cuts: Array<{ start: number; end: number }> = [];

  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m !== null; m = TOKEN_RE.exec(text)) {
    const q = m[2].toLowerCase();
    const hit = skills.find((s) => skillSlug(s.name) === q || s.name.toLowerCase() === q);
    if (!hit) continue;
    skill = hit;
    cuts.push({ start: m.index + m[1].length, end: m.index + m[0].length });
  }

  if (!skill) return { skill: null, cleaned: text };

  // Excise back-to-front so earlier offsets stay valid, then close the gaps the
  // removals leave between the surrounding words.
  let cleaned = text;
  for (let i = cuts.length - 1; i >= 0; i--) {
    cleaned = cleaned.slice(0, cuts[i].start) + cleaned.slice(cuts[i].end);
  }
  return { skill, cleaned: cleaned.replace(/[ \t]{2,}/g, " ") };
}
