---
name: e2e
description: Plan, run, diagnose, install, and repair end-to-end verification for websites, desktop GUI apps, and userscript/browser-extension flows. Use for realistic UI verification, reported UI bugs, agent-driven Playwright or Playwright Test execution, project-owned browser/runtime harness setup, isolated profiles, .config/arca.toml configuration, shells, and platform diagnostics.
version: 2.2.1
---

# E2E

Use the smallest realistic path that proves the user-visible behavior. Reuse the repository's
existing E2E setup before adding infrastructure, and keep generic harness mechanics separate
from product-specific assertions.

## Read as needed

- `references/workflow.md` — test strategy, path selection, bug reproduction, acceptance
  evidence, user-owned browser safety, and cleanup.
- `references/harness.md` — harness ownership, Node-compatible TypeScript runtime contract, browser/Playwright
  isolation, state, secrets, and harness verification.
- `references/installation.md` — project integration, `.config/arca.toml`, command wiring, and modes.
- `references/playwright.md` — Playwright configuration, auth bootstrap, and dev-server setup.
- `references/userscripts.md` — userscript/extension profiles, permissions, and install flow.
- `references/electron.md` / `references/tauri.md` — desktop runtime mechanics.
- `references/nix.md` / `references/e2e-shell.md` / `references/driving.md` — reproducible shells,
  virtual displays, native input, screenshots, and cleanup.

Use `scripts/harness.ts` directly for reusable browser/runtime lifecycle. Keep target URLs,
selectors, fixtures, product navigation, and acceptance assertions in the consuming repository.
