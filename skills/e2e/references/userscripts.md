# Userscript E2E

Use this workflow for browser-visible userscript behavior, especially projects using `vite-plugin-monkey` with Violentmonkey or ScriptCat and the harness's Playwright-driven browser path.

## Reuse a persistent browser profile

Keep the browser profile outside source-controlled output, for example:

```sh
export AGENT_BROWSER_PROFILE="$PWD/.browser-state/profile"
```

Load the userscript manager as an unpacked extension with `AGENT_BROWSER_EXTENSIONS`. Persist the profile so the manager's one-time permissions and installed userscript survive source edits.

## Violentmonkey on Chromium

For Violentmonkey-backed userscript tests, use headed Chromium on a virtual display rather than pure headless mode. In Chromium 153 with Violentmonkey 2.49.0, `--headless=new --load-extension=...` loads the extension and its service worker, but the installed userscript does not execute. This is a userscript-manager runtime limitation, not a general Chromium extension-loading limitation.

Use Xvfb as the minimal display backend when no real display exists:

```sh
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -noreset &
until DISPLAY=:99 xdpyinfo >/dev/null 2>&1; do sleep 0.1; done
export DISPLAY=:99
node .agents/skills/e2e/scripts/harness.ts browser -- snapshot
```

Disable Chromium's Local Network Access checks in the owned E2E browser when the userscript/dev page must talk to loopback or another local-network endpoint. Chromium keeps `LocalNetworkAccessChecks` enabled by default, and disabling that feature removes the permission gate that can otherwise block local dev-server requests. Keep this override test-only; do not apply it to a user's normal browser profile.

If Chromium exits with `Missing X server or $DISPLAY`, check this setup before blaming the target application.

Chrome also requires the extension-level **Allow User Scripts** permission. After loading Violentmonkey, open its `chrome://extensions/?id=...` details page and enable **Allow User Scripts** once; keep using the same persistent profile afterward.

Do not treat "Violentmonkey loaded" or "userscript installed" as a successful test. Assert that the userscript itself executes, for example through a known DOM marker, page bridge, console message, or other project-specific runtime effect.

Pure headless Chromium remains the cheaper default for ordinary website E2E that does not depend on a userscript manager.

## User-owned browser preflight

When testing a userscript or extension in a user-owned browser, inspect the existing extension environment before attempting installation. Check whether developer mode is enabled and whether the target userscript manager/extension is already installed and usable. Reuse the existing development setup when available; do not install, reload, enable, disable, or reconfigure extensions unless the task requires it.

Keep the actual test in one newly opened page and close that page after verification. Do not run the repository's automated E2E suite against the user's everyday browser session.

## Development install loop

For `vite-plugin-monkey`, prefer the development install endpoint exposed by the Vite server instead of manually injecting the built bundle:

```text
http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js
```

Open that URL through the harness `browser` path, switch to the userscript manager confirmation tab, confirm installation, then navigate to the target site. Normal source edits can arrive through Vite HMR; reinstall only when userscript metadata or the install bootstrap changes.

Keep any authentication import or site-specific navigation in the consuming repository. The reusable E2E skill must not contain cookies, fixed accounts, or site credentials.

## CSP during development

`inject-into: page` development scripts can be blocked by a site's HTTP `Content-Security-Policy` even when the userscript manager itself is loaded correctly. Browser flags such as `--disable-web-security` are not a reliable CSP switch.

When the observed failure is specifically an HTTP CSP header, load the bundled helper beside the userscript manager from the installed skill path:

```sh
export AGENT_BROWSER_EXTENSIONS="$VIOLENTMONKEY_PATH,$PWD/.agents/skills/e2e/assets/disable-csp"
```

If the host deploys skills somewhere else, resolve the active `e2e` skill root and use its `assets/disable-csp` directory instead. Do not copy the extension into the repository merely to run it.

The bundled extension is intentionally generic: it strips only `Content-Security-Policy` and `Content-Security-Policy-Report-Only` from HTTP(S) main-frame and sub-frame responses. It contains no JavaScript or background worker.

Do not enable it by default. Removing CSP disables a site security boundary and can hide production behavior. Use it only for a test browser after reproducing a CSP-blocked development injection.

The helper does not remove HTML `<meta http-equiv="Content-Security-Policy">` policies. If the site uses meta CSP, first confirm that is the actual blocker; handling response bodies requires a heavier debugger/CDP interception path and is not part of this minimal helper.

## Repository-specific workflow

For a userscript repository that supports both agent-driven checks and an automated suite, keep the paths explicit:

```text
test:e2e          -> Playwright Test
test:agent:start  -> start the agent-owned browser/dev environment
test:agent        -> pass Playwright CLI commands through the harness-owned agent browser
test:agent:stop   -> stop only agent-owned processes
```

The agent path owns its own persistent profile, for example `.browser-state/agent`. The Playwright path uses a different profile/context or a dedicated external CDP browser. Never point both paths at the same browser state.

Keep Playwright-specific code under a dedicated directory such as `e2e/playwright/`. When the user asks for agent E2E, do not inspect or reuse the Playwright harness as an environment shortcut.

A consuming repository can keep a small local bootstrap for facts that are genuinely local, such as:

- authentication import source;
- fixed E2E URLs;
- project dev-server port;
- userscript-manager path;
- expected control selectors and acceptance checks.

When local cookie bootstrap is supported, prefer `cookies.json`; if it is absent, accept Netscape-format `cookies*.txt` files. Import the same source independently into each path rather than sharing a live browser profile. Keep all cookie files ignored by source control.

Keep generic browser setup, userscript-manager behavior, and CSP diagnosis here rather than duplicating them per repository. Read `references/playwright.md` for the automated path.
