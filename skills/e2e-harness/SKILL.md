---
name: e2e-harness
description: Install or repair reproducible project-owned E2E harnesses, including Bun-runnable browser bootstrap, command wiring, isolated state, cookie import, userscript-manager setup, Playwright configuration, Xvfb/browser lifecycle, and dedicated Nix E2E shells. Use for harness infrastructure and project installation; use e2e when an existing harness only needs to be run.
version: 0.2.0
---

# E2E harness

Install the smallest stable harness the repository actually needs. Keep generic lifecycle
plumbing separate from application-specific test behavior.

## Boundary

This skill owns committed E2E infrastructure and a reusable Bun harness runtime:

- package/task commands that expose repeatable E2E entry points;
- `scripts/harness.mjs`, which users run with Bun instead of hand-managing setup;
- browser and virtual-display lifecycle owned by the test run;
- isolated agent and Playwright browser state;
- environment injection for agent-browser profile, session, extensions, browser args, and screenshots;
- generic cookie-file discovery/import and userscript-manager permission/install bootstrap;
- Playwright configuration and dev-server ownership;
- dedicated Nix E2E shells and reproducible browser/tool availability.

Keep these project-local:

- target URLs, accounts, selectors, assertions, fixtures, and acceptance criteria;
- application build/server orchestration that exists only for that product;
- product-specific navigation, settings manipulation, download semantics, or test data.

Do not turn a project-specific server harness into a generic library merely because it
spawns a process.

## Workflow

1. Inspect the existing manifests, dev shell, E2E directories, browser scripts, ignore
   rules, and CI before editing. Reuse working project conventions.
2. Classify the required surfaces: Playwright automation, agent-driven browser checks,
   userscript/extension checks, desktop GUI checks, or a combination.
3. Install only the matching harness pieces from `references/installation.md`. Run the
   bundled Bun runtime in place; do not copy generic browser lifecycle or cookie code into
   the consuming repository.
4. Keep Playwright and agent-browser state separate. A shared cookie source is fine; a
   shared profile, live browser, or generated storage-state file is not.
   Reuse one owned Chromium only within the same mode and explicit instance.
5. Keep lifecycle ownership explicit: stop only processes the harness started. Preserve a
   persistent agent profile when it contains one-time browser or extension permissions.
6. Run the smallest smoke check that proves the installed harness starts, reaches its
   readiness boundary, and cleans up. Then run one representative E2E path.

## Bun harness contract

Use the installed skill runtime directly; do not copy its implementation into the repository:

```sh
bun .agents/skills/e2e-harness/scripts/harness.mjs browser -- snapshot
bun .agents/skills/e2e-harness/scripts/harness.mjs browser --instance review-a -- snapshot
bun .agents/skills/e2e-harness/scripts/harness.mjs playwright -- test
bun .agents/skills/e2e-harness/scripts/harness.mjs install-userscript
bun .agents/skills/e2e-harness/scripts/harness.mjs stop
```

The consuming repository keeps only `e2e.toml` plus product assertions. Without an
explicit path, the runtime infers the project root as `../..` from the skill root. Config
precedence is `--config`, then `E2E_CONFIG`, then the inferred `e2e.toml`. The runtime owns agent-browser
environment injection, profile/session selection, Xvfb and dev process ownership, cookie
import, userscript-manager permission setup, userscript install confirmation, Chromium CDP
startup, and idle browser cleanup.

`browser` is self-starting. It reuses one Chromium for the selected instance and prefers
an executable supplied by config or the current environment. It enters a dev shell only
when `shell.command` is explicitly configured; otherwise Chromium resolves from the
current environment/PATH. It attaches `agent-browser` over CDP and reaps only that owned
browser after the configured idle timeout. CDP ports default to OS allocation; set
`agent.port` or pass `--port` when a stable port is required.

`playwright` provides the same owned-Chromium lifecycle with a separate profile root and
passes the endpoint through `PLAYWRIGHT_CDP_ENDPOINT` plus
`E2E_HARNESS_CDP_ENDPOINT`. Keep project-specific Playwright fixtures responsible for
connecting to that endpoint and creating contexts. Use `--instance` for concurrent agents
or Playwright runs; non-default instances get separate profile directories and agent
sessions.

When package scripts are useful, keep them as aliases to the runtime:

```text
test:e2e          -> bun .../e2e-harness/scripts/harness.mjs playwright -- test
test:agent        -> bun .../e2e-harness/scripts/harness.mjs browser --
test:agent:stop   -> bun .../e2e-harness/scripts/harness.mjs stop
```

Do not wrap Playwright inside `test:agent`, and do not make the agent path inspect or import
Playwright helpers.

## Browser state and secrets

Use repository-local ignored state such as:

```text
.browser-state/agent/
.browser-state/playwright/
.cache/e2e/
```

Prefer `cookies.json` when present, otherwise accept intentional `cookies*.txt` Netscape
exports. Keep cookie sources ignored. Never print cookie values, commit them, or translate
them into checked-in storage state.

`assets/browser/cookie-loader.mjs` provides a dependency-free parser for this contract.
`assets/browser/runtime.mjs` provides process ownership, Xvfb readiness, and URL readiness
primitives. `assets/browser/cdp-runtime.mjs` provides isolated Chromium/CDP reuse and idle
cleanup. Run these from the installed skill; do not copy them into the consuming repository.

## Nix projects

Use a sibling `devShells.e2e` instead of bloating the default shell. Reuse existing common
packages/hooks, add only the E2E-only closure, and prefer nixpkgs Chromium when foreign
browser binaries are troublesome. Read `references/nix.md` before editing a flake.

## Userscripts and extensions

Keep userscript-manager paths, dev-server URLs, and target-site facts in a thin local
wrapper. Generic profile isolation, cookie import, extension/browser startup, and install
confirmation belong in the harness. Read `references/installation.md`.

## Verification

A harness change is complete only when:

- generated state and credentials are ignored;
- the agent and Playwright paths cannot accidentally share browser state;
- start/stop leaves unrelated user processes and tabs untouched;
- the narrow type/lint/syntax check for changed harness files passes;
- one representative start/readiness/cleanup path succeeds;
- the consuming repository can still run its project-specific E2E behavior without
  embedding generic lifecycle code into assertions.
