# E2E harness

Install the smallest stable harness the repository actually needs. Keep generic lifecycle plumbing separate from application-specific test behavior.

## Boundary

The reusable harness owns:

- `.config/arca.toml` parsing and project-local defaults;
- Chromium/CDP lifecycle and idle cleanup;
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

Profiles are browser launch/state configurations. A profile owns one persistent data directory and one managed Chromium process.

Sessions are task/control isolation inside that browser. Different sessions using the same profile attach to the same Chromium/CDP endpoint; they do not clone browser state.

```text
profile default
  Chromium on :2000
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
node .agents/skills/e2e/scripts/harness.ts stop
```

Config precedence is `--config`, then `E2E_CONFIG`, then project `.config/arca.toml`.

The default profile uses:

```text
dataDir:      .cache/arca/browser/default
headed:       false
port:         2000
idleTimeout:  300000 ms
```

Playwright CLI output is kept under `.cache/arca/playwright/<profile>/<session>/`. Runtime PIDs/logs live under `.cache/arca/runtime/`.

The harness does not expose its internal Playwright CLI driver as project configuration. It also does not wrap the project's Playwright Test runner. Automated suites remain normal project commands and may connect to the managed browser's stable CDP endpoint when needed. `start` keeps that browser alive until explicit `stop`; the idle timeout applies to one-shot harness browser activity, not an explicitly started external test runtime.

## Browser startup

`[shell]` is optional. When configured, `shell.command` prefixes launched browser/display tools and `shell.executable` names Chromium inside that environment. A profile's own `executable` overrides the shell executable.

Extension loading does not automatically make a profile headed. The harness uses `--headless=new` when `headed = false`, including when extensions are loaded. Set `headed = true` only for visual work or a runtime that actually requires it.

## Dev processes

Each `[[dev]]` contains its own command and readiness URLs. The command chooses its port; there is no shared dev-server port in the harness schema.

The harness starts only entries that are not already ready, records their PIDs, and stops only processes it owns.

## Playwright Test

Use the project's own test command. When it needs the harness browser:

```sh
node .agents/skills/e2e/scripts/harness.ts start --session regression
PLAYWRIGHT_CDP_ENDPOINT=http://127.0.0.1:2000 bunx playwright test
node .agents/skills/e2e/scripts/harness.ts stop
```

If the project uses a named profile, use that profile's configured port.

## State and secrets

Keep `.cache/arca/` and cookie exports ignored. Never print cookie values or commit browser profiles containing authenticated state.

`assets/browser/cookie-loader.ts` provides cookie parsing. `assets/browser/runtime.ts` provides owned process/Xvfb/readiness primitives. `assets/browser/cdp-runtime.ts` provides Chromium/CDP reuse and cleanup.

## Nix projects

Use a sibling `devShells.e2e` instead of bloating the default shell. Reuse existing common packages/hooks, add only the E2E-only closure, and prefer nixpkgs Chromium when foreign browser binaries are troublesome.

## Verification

A harness change is complete only when:

- profile/session isolation behaves as documented;
- start/stop leaves unrelated processes untouched;
- generated state and credentials stay ignored;
- type/lint/syntax checks pass;
- a representative browser bootstrap/readiness/cleanup path succeeds;
- a consuming repository can execute its real product E2E workflow.
