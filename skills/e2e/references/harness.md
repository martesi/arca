# E2E harness

Install the smallest stable harness the repository actually needs. Keep generic lifecycle plumbing separate from application-specific test behavior.

## Boundary

The reusable harness owns:

- `.config/arca.toml` parsing and project-local defaults;
- Firefox/Playwright and Chromium/CDP lifecycle and idle cleanup;
- browser profiles and Playwright CLI sessions;
- optional Xvfb and project dev-process ownership;
- cookie import and userscript/extension bootstrap;
- reusable cache/state under `.cache/arca/`;
- dedicated Nix E2E shells and platform/runtime setup.

Keep these project-local:

- target URLs and accounts;
- selectors, assertions, fixtures, and acceptance criteria;
- product-specific navigation and settings manipulation;
- Playwright Test files/configuration and product-specific helpers.

## Profiles versus sessions

Profiles are browser launch/state configurations. A profile owns one persistent data directory and one managed browser process.

Sessions are task/control isolation inside that browser. Different sessions using the same profile attach to the same browser endpoint; they do not clone browser state.

```text
profile default
  Firefox on :2000 (default), or Chromium/CDP
  .cache/arca/browser/default/
  ├── session task-a
  ├── session task-b
  └── session regression
```

Create another profile only when executable, extensions, startup args, headed mode, port, or persistent browser state must differ.

## Runtime contract

Run the installed harness directly:

```sh
node .agents/skills/e2e/scripts/harness.ts start --session task-a
node .agents/skills/e2e/scripts/harness.ts browser --session task-a -- snapshot
node .agents/skills/e2e/scripts/harness.ts browser --profile mobile --session task-b -- snapshot
node .agents/skills/e2e/scripts/harness.ts playwright -- test
node .agents/skills/e2e/scripts/harness.ts playwright --profile anonymous --no-cookies -- test --grep-invert @auth
node .agents/skills/e2e/scripts/harness.ts stop
```

Config precedence is `--config`, then `E2E_CONFIG`, then project `.config/arca.toml`.

The default profile uses:

```text
browser:      firefox
dataDir:      .cache/arca/browser/default
headed:       false
port:         2000
idleTimeout:  300000 ms
```

Playwright CLI output is kept under `.cache/arca/playwright/<profile>/<session>/`. Runtime PIDs/logs live under `.cache/arca/runtime/`.

The harness does not expose its internal Playwright CLI driver as project configuration. The `playwright` command runs the consuming project's `@playwright/test` CLI against the managed browser and injects its connection endpoint. Product tests, configuration, and helpers remain project-owned.

Every managed session gets a writable task directory under `tempDir` (default
`.cache/arca/tmp/<profile>/<session>`). The harness passes that directory as
`TMPDIR`, `TMP`, `TEMP`, and `E2E_HARNESS_TEMP_DIR`, with dedicated
`BUN_TMPDIR` and `PLAYWRIGHT_TMPDIR` children. This keeps Bun and Playwright
scratch files out of read-only system temporary mounts. The same environment is
used for dev processes and Playwright Test; `[dev.env]` values are forwarded to
the Playwright process so an MCP child can inherit the server contract.

For Project Graph-style applications, `PROJECT_GRAPH_DB` and
`PROJECT_GRAPH_E2E_DB` are checked when both are present. A mismatch fails with
an `E2E database failure` before startup, and the database parent directory must
be writable. The harness never deletes or replaces a database; the consuming
Playwright config owns fresh-database creation and must pass the resulting path
to both the HTTP server and the real stdio MCP child.

## Browser startup

`[shell]` is optional. When configured, `shell.command` prefixes launched browser/display tools and `shell.executable` names the selected browser inside that environment. Firefox is the default; set `[profile.<name>].browser = "chromium"` to retain the Chromium/CDP path. A profile's own `executable` overrides the shell executable.

The `userscript` plugin installs ScriptCat on Firefox and Chromium. Unpacked extensions and `disable-csp` require a Chromium profile. Extension loading does not automatically make that profile headed. The harness uses `--headless=new` when `headed = false` on Chromium, including when extensions are loaded. Set `headed = true` only for visual work or a runtime that actually requires it.

Browser choice is explicit: set `profile.<name>.browser`, use
`E2E_HARNESS_BROWSER`, or pass `--browser firefox|chromium`. Set
`profile.<name>.executable`, the matching `PLAYWRIGHT_*_EXECUTABLE`, or pass
`--executable path` for a runtime override. A missing executable or shell
launcher is an error identifying the selected browser; the harness does not
fall back to another browser.

## Dev processes

Each `[[dev]]` contains its own command and readiness URLs. The command chooses its port; there is no shared dev-server port in the harness schema.
Use `timeout` for compilation-heavy commands such as `go run`, and include the
required CLI subcommand (for example `serve`). Readiness should be an API
contract such as `/api/graph` or `/api/health`.

The harness starts only entries that are not already ready, records their PIDs, and stops only processes it owns.

## Playwright Test

Run Playwright Test through the harness when it needs the managed browser:

```sh
node .agents/skills/e2e/scripts/harness.ts playwright --profile default --session regression -- test
```

For Firefox, the harness injects `PW_TEST_CONNECT_WS_ENDPOINT` and `E2E_HARNESS_WS_ENDPOINT`; Playwright Test connects automatically with `browserName: 'firefox'`. Chromium retains `PLAYWRIGHT_CDP_ENDPOINT` and `E2E_HARNESS_CDP_ENDPOINT`.

Use `--no-cookies` with a dedicated profile when a test does not require authentication. This clears browser cookies and skips that profile's configured cookie import; use a dedicated profile as well so other persistent browser state stays isolated from authenticated coverage.

## State and secrets

Keep `.cache/arca/` and cookie exports ignored. Never print cookie values or commit browser profiles containing authenticated state.

`assets/browser/cookie-loader.ts` provides cookie parsing. `assets/browser/runtime.ts` provides owned process/Xvfb/readiness primitives. `assets/browser/cdp-runtime.ts` provides Chromium/CDP reuse and cleanup. `assets/browser/firefox-runtime.ts` launches stock Firefox using Playwright's `moz-firefox` channel and binds its persistent browser for shared sessions.

## Nix projects

Use a sibling `devShells.e2e` instead of bloating the default shell. Reuse existing common packages/hooks, add only the E2E-only closure, and use nixpkgs Firefox with the harness's `moz-firefox` path when foreign browser binaries are troublesome. Keep nixpkgs Chromium for explicit Chromium profiles.

## Verification

A harness change is complete only when:

- profile/session isolation behaves as documented;
- start/stop leaves unrelated processes untouched;
- generated state and credentials stay ignored;
- type/lint/syntax checks pass;
- a representative browser bootstrap/readiness/cleanup path succeeds;
- a consuming repository can execute its real product E2E workflow.
