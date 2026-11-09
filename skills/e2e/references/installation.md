# Harness installation patterns

Use only the sections matching the repository.

## Project config

The reusable browser harness reads `.config/arca.toml` from the project root. Override it with `--config` or `E2E_CONFIG`.

All sections are optional. Omit a section to leave that feature unused. Empty tables mean "use this feature with defaults"; boolean sentinels such as `display = false`, `cookies = false`, or `userscript = false` are not part of the schema.

```toml
# Defaults shown below. Only write values the project needs to change.
cacheDir = ".cache/arca"
playwrightDir = ".cache/arca/playwright"
tempDir = ".cache/arca/tmp" # task-scoped TMPDIR/BUN_TMPDIR/Playwright scratch

# Optional page opened after bootstrap.
targetUrl = "https://example.com/"

# Optional command prefix for browser/Xvfb tools.
[shell]
command = ["nix", "develop", ".#e2e", "--command"]
# executable = "firefox" # defaults to the selected browser

# Optional managed virtual display. Omit [display] when no managed display is needed.
[display]
value = ":99"       # default: $DISPLAY, otherwise :99
timeout = 5000

# Zero or more project processes the harness keeps alive.
[[dev]]
command = ["bun", "run", "dev", "--", "--port", "5173"]
ready = ["http://127.0.0.1:5173/"]
timeout = 120000

[dev.env]
NODE_ENV = "development"

# For a Go CLI, replace the example command/readiness pair with:
# command = ["go", "run", "./cmd/project-graph", "serve"]
# ready = ["http://127.0.0.1:8787/api/graph"]
# A Go CLI must name its long-running `serve` subcommand. Keep readiness on an
# API endpoint, not on the document root, so a partially started server is not
# mistaken for a ready test target.

# The default browser profile exists implicitly even when this table is absent.
[profile.default]
browser = "firefox" # default; use "chromium" for the existing CDP/extension path
dataDir = ".cache/arca/browser/default"
# executable = "/path/to/firefox"   # otherwise [shell].executable / PATH
extensions = []
args = []
headed = false
port = 2000
idleTimeout = 300000

# Named profiles inherit profile.default startup settings, but get their own
# derived dataDir unless dataDir is explicitly set.
[profile.mobile]
dataDir = ".cache/arca/browser/mobile"
args = ["--window-size=390,844"]
# port = 2001

# Browser selection can also be supplied for one run:
# node .agents/skills/e2e/scripts/harness.ts playwright --browser chromium \
#   --executable /nix/store/.../bin/chromium -- test

# Optional per-profile cookie bootstrap. Cookie tables belong to one profile;
# unlike browser startup settings, they are not inherited by named profiles.
[profile.default.cookies]
# file = "cookies.json"              # omitted = normal cookie auto-discovery
required = false

[profile.mobile.cookies]
file = "mobile-cookies.json"

# Optional manually supplied userscript-manager bootstrap.
[userscript]
# installUrl = "http://127.0.0.1:5173/dev.user.js"
# manager = "scriptcat"
# managerName = "ScriptCat"
# installOnStart = true               # default true when installUrl exists
# enableUserScripts = true            # default true when manager exists
confirmationTimeout = 30000

# ScriptCat works on Firefox and Chromium; pins are browser-specific.
[[plugins]]
name = "userscript"
url = "http://127.0.0.1:5173/dev.user.js"
# version = "0.16.15"                # omitted = latest for the selected browser

[[plugins]]
name = "disable-csp"                 # Chromium only
```

The top-level `[cookies]` table remains supported as a fallback for profiles without their own cookie table.

Derived cache layout:

```text
.cache/arca/
├── browser/<profile>/
├── playwright/<profile>/<session>/
├── tmp/<profile>/<session>/
├── runtime/
├── extensions/
└── scriptcat/
```

`cacheDir`, `playwrightDir`, and each profile's `dataDir` can be overridden.

## Profiles and sessions

A **profile** defines browser launch/state requirements: data directory, executable, extensions, startup arguments, headed/headless mode, endpoint port, and idle timeout.

A **session** isolates one control task inside that browser. Sessions do not create another browser process or another user-data directory. Internal Playwright CLI session names include the profile name, so using the same task/session name in development and release profiles cannot attach to the other profile. Multiple sessions using the same profile share the same browser process and persistent browser state.

Use another profile only when browser startup or persistent state must differ.

```sh
node .agents/skills/e2e/scripts/harness.ts browser --session task-a -- snapshot
node .agents/skills/e2e/scripts/harness.ts browser --profile mobile --session task-b -- snapshot
```

Firefox exposes a Playwright WebSocket endpoint on port `2000` by default. Chromium keeps its CDP endpoint at `http://127.0.0.1:2000`. Simultaneously active profiles need distinct ports, configured on the profile or supplied with `--port`.

CLI launch overrides are applied after profile configuration:

```sh
node .agents/skills/e2e/scripts/harness.ts browser --profile mobile --session review-a --port 2100 --browser-arg --disable-features=LocalNetworkAccessChecks -- snapshot
```

## Dev processes

Each `[[dev]]` is independent. The harness does not assign its application port; the command chooses it. Add as many entries as needed:

```toml
[[dev]]
command = ["bun", "run", "web", "--", "--port", "3000"]
ready = ["http://127.0.0.1:3000/"]

[[dev]]
command = ["bun", "run", "api", "--", "--port", "4000"]
ready = ["http://127.0.0.1:4000/health"]
```

The harness starts an entry only when its readiness URLs are not already reachable, keeps owned processes alive while needed, and stops only processes it owns.

## Playwright Test

The harness can run the project's Playwright Test CLI directly against its managed browser:

```sh
node .agents/skills/e2e/scripts/harness.ts playwright --profile default --session e2e -- test
```

The consuming project must provide `@playwright/test` and select `browserName: 'firefox'`. For Firefox, the harness injects `PW_TEST_CONNECT_WS_ENDPOINT` (used by Playwright Test automatically) and `E2E_HARNESS_WS_ENDPOINT`. Chromium profiles retain `PLAYWRIGHT_CDP_ENDPOINT` and `E2E_HARNESS_CDP_ENDPOINT`. Playwright tests and configuration remain project-owned. Harness Playwright CLI artifacts are stored under `.cache/arca/playwright/<profile>/<session>/`.

Prefer Playwright's managed browser when extensions, persistent browser state, or external CDP ownership are not required.

## Userscripts and extensions

The `userscript` plugin supports both Firefox and Chromium. Firefox downloads the signed ScriptCat XPI from Mozilla Add-ons, verifies its published SHA-256, and loads it into the owned persistent profile. The harness opens ScriptCat's installation UI and verifies its success receipt before exposing the browser endpoint. Firefox's remote automation requires `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` for extension pages; the owner sets it only for this plugin. Chrome's Allow User Scripts setup does not apply to Firefox.

Select `browser = "chromium"` for unpacked extensions or `disable-csp`. ScriptCat versions differ between the Mozilla and Chrome channels; pin a version published for the selected browser.

The `userscript` plugin downloads/caches ScriptCat under `.cache/arca/scriptcat/` and installs the declared `.user.js` URL. Chromium also needs Allow User Scripts, which the plugin enables. `disable-csp` is cached under `.cache/arca/extensions/`.

Ordinary Chromium extensions can load in new headless Chromium, so extensions do not force `headed = true`. Set `headed = true` only for visual work or an extension/userscript manager whose runtime behavior actually requires a display.

Use `[userscript]` only when intentionally testing a pre-supplied manager instead of the `userscript` plugin.

## Commands

```sh
node .agents/skills/e2e/scripts/harness.ts start --profile default --session task-a
node .agents/skills/e2e/scripts/harness.ts browser --profile default --session task-a -- snapshot
node .agents/skills/e2e/scripts/harness.ts playwright --profile default --session regression -- test
node .agents/skills/e2e/scripts/harness.ts cookies --profile default --session task-a
node .agents/skills/e2e/scripts/harness.ts install-userscript --profile default --session task-a
node .agents/skills/e2e/scripts/harness.ts enable-user-scripts --profile default --session task-a
node .agents/skills/e2e/scripts/harness.ts stop --profile default
```

Cookie values are never emitted while importing authentication state.

## Ignore rules

```gitignore
.cache/arca/
cookies.json
cookies*.txt
```

Do not ignore broad directories that may contain source-controlled fixtures.
