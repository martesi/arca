---
name: e2e-harness
description: Install or repair reproducible project-owned E2E harnesses, including command wiring, isolated browser state, cookie bootstrap, userscript-manager setup, Playwright configuration, Xvfb/browser lifecycle, and dedicated Nix E2E shells. Use for harness infrastructure and project installation; use e2e when an existing harness only needs to be run.
version: 1.0.0
---

# E2E harness

Install the smallest stable harness the repository actually needs. Keep generic lifecycle
plumbing separate from application-specific test behavior.

## Boundary

This skill owns committed E2E infrastructure:

- package/task commands that expose repeatable E2E entry points;
- browser and virtual-display lifecycle owned by the test run;
- isolated agent and Playwright browser state;
- generic cookie-file parsing and userscript-manager bootstrap;
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
3. Install only the matching harness pieces from `references/installation.md`. Copy code
   from `assets/browser/` only when the repository needs those generic primitives.
4. Keep Playwright and agent-browser state separate. A shared cookie source is fine; a
   shared profile, live browser, or generated storage-state file is not.
5. Keep lifecycle ownership explicit: stop only processes the harness started. Preserve a
   persistent agent profile when it contains one-time browser or extension permissions.
6. Run the smallest smoke check that proves the installed harness starts, reaches its
   readiness boundary, and cleans up. Then run one representative E2E path.

## Stable command contract

When the corresponding surface exists, prefer these names:

```text
test:e2e          -> automated Playwright suite
test:agent:start  -> prepare only agent-owned runtime
test:agent        -> thin pass-through to agent-browser
test:agent:stop   -> stop only agent-owned runtime
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
primitives. Copy them into the consuming repository only if equivalent helpers do not
already exist.

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
