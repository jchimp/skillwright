# Skillwright

LLM rewriting for Obsidian with **Claude Code-style skills**. Highlight text, pick a skill and/or type an instruction, review the result in a preview modal, then Replace / Insert Below / Copy.

## Providers

- **Ollama** — local, no key. Default `http://localhost:11434`.
- **OpenAI** — Chat Completions, any model string.
- **Anthropic** — Messages API, any model string.

All requests go through Obsidian's `requestUrl` (no CORS issues, works desktop + mobile). Responses are non-streaming by design — the preview modal shows the full result.

## Skills

Same layout as Claude Code skills, stored in a vault folder (default `_skills/`):

```
_skills/
  lab-notes-voice/
    SKILL.md        # frontmatter: name, description; body = instructions
  tighten/
    SKILL.md
```

Frontmatter `name` and `description` populate the picker; the body is injected into the system prompt. Loose `_skills/foo.md` files also work for quick one-offs.

**Zip import:** command palette → *Skillwright: Import skills from zip*. Handles zips with skills at the root or under one wrapping directory.

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

## Notes / caveats

- API keys are stored **in plain text** in `data.json` in the vault's plugin folder. Don't sync the vault anywhere untrusted, or use Ollama.
- The per-rewrite provider/model override in the modal falls back to the settings default when left blank.
