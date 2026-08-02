# TODO

## 2026-08-02

- Add timeout setting, display message when we timeout.
- Modal-less version, popup chat bar, reference skill via /'skill'
- Keybindings - Allow Skillwrite: Rewrite command to me mapped to key binding.
    - Keybinding to direct skill and just call the skill as the 'prompt'
    - Keybingings to prompts - prompt could be prose with a 'skill' listed in the prompt, example: 're-write this with the voice from /jchimp-brand'. That would load the skill and pass in the instruction too.
- ~~Load skills from ~\.claude\skills, or ~\.codex\skills, etc. Can we just use skill where they are so the user doesn't have to install them?~~ Done — `src/store.ts` reads external folders in place; auto-detect toggle + extra folders in settings.
