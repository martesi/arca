# arca

`arca` is a collection of reusable agent skills plus a repository-aware index that
recommends which concrete skills a project should install.

The intended split is simple:

- install `arca-index` once at APM user scope;
- keep concrete skills project-scoped by default;
- let APM own installation, updates, lock state, and deployment into `.agents/skills/` on the consumer side.

## Install the global index

```sh
apm install -g <owner>/arca \
  --skill arca-index \
  --target agent-skills
```

This records the dependency in APM's user scope under `~/.apm/` and deploys the index to
the converged user skill directory. Arca itself does not need a root `apm.yml` merely
to publish `skills/`; the manifest belongs to the consumer scope unless this repository
itself gains package dependencies or other APM package metadata. Replace `<owner>` with the
repository owner once a remote is configured.

Update user-scoped packages with:

```sh
apm update -g
```

## Install a concrete skill in a project

After `arca-index` recommends a skill and you confirm it, install only that skill in
the project:

```sh
apm install <owner>/arca \
  --skill e2e \
  --target agent-skills
```

If the project already has an APM target configured or detectable, the explicit
`--target agent-skills` can be omitted. APM persists the selected skill in the project's
`apm.yml` and lockfile, so later `apm install`/`apm update` reproduces the selection.

Concrete skills stay project-scoped by default. Install one with `-g` only when you
explicitly want its behavior available across repositories.

## Skills

- [`arca-index`](skills/arca-index/SKILL.md) — inspect a repository and
  recommend relevant Arca or discovered skills before installation.
- [`code-standards`](skills/code-standards/SKILL.md) — apply shared coding standards
  across languages, with scoped references for JavaScript, TypeScript,
  React/frontend, Rust, and Go.
- [`e2e`](skills/e2e/SKILL.md) — choose, run, and diagnose end-to-end checks, and install
  or repair reusable browser, Playwright, userscript, desktop, and Nix E2E infrastructure.
- [`img-sheet-character`](skills/img-sheet-character/SKILL.md) — generate an explicit-invocation
  orthographic character reference sheet from one or more references.
- [`img-sheet-character-compose`](skills/img-sheet-character-compose/SKILL.md) — generate an
  explicit-invocation character turnaround anchored to the first reference's pose.
- [`img-sheet-object`](skills/img-sheet-object/SKILL.md) — combine all distinct referenced items
  into one dense, explicit-invocation object sheet.
- [`new-project`](skills/new-project/SKILL.md) — interview the project idea, research existing
  solutions, and choose the least-build path before scaffolding.
- [`tech-stack`](skills/tech-stack/SKILL.md) — choose the smallest coherent implementation
  stack, including the fast SSR/HTMX/Alpine option used by Nimbus-style server-owned UIs.
- [`nix-container-troubleshooting`](skills/nix-container-troubleshooting/SKILL.md) —
  diagnose misleading container failures involving unwritable `$HOME` caches and missing
  Nix ELF interpreters.
- [`opensubtitles-download`](skills/opensubtitles-download/SKILL.md) — download matched
  subtitle releases through an existing Chrome CDP session.
- [`trans`](skills/trans/SKILL.md) — concise English/Mandarin translation and bilingual handling for
  other source languages, with optional linguistic enrichment disclosed through Cita.

The `img-sheet-*` skills are intentionally excluded from implicit invocation in their
OpenAI manifests; invoke them explicitly by skill name.

## Repository layout

```text
arca/
├── README.md
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

Root-level `skills/` is intentionally the package source. Do not add an `.apm/` source
tree alongside it unless all publishable primitives are migrated there: when `.apm/`
exists, APM treats it as authoritative and skips root-level primitive directories.

## Maintaining the collection

Reusable skills currently used from the shared `.agents/skills` collection should be
synced back into `skills/` when they improve. Repository-specific context skills should
remain with their repository instead of being copied here.

The repository uses Bun for development and verification:

The harness tests require Chromium on `PATH` (or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`).
Default browser lifecycle checks use Chromium; the Firefox tests select Firefox
explicitly and require `PLAYWRIGHT_FIREFOX_EXECUTABLE`.

For a consumer project, Chromium is the supported default when its runtime is
available. In a Nix or slim environment, declare `pkgs.chromium` in the
project's `devShells.e2e` and export `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; use
`profile.<name>.browser = "firefox"` plus `PLAYWRIGHT_FIREFOX_EXECUTABLE` only
when the Firefox/BiDi path is explicitly selected. The harness reports missing
browser dependencies instead of falling back to another engine. It also gives
each session writable `TMPDIR` and
`BUN_TMPDIR` paths; use the documented `E2E_HARNESS_TEMP_DIR` before `bun
install` when the system temp mount is read-only.

### Playwright version pin

Keep `playwright` pinned to `1.64.0-alpha-1789764292000` in `skills/e2e/package.json`
until a newer pair is verified with `bun test tests/firefox.test.mjs`. The
`1.65.0-alpha-2026-10-30` bump breaks the `userscript` plugin when
`profile.<name>.browser = "firefox"` is selected: that alpha targets Firefox 158
(revision 1569) but sends BiDi commands Firefox
does not implement, and with Firefox 160 the BiDi evaluation of ScriptCat's
options page stalls. The install then times out waiting for "Installed Scripts".
With the pinned Playwright version and Firefox 156, both Firefox tests pass.

The same failure class is tracked upstream in
[microsoft/playwright#44036](https://github.com/microsoft/playwright/issues/44036)
(the `emulation.setMediaFeaturesOverride` command added by
[PR #43668](https://github.com/microsoft/playwright/pull/43668) is not
implemented by older BiDi builds) and
[#43644](https://github.com/microsoft/playwright/issues/43644)
(Firefox BiDi execution-context lifecycle). Both reports were open at the time
of this pin.

### ScriptCat version

Chromium uses the latest ScriptCat Chrome release by default. The Firefox
userscript test stays pinned to ScriptCat `0.16.15`, the last MV2 release.
ScriptCat `1.5.2` is MV3: it installs through the worker message API, but its
userscripts do not execute on the Firefox build this harness uses. Leave the
Firefox pin in place until the browser/ScriptCat pair is verified together.

```sh
export E2E_HARNESS_TEMP_DIR="${E2E_HARNESS_TEMP_DIR:-$PWD/.cache/arca/tmp/install}"
mkdir -p "$E2E_HARNESS_TEMP_DIR/bun"
TMPDIR="$E2E_HARNESS_TEMP_DIR" BUN_TMPDIR="$E2E_HARNESS_TEMP_DIR/bun" bun install
bun run check
```

Before publishing changes:

```sh
apm pack --dry-run --verbose
```

Also validate each changed skill with the available skill validator/linter for the host
environment. Generated APM lockfiles are tool-owned; do not hand-edit them.
