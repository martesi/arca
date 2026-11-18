# Playwright E2E

Use Playwright Test for repeatable automated browser regressions, CI, fixtures, retries, traces, and browser-level assertions. Use the project's normal Playwright command; when it needs the harness-owned browser, connect to the selected profile's endpoint. Chromium/CDP is the default; Firefox/BiDi remains available explicitly.

## Standard repository shape

For repos that support both automated and agent-driven browser E2E, keep the commands explicit:

```json
{
  "scripts": {
    "test:e2e": "node e2e/run-playwright.js",
    "test:agent": "node .agents/skills/e2e/scripts/harness.ts browser --"
  }
}
```

Keep Playwright-specific tests and helpers under a dedicated directory such as `e2e/playwright/`. `test:e2e` belongs to Playwright Test. `test:agent` passes Playwright CLI commands to the harness-owned agent browser; it does not run the automated suite.

Do not make agent E2E inspect or reuse Playwright Test helpers. Browser state is selected explicitly by profile: use the same profile when shared persistent state is intentional, or another profile when startup/state must differ.

## Minimal setup

Use the project's package manager. For a Bun project:

```sh
bun add -d @playwright/test
```

```js
// playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e/playwright',
    use: { browserName: 'chromium' },
});
```

When the harness owns the browser, select it in the harness profile or with
`--browser`; do not let a Playwright config silently choose a different engine.
Use `--executable` or the matching `PLAYWRIGHT_FIREFOX_EXECUTABLE` /
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` variable when the runtime is supplied by Nix.
The harness reports a missing browser executable as a browser/dependency error
instead of falling back to another engine.

Install the managed default with `playwright install chromium`. Prefer Playwright's managed browser when it runs cleanly; Playwright is tested most closely against its bundled browser revisions. In Nix/slim environments where that downloaded binary cannot run without a large FHS compatibility closure, pin a repo-declared Chromium in `devShells.e2e`, export its path as `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and keep the override easy to remove if browser-version compatibility becomes a problem. For the Firefox/BiDi path, select `browserName: 'firefox'`, set `[profile.<name>].browser = "firefox"`, and export `PLAYWRIGHT_FIREFOX_EXECUTABLE`.

If a project uses a Go CLI, its harness `[[dev]]` command must include the
long-running subcommand, for example `go run ./cmd/project-graph serve`, and
readiness must target an API endpoint such as `/api/graph` or `/api/health`.
Keep the test database path in one environment contract shared by the HTTP
server and any real MCP stdio child; do not replace the child with an HTTP mock.

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

For the harness-owned Firefox profile, `PW_TEST_CONNECT_WS_ENDPOINT` connects Playwright Test automatically. Keep `browserName: 'firefox'`. To share the persistent profile context, use `browser.contexts()[0]` in a project fixture; the normal Playwright `context` fixture creates an isolated context.

For an explicit Chromium profile, keep the existing CDP lifecycle and connect through `PLAYWRIGHT_CDP_ENDPOINT`.

## Authentication bootstrap

When the repository intentionally supports local cookie bootstrap:

1. Prefer `cookies.json` when present.
2. Otherwise accept matching Netscape-format `cookies*.txt` files when browser-export compatibility is needed.
3. If Playwright Test uses its own browser, import cookies into that context.
4. If Playwright Test connects to a harness profile, bootstrap cookies through that profile instead of duplicating browser state.

Keep cookie files ignored and never print cookie values in logs or test output.

## Scope

Use the narrowest automated test that covers the regression. Do not run the full Playwright suite merely because it exists. For visual or exploratory verification performed by the agent, use the harness `browser` path instead.
