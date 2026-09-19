# Harness installation patterns

Use only the sections matching the repository.

## 1. Automated browser / Playwright

Prefer project-owned Playwright configuration and Playwright's `webServer` when the suite
owns a normal web dev server. Keep application-specific build servers local when startup
requires product fixtures or special binaries.

Recommended shape:

```text
playwright.config.*
e2e/playwright/        # tests and project-specific helpers
.browser-state/        # ignored browser state when a persistent browser is required
.cache/e2e/            # ignored reports/results/temp files
```

If a Nix-provided Chromium is required, export a project-neutral executable variable such
as `PLAYWRIGHT_CHROMIUM_EXECUTABLE` and pass it through `launchOptions.executablePath`.
Prefer Playwright's managed browser when it runs cleanly.

Do not reuse the agent-browser profile from Playwright. If both paths consume the same
cookie export, parse/import it independently.

## 2. Agent-driven browser harness

Use `scripts/harness.mjs` as the executable harness. The repository should not own a second
bootstrap implementation merely to launch agent-browser, import cookies, set environment
variables, or install a userscript.

Default config path: `e2e/harness.config.mjs`.

```js
export default {
  dev: {
    command: ['bun', 'run', 'dev'],
    readyUrls: ['http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js'],
  },
  agent: {
    session: 'my-project',
    profile: '.browser-state/agent',
    extensions: [process.env.USERSCRIPT_MANAGER_PATH],
    args: ['--disable-features=LocalNetworkAccessChecks'],
  },
  cookies: { required: true },
  userscript: {
    manager: 'violentmonkey',
    installUrl: 'http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js',
  },
  targetUrl: 'https://example.com/',
}
```

The config contains only local facts: readiness URLs/dev commands, target URLs, extension
paths, required browser arguments, and optional cookie-source selection. Product selectors,
assertions, fixtures, and navigation beyond bootstrap remain local test behavior.

Run it with Bun from the installed skill:

```sh
bun .agents/skills/e2e-harness/scripts/harness.mjs start
bun .agents/skills/e2e-harness/scripts/harness.mjs browser -- snapshot
bun .agents/skills/e2e-harness/scripts/harness.mjs stop
```

The harness injects agent-browser environment values, owns its runtime PIDs, preserves the
persistent profile, imports cookies, enables the userscript-manager permission when
configured, and confirms Violentmonkey or ScriptCat installation flows.

## 3. Userscript / extension projects

Use distinct profiles:

```text
.browser-state/agent
.browser-state/playwright
```

For `vite-plugin-monkey`, the development install endpoint is normally:

```text
http://127.0.0.1:<port>/__vite-plugin-monkey.install.user.js
```

The harness can automate opening that endpoint and confirming the manager UI, but the port,
manager choice, and target-site navigation stay local configuration.

One-time browser permissions such as Chromium's **Allow User Scripts** belong to the
persistent agent profile. Do not delete that profile in normal teardown.

For authentication, prefer `cookies.json`; otherwise accept deliberate `cookies*.txt`
Netscape exports. Use `assets/browser/cookie-loader.mjs` rather than maintaining separate
parsers per project.

## 4. Desktop GUI projects

Provision GUI dependencies in `devShells.e2e`; do not add them to the default shell merely
for tests. The committed harness owns environment availability, not product interactions.
Keep window titles, click coordinates, fixtures, and app-specific startup checks in the
consuming project or in the runtime `e2e` workflow.

If the app also exposes a browser/server mode, keep that server build harness local when it
encodes product fixtures, build tags, generated bindings, or application configuration.
Only the surrounding browser/tool availability belongs here.

## 5. Ignore rules

Add only paths the repository actually creates. Typical entries:

```gitignore
.browser-state/
.cache/e2e/
cookies.json
cookies*.txt
```

Do not ignore broad directories that may contain source-controlled fixtures.
