# Skillwright

LLM rewriting for Obsidian with **Claude Code-style skills**. Highlight text, pick a skill and/or type an instruction, review the result in a preview modal, then Replace / Insert Below / Copy.

The preview modal reports the provider, the model that actually ran (after any per-rewrite override), and which skill was applied — so a result you didn't expect is traceable to the settings that produced it. It opens on an inline diff of the original against the result; a `Diff | Edit` toggle switches to an editable textarea, and edits made there show up in the diff when you switch back. **Re-Run** reissues the identical request — same skill, instruction, provider/model, temperature — without closing the modal, and keeps every attempt: `‹ attempt 2 / 3 ›` arrows flip between them, and Replace / Insert below / Copy act on whichever attempt (or hand-edit) is on screen. Attempts don't survive closing the modal.

## Providers

- **Ollama** — local, no key. Default `http://localhost:11434`. Local model output is inconsistent run to run, so Re-Run in the preview modal is the normal way to reroll a bad result.
- **OpenAI** — Chat Completions, any model string.
- **Anthropic** — Messages API, any model string.

All requests go through Obsidian's `requestUrl` (no CORS issues, works desktop + mobile). Responses are non-streaming by design — the preview modal shows the full result.

## Skills

Same layout as Claude Code skills, stored in a vault folder (default `_skills/`):

```
_skills/
  lab-notes-voice/
    SKILL.md          # frontmatter: name, description; body = instructions
    ref-word-list.md  # referenced from SKILL.md, pulled into the prompt
  tighten/
    SKILL.md
```

Frontmatter `name` and `description` populate the picker; the body is injected into the system prompt. Loose `_skills/foo.md` files also work for quick one-offs.

### Skill sources

Skills are read from several places and merged into one picker:

1. **The vault skills folder** — default `_skills/`, editable in Obsidian, synced with your vault.
2. **Agent skill folders** — `~/.claude/skills` and `~/.codex/skills`, read **in place**. On by default (Settings → *Include agent skill folders*); skip it if you don't want them.
3. **Extra skill folders** — any other folders, one absolute path per line in settings. `~` is expanded; lines starting with `#` are ignored.

If you already have skills on disk for Claude Code or Codex, there is nothing to import — they show up in the picker as-is and stay in sync, because every rewrite re-reads them from disk.

Sources are consulted in that order and the **first one wins a name collision**, so a vault skill shadows a same-named one on disk. *List loaded skills* reports the per-source counts and anything shadowed.

External folders are **desktop only** (Obsidian on mobile has no filesystem access) and **read-only** — Skillwright never writes to them.

### How a skill becomes a prompt

There is no tool loop here — the providers are plain chat completions, so anything the model needs has to be in the message it receives. A skill written for Claude Code assumes the opposite: it says "read `references/BRAND.md`" and trusts the agent to go open it. Skillwright closes that gap by resolving those paths itself and **embedding the referenced files directly into the system prompt** before the request goes out.

What counts as a reference: markdown links, wikilinks, and bare `some-file.md` mentions. The bare form matters because imported skills often just write "follow BRAND.md §5" in prose with no link syntax at all.

Path resolution:

- Paths are resolved relative to the file doing the referencing, so `references/BRAND.md` in a `SKILL.md` lands on `<skill>/references/BRAND.md`.
- A **bare mention with no path** (`BRAND.md`) carries no directory, so if nothing sits next to `SKILL.md` the skill folder is searched by filename — a prose mention of `BRAND.md` finds `references/BRAND.md` without you rewriting the skill.
- A reference file may itself reference one more: two hops from `SKILL.md`, then it stops. Each file is inlined once no matter how many times it's mentioned.
- Only `.md` files **inside the skill's own folder** are read. External URLs, other file types, paths escaping the folder (`../../secrets.md`), and paths reaching sideways into another skill (`../other-skill/SKILL.md`) are never fetched — nor are symlinks pointing out of it. Anything that looked like a local reference but didn't resolve is named in a notice so a dead link doesn't fail silently. (A *loose* `_skills/foo.md` skill has no folder of its own, so its references are scoped to the skills folder instead.)

Resolution happens when you run a rewrite, not when the picker loads, so unused skills cost nothing.

Total reference size is capped by **Reference budget (characters)** in settings (default 40,000). Files past the cap are skipped whole and named in a notice; the request still goes out.

**Zip import** (for skills you *don't* already have on disk — otherwise point Skillwright at the folder instead): command palette → *Skillwright: Import skills from zip*. Writes into the vault skills folder. Handles zips with skills at the root, under one wrapping directory (which is stripped), or a single skill zipped as its own folder (which is kept, so the skill stays in its own subfolder rather than being flattened into the skills folder). Entries whose path lands outside the skills folder are refused and named in the notice — see [Security](#security).

Two example skills are in `example-skills/` — copy them into your vault's skills folder to try it.

## Install (manual)

1. `npm install && npm run build`
2. Copy `manifest.json`, `main.js`, `styles.css` into `<vault>/.obsidian/plugins/skillwright/`
3. Enable in Settings → Community plugins.

For development: symlink the repo into the plugins folder and use `npm run dev` (watch mode) with the Hot Reload plugin.

## Commands

- **Rewrite selection…** — main flow (also on the editor right-click menu)
- **Import skills from zip…**
- **List loaded skills**

All three are bindable. Settings → Skillwright → **Hotkeys** lists them with their current bindings and a button that jumps straight to Obsidian's Hotkeys pane, pre-filtered to Skillwright.

## Security

### Where your API key lives

`<vault>/.obsidian/plugins/skillwright/data.json`, **in plain text**. Obsidian gives plugins no keychain and no encrypted storage, so every plugin that talks to a paid API does this; anything a plugin could decrypt unattended wouldn't be protecting the key anyway. What matters is the three ways that file travels:

- **Vault sync.** `.obsidian/` lives inside the vault, so Obsidian Sync, Dropbox, iCloud, and git all replicate it — including version history. Exclude `.obsidian/plugins/skillwright/data.json` if your vault is shared or backed up somewhere you don't control.
- **Other plugins.** Obsidian has no isolation between plugins. Any other community plugin you install can read that file.
- **Accidental commits.** Vaults kept in git routinely commit `.obsidian/`.

If none of that is acceptable, **use Ollama** — it's the default provider and needs no credential at all. Otherwise use scoped, spend-capped, rotatable keys (OpenAI project keys, Anthropic workspace keys), so a leak is a chore rather than an incident.

### What leaves your machine

The selected passage, your instruction, the active skill's body, and any reference files it pulls in — sent to whichever provider you picked, nothing else. Skillwright makes no telemetry or update requests. With Ollama pointed at localhost, none of it leaves the machine.

### The plugin can't act on model output

There is no tool loop. The providers are plain chat completions, and Skillwright reads only the text out of the response — if a model tries to emit a tool call it's discarded, and you get an "Empty response from model" notice. Nothing in the response can write a file, run a command, or reach the network. The result is inert text: it's rendered as text in the preview (never as HTML), and it only touches your note when you click **Replace** or **Insert below**, after you've seen the diff.

### Skills you didn't write

A skill is instructions plus whatever files it references, and both go straight into the prompt. A skill from someone else therefore gets to decide which files are read on your behalf and sent to your provider — so the boundary matters.

A skill can only read `.md` files **inside its own folder**. Not the folder next to it, not the skills folder above it. Paths that escape (`../../secrets.md`), paths that reach sideways into another skill (`../other-skill/SKILL.md`), symlinks pointing out, and non-`.md` files are all refused, and a refused reference is named in a notice rather than dropped quietly. So an imported skill can't read your other skills, and it can't read your notes.

Two caveats to that:

- A **loose** `_skills/foo.md` skill — a single file, no folder — has no folder to be scoped to, so its references are scoped to the skills folder instead. Loose skills are the ones you write yourself; keep it that way.
- Don't set **Skills folder** to your vault root. It would make the loose-skill scope your entire vault, and it isn't what the setting is for.

Beyond that, skim a skill from a stranger before running it, the same as any script — it's instructions to a model, and it's your API budget.

Zip import enforces the same containment: entries resolving outside the skills folder are refused and named in the import notice, so a zip that tries to overwrite plugin code or config can't.
