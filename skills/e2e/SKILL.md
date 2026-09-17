---
name: e2e
description: >-
  Run end-to-end checks for desktop GUI apps, websites, and userscript/browser-extension
  development flows. Use agent-browser for agent-driven browser verification, Playwright
  Test for repeatable automated browser regressions, and a visual-capable e2e agent on a
  virtual display for desktop apps. Keep agent and Playwright browser state separate. Use
  for UI behavior or visual assessment; do not launch a UI for a non-UI function change.
---

# E2E

Choose the test strategy before running anything.

- Non-UI change: test the function, API, CLI, or other narrow boundary directly. Do not
  run the UI just to prove a function works.
- Desktop GUI change or behavior: use the `e2e` agent with visual capability on a
  virtual display. Read `references/e2e-shell.md` and the app-specific reference as
  needed.
- Agent-driven website verification, exploration, or visual assessment: use
  `agent-browser` directly.
- Automated website regression, CI, or an explicit Playwright request: use Playwright
  Test. Read `references/playwright.md`.
- Userscript or browser-extension behavior: use `agent-browser` for the agent path and
  Playwright only for an explicitly automated suite. Read `references/userscripts.md`.
- Unknown app or target: ask the user to choose the test strategy before running it.

Use the smallest sufficient check. A UI run is for UI behavior, integration across the
UI boundary, or visual assessment—not a default requirement for every change.

## Keep browser paths separate

When a repository supports both agent-driven and automated browser E2E, make the split
obvious in commands and files:

```text
test:e2e          -> Playwright Test
test:agent:start  -> prepare the repo-owned agent browser environment
test:agent        -> pass through to agent-browser with repo env/paths applied
test:agent:stop   -> stop only agent-owned runtime
```

Keep Playwright-specific code in a dedicated directory such as `e2e/playwright/`. Agent
E2E must not inspect, import, or copy setup from the Playwright harness merely because it
exists. Playwright must not reuse the agent browser profile or live agent session. Shared
source-level parsers are fine; browser state is not.

## Existing user browsers

Treat a browser session as user-owned unless the test created and owns it. When attaching
to a user-owned browser, do not navigate, reload, close, or otherwise manipulate existing
pages unless the user explicitly asks for that page to be used. Create one new test page,
keep the test on that page, and close it when the work is finished.

Do not run broad automated E2E suites against a user-owned browser. Use only the smallest
manual or targeted interaction needed to verify the requested behavior. For userscript or
browser-extension testing, inspect the browser's extension/developer environment first; if
the target is already available or development mode is enabled, reuse that state instead of
trying to install or reconfigure it blindly.

## Screenshots and generated artifacts

Screenshots are optional for a functional check whose acceptance criterion is only that
a button or trigger performs the expected action. Use state, DOM, return values, or
other direct assertions instead when they are sufficient.

Capture and inspect screenshots when the workflow assesses UI implementation, layout,
styling, rendering, or other visual behavior. Always read a required screenshot back;
do not treat file creation or file size as visual confirmation.

Write screenshots, logs, and test output to a temporary location by default. Remove
generated artifacts that are not being shown to the user once the result has been
confirmed by the agent or user. If an artifact is retained or shown for user
confirmation, ask the user whether it should be removed after confirmation rather than
silently deleting it.

## Desktop GUI setup

Nothing GUI-related is preinstalled. The project declares what it needs in a dedicated
`devShells.e2e`, so the default shell stays lean for everyday development and only
end-to-end runs pay for the GUI closure. See `references/e2e-shell.md` to set that up—do
it once per repo.

## Happy path

```sh
nix develop .#e2e            # brings xvfb, xdotool, xdpyinfo, imagemagick + the EGL vars

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -noreset &
until DISPLAY=:99 xdpyinfo >/dev/null 2>&1; do sleep 0.1; done
export DISPLAY=:99

<the app's own dev command> &          # e.g. bun run dev
xdotool search --onlyvisible --name '<window title>'   # confirm it opened

xdotool mousemove 85 132 click 1       # drive it when a visual/native interaction is needed
```

Use screenshots in this path only when the selected test strategy requires visual
assessment. Kill Xvfb and the app when done.

**Electron app? Skip most of the `xdotool` steps above.** Electron is real Chromium, so its
`--remote-debugging-port` CDP connection actually works (unlike WebKitGTK/Tauri, where it's a
dead end - see `references/tauri.md`) - drive clicks, form fills, and file inputs over CDP
instead, and reach for `xdotool` only for native OS dialogs CDP can't see into. See
`references/electron.md`.

## References

| File | Read it for |
| --- | --- |
| `references/e2e-shell.md` | Declaring the tools; why `devShells.e2e` and not `default`; the EGL fix; Nix Chromium setup; ad-hoc fallback for non-nix repos |
| `references/playwright.md` | Automated browser suites, `test:e2e`, repo script layout, separate state, Playwright config, and auth bootstrap |
| `references/userscripts.md` | Userscript-manager E2E loops, persistent agent profiles, split agent/Playwright paths, vite-plugin-monkey install flow, and optional test-only HTTP CSP stripping |
| `references/driving.md` | Xvfb lifecycle and readiness, screenshots, `xdotool` input, watching live over VNC |
| `references/tauri.md` | Tauri/WebKitGTK specifics; why not to reuse a prebuilt binary; why CDP is a dead end |
| `references/electron.md` | Electron specifics; driving over CDP instead of `xdotool` (a minimal Node WebSocket client, the React-controlled-input setter trick, `DOM.setFileInputFiles` for file pickers); why GPU/EGL errors are noisy but usually harmless here; what CDP still can't reach (native OS dialogs) |
