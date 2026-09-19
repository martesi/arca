# Harness installation patterns

Use only the sections matching the repository.

## 1. Automated browser / Playwright

Prefer project-owned Playwright configuration and Playwright's `webServer` when the suite
owns a normal web dev server. Use the harness `playwright` command when the run needs a
repo-declared Chromium, extensions, a persistent profile, or a stable CDP lifecycle. Keep
application-specific build servers local when startup requires product fixtures or special
binaries.

Recommended shape:

```text
playwright.config.*
e2e/playwright/        # tests and project-specific helpers
.browser-state/        # ignored browser state when a persistent browser is required
.cache/e2e/            # ignored reports/results/temp files
```

The harness command starts one Playwright-owned Chromium per instance and exposes its CDP
endpoint as `PLAYWRIGHT_CDP_ENDPOINT` and `E2E_HARNESS_CDP_ENDPOINT`:

```sh
node .agents/skills/e2e/scripts/harness.ts playwright -- test
node .agents/skills/e2e/scripts/harness.ts playwright --instance shard-2 -- test smoke.spec.ts
```

The project Playwright fixture connects to that endpoint and creates the contexts/pages it
needs. Prefer Playwright's managed browser when no external lifecycle is required.

Do not reuse the agent-browser profile from Playwright. If both paths consume the same
cookie export, parse/import it independently.

## 2. Agent-driven browser harness

Use `scripts/harness.ts` as the executable harness. The repository should not own a second
bootstrap implementation merely to launch agent-browser, import cookies, set environment
variables, or install a userscript.

Default config path: `e2e.toml` at the project root inferred from either the source
`skills/e2e` layout or deployed `.agents/skills/e2e` layout. Config
precedence is `--config`, then `E2E_CONFIG`, then the inferred path.

```toml
targetUrl = "https://example.com/"

# Optional: add this only when the harness must enter a dev shell.
[shell]
command = ["nix", "develop", ".#e2e", "--command"]
chromium = "chromium"

[[dev]]
command = ["bun", "run", "dev"]
readyUrls = ["http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js"]

[agent]
session = "my-project"
profile = ".browser-state/agent"
extensions = ["/path/to/userscript-manager"]
args = ["--disable-features=LocalNetworkAccessChecks"]
port = 0
idleTimeout = 300000

[playwright]
profile = ".browser-state/playwright"
port = 0
idleTimeout = 300000

[cookies]
required = true

[userscript]
manager = "violentmonkey"
installUrl = "http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js"
```

Agent settings can also come from the current environment:
`AGENT_BROWSER_SESSION`, `AGENT_BROWSER_PROFILE`,
`AGENT_BROWSER_EXECUTABLE_PATH`, `AGENT_BROWSER_EXTENSIONS`, and
`AGENT_BROWSER_SCREENSHOT_DIR`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` supplies the
Playwright-owned Chromium. Config values take precedence.

The config contains only local facts: readiness URLs/dev commands, target URLs, extension
paths, required browser arguments, and optional cookie-source selection. Product selectors,
assertions, fixtures, and navigation beyond bootstrap remain local test behavior.

Run it with Node from the installed skill:

```sh
node .agents/skills/e2e/scripts/harness.ts browser -- snapshot
node .agents/skills/e2e/scripts/harness.ts browser --instance worker-b -- snapshot
node .agents/skills/e2e/scripts/harness.ts stop
```

The first `browser` command starts Chromium when needed, then subsequent commands reuse it.
The harness injects agent-browser environment values, owns its runtime PIDs, preserves the
persistent profile, imports cookies, enables the userscript-manager permission when
configured, confirms Violentmonkey or ScriptCat installation flows, and stops only its
owned browser after the configured idle timeout.

## 3. Userscript / extension projects

Use distinct profiles:

```text
.browser-state/agent
.browser-state/playwright
.browser-state/agent/<instance>
.browser-state/playwright/<instance>
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
Netscape exports. Use `assets/browser/cookie-loader.ts` rather than maintaining separate
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
