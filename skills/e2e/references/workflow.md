
# E2E

Use this skill for test strategy and execution workflow. Treat harness availability as a
precondition; do not embed harness implementation details here.

## Principles

- Verify the user-visible behavior at the narrowest boundary that can actually prove it.
  Do not launch a UI for a function, API, CLI, or parser change when that boundary is enough.
- Reproduce a reported UI bug before editing when practical. After the change, rerun the
  same user-facing path rather than substituting a nearby check.
- Prefer one representative path over a broad suite. Expand only when the failure or change
  crosses multiple paths.
- Separate exploratory/agent-driven checks from repeatable automated regression tests.
  They may cover the same behavior, but they do not need to share browser state.
- Treat environment readiness as a prerequisite, not as evidence that the product works.
- Observe the acceptance criterion directly. Use DOM/state/output assertions for functional
  behavior and inspect an image when layout, rendering, or visual appearance is the claim.
- Treat browser sessions, tabs, files, credentials, and processes as user-owned unless the
  test created them. Manipulate and clean up only what the run owns.
- Diagnose failures by layer before changing code: harness/runtime, application startup,
  browser/native interaction, or product assertion.

## Choose the path

- Non-UI behavior: test the direct function, API, CLI, or other narrow boundary.
- Agent-driven website exploration or visual verification: use the harness `browser` path, which drives its owned Chromium through Playwright CLI.
- Repeatable browser regression or CI: use Playwright Test.
- Userscript or browser-extension behavior: use the harness's owned agent profile for
  interactive Playwright-driven verification; keep automated Playwright Test state separate.
- Desktop GUI behavior: use the repository's visual-capable desktop E2E path.
- Electron: prefer the existing browser/CDP path for DOM-visible behavior when the harness
  exposes one; use native interaction only for behavior outside the renderer.
- Tauri or other system-webview/native surfaces: prefer the existing visual/native path
  unless the repository already provides a supported inspection channel.

If the required path has no working project harness, switch to `e2e` to install or
repair it, then return to this workflow.

## General workflow

1. Define the exact user action and observable acceptance criterion.
2. Inspect the repository's existing E2E commands, configuration, and supported test path.
   Reuse them rather than inventing a parallel flow.
3. Confirm the required harness is available. If startup, browser ownership, profiles,
   shells, extensions, or Playwright infrastructure are missing or broken, use
   `e2e`.
4. Establish the baseline: reproduce the reported failure, or confirm the pre-change
   behavior when the task is not a bug.
5. Run the smallest realistic user path that crosses the boundary being changed.
6. Assert the outcome at the closest observable boundary. Capture and inspect screenshots
   only when visual evidence is part of the acceptance criterion.
7. If it fails, identify the failing layer before editing. Do not patch product code to
   compensate for a broken harness, and do not rewrite harness infrastructure to hide a
   product failure.
8. After the change, rerun the exact affected path. Add a focused automated regression only
   when the behavior is stable and worth preserving in the suite.
9. Stop only owned processes, close only owned pages, remove disposable artifacts, and
   report the path exercised plus the evidence observed.

## User-owned browsers

Do not navigate, reload, close, or reconfigure existing user pages unless the user
explicitly chose that page for the test. Open one new page for the check and close only that
page afterward.

Do not run broad automated suites against an everyday user browser. For userscripts and
extensions, inspect the existing development environment before changing extension state or
permissions.

## Harness boundary

`e2e` owns reusable infrastructure and operational mechanics, including:

- command wiring and `e2e.toml`;
- browser, CDP, Xvfb, dev-server, and cleanup lifecycle;
- isolated profiles, sessions, ports, and environment injection;
- cookie import and userscript/extension bootstrap;
- Playwright configuration and external-browser integration;
- dedicated E2E dev shells and platform/runtime setup;
- detailed Electron, Tauri, userscript, virtual-display, and browser-runtime diagnostics.

Keep target URLs, selectors, fixtures, product-specific navigation, and acceptance assertions
in the consuming repository.
