# TODO

## 2026-08-02

- Add timeout setting, display message when we timeout.
- Modal-less version, popup chat bar, reference skill via /'skill'
- ~~Load skills from ~\.claude\skills, or ~\.codex\skills, etc. Can we just use skill where they are so the user doesn't have to install them?~~ Done — `src/store.ts` reads external folders in place; auto-detect toggle + extra folders in settings.
