# Bundled preview themes

`pi-light.json` and `pi-dark.json` are Pi **1.0.4**’s named stock themes, resolved to hex using Pi’s own colour code. They preserve the source colour variables, resolved roles and explicit export backgrounds. `pi-provenance.json` records source/output SHA-256 hashes. Upstream: https://github.com/earendil-works/pi/tree/v1.0.4/packages/coding-agent/src/modes/interactive/theme ; MIT licence in `pi-LICENSE`.

Reproduce/check with `node scripts/sync-pi-themes.mjs /path/to/pi-coding-agent --check` (omit `--check` to regenerate intentionally). This is a maintenance operation, not a runtime dependency. The companion never launches Pi or queries terminal colours. Pi 1.0.4’s terminal-derived `system` theme cannot be recovered from session logs; these presets are the named light/dark pair, not live terminal-theme detection.

`pi-studio-light.json` and `pi-studio-dark.json` remain the separate Pi Studio palettes. Use `--agent-theme pi=pi-studio` for Pi responses only, or `--theme pi-studio` for a global override. Explicit legacy `auto`, `light`, and `dark` retain the original preview palettes.
