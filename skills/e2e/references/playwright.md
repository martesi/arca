# Playwright E2E

Use Playwright Test for repeatable automated browser regressions, CI, fixtures, retries, traces, and browser-level assertions. Keep it separate from agent-driven `agent-browser` checks.

## Standard repository shape

For repos that support both automated and agent-driven browser E2E, keep the commands explicit:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:agent:start": "<repo bootstrap for the agent browser>",
    "test:agent": "<repo environment> agent-browser",
    "test:agent:stop": "<stop only agent-owned runtime>"
  }
}
```

Keep Playwright-specific tests and helpers under a dedicated directory such as `e2e/playwright/`. `test:e2e` belongs to Playwright. `test:agent` is a thin pass-through to `agent-browser`; it is not a wrapper around the Playwright harness.

Do not make agent E2E inspect or reuse Playwright helpers. Do not point Playwright at the agent browser's persistent profile. Shared source-level utilities such as a cookie-file parser are fine; browser state is not.

## Minimal setup

Use the project's package manager. For a Bun project:

```sh
bun add -d @playwright/test
```

```js
// playwright.config.js
import { defineConfig } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
    testDir: './e2e/playwright',
    use: {
        launchOptions: executablePath ? { executablePath } : {},
    },
});
```

Prefer Playwright's managed browser when it runs cleanly; Playwright is tested most closely against its bundled browser revisions. In Nix/slim environments where that downloaded binary cannot run without a large FHS compatibility closure, a repo-declared Chromium can be a pragmatic fallback. Pin it in `devShells.e2e`, export its path as `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and keep the override easy to remove if browser-version compatibility becomes a problem.

## Dev server ownership

Prefer Playwright's `webServer` config when the automated suite owns the web server:

```js
export default defineConfig({
    testDir: './e2e/playwright',
    webServer: {
        command: 'bun run dev',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: !process.env.CI,
    },
});
```

If the project already has a dedicated external browser or CDP lifecycle, keep that logic inside the Playwright path. Do not move it into agent-browser setup merely to share code.

## Authentication bootstrap

When the repository intentionally supports local cookie bootstrap, both E2E paths may read the same ignored source files but must import them independently:

1. Prefer `cookies.json` when present.
2. Otherwise accept matching Netscape-format `cookies*.txt` files when the project needs browser-export compatibility.
3. Import the cookies into the Playwright context or dedicated Playwright browser state.
4. Import the same source separately into the agent-browser session/profile.
5. Never make the two paths share a browser profile, storage-state output, or live browser process.

Keep cookie files ignored and never print cookie values in logs or test output.

## Scope

Use the narrowest automated test that covers the regression. Do not run the full Playwright suite merely because it exists. For visual or exploratory verification performed by the agent, use the agent-browser path instead.
