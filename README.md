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
- [`code-standards`](skills/code-standards/SKILL.md) — apply scoped JavaScript,
  TypeScript, React/frontend, Rust, and Go coding standards.
- [`e2e`](skills/e2e/SKILL.md) — choose and run end-to-end checks for websites and
  desktop GUI applications, including Xvfb/Tauri/Electron workflows.
- [`img-sheet-character`](skills/img-sheet-character/SKILL.md) — generate an explicit-invocation
  orthographic character reference sheet from one or more references.
- [`img-sheet-character-compose`](skills/img-sheet-character-compose/SKILL.md) — generate an
  explicit-invocation character turnaround anchored to the first reference's pose.
- [`img-sheet-object`](skills/img-sheet-object/SKILL.md) — combine all distinct referenced items
  into one dense, explicit-invocation object sheet.
- [`new-project`](skills/new-project/SKILL.md) — grill product and architecture decisions,
  establish a reproducible environment, then choose and scaffold a lean stack.
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

Before publishing changes:

```sh
apm pack --dry-run --verbose
```

Also validate each changed skill with the available skill validator/linter for the host
environment. Generated APM lockfiles are tool-owned; do not hand-edit them.
