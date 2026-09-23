# Harness installation patterns

Use only the sections matching the repository.

## Project config

The reusable browser harness reads `.config/arca.toml` from the project root. Override it with `--config` or `E2E_CONFIG`.

All sections are optional. Omit a section to leave that feature unused. Empty tables mean "use this feature with defaults"; boolean sentinels such as `display = false`, `cookies = false`, or `userscript = false` are not part of the schema.

```toml
# Defaults shown below. Only write values the project needs to change.
cacheDir = ".cache/arca"
playwrightDir = ".cache/arca/playwright"

# Optional page opened after bootstrap.
targetUrl = "https://example.com/"

# Optional command prefix for Chromium/Xvfb tools.
[shell]
command = ["nix", "develop", ".#e2e", "--command"]
executable = "chromium"

# Optional managed virtual display. Omit [display] when no managed display is needed.
[display]
value = ":99"       # default: $DISPLAY, otherwise :99
timeout = 5000

# Zero or more project processes the harness keeps alive.
[[dev]]
command = ["bun", "run", "dev", "--", "--port", "5173"]
ready = ["http://127.0.0.1:5173/"]

[dev.env]
NODE_ENV = "development"

# The default browser profile exists implicitly even when this table is absent.
[profile.default]
dataDir = ".cache/arca/browser/default"
# executable = "/path/to/chromium"   # otherwise [shell].executable / PATH
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

[[plugins]]
name = "userscript"
url = "http://127.0.0.1:5173/dev.user.js"
# version = "1.4.0"                  # omitted = latest ScriptCat

[[plugins]]
name = "disable-csp"
```

The top-level `[cookies]` table remains supported as a fallback for profiles without their own cookie table.

Derived cache layout:

```text
.cache/arca/
├── browser/<profile>/
├── playwright/<profile>/<session>/
├── runtime/
├── extensions/
└── scriptcat/
```

`cacheDir`, `playwrightDir`, and each profile's `dataDir` can be overridden.

## Profiles and sessions

A **profile** defines Chromium launch/state requirements: data directory, executable, extensions, startup arguments, headed/headless mode, CDP port, and idle timeout.

A **session** isolates one control task inside that browser. Sessions do not create another Chromium process or another user-data directory. Multiple sessions using the same profile share the same browser process and persistent browser state.

Use another profile only when browser startup or persistent state must differ.

```sh
node .agents/skills/e2e/scripts/harness.ts browser --session task-a -- snapshot
node .agents/skills/e2e/scripts/harness.ts browser --profile mobile --session task-b -- snapshot
```

The default CDP endpoint is `http://127.0.0.1:2000`. Simultaneously active profiles need distinct ports, configured on the profile or supplied with `--port`.

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

The harness can run the project's Playwright Test CLI directly against its managed Chromium:

```sh
node .agents/skills/e2e/scripts/harness.ts playwright --profile default --session e2e -- test
```

The consuming project must provide `@playwright/test`. The harness injects `PLAYWRIGHT_CDP_ENDPOINT` and `E2E_HARNESS_CDP_ENDPOINT`, while Playwright tests and configuration remain project-owned. Harness Playwright CLI artifacts are stored under `.cache/arca/playwright/<profile>/<session>/`.

Prefer Playwright's managed browser when extensions, persistent browser state, or external CDP ownership are not required.

## Userscripts and extensions

The `userscript` plugin downloads/caches ScriptCat under `.cache/arca/scriptcat/`, enables Chromium's Allow User Scripts permission, and installs the declared `.user.js` URL. `disable-csp` is cached under `.cache/arca/extensions/`.

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
