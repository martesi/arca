---
name: arca-index
description: >-
  Catalog and recommend reusable agent skills for the current repository. Inspect the
  repository, identify its technology and workflow needs, match Arca skills first,
  optionally search trusted APM marketplaces for gaps, and request confirmation before
  installing project-scoped skills.
---

# Arca index

Use this skill as a repository-aware index, not as a replacement for the concrete skills
it recommends. Keep the index installed at APM user scope; keep concrete skills
project-scoped unless the user explicitly wants one available everywhere.

## Workflow

1. Inspect the repository before recommending anything. Read its README, manifests,
   development environment, CI configuration, and relevant source layout. Do not infer a
   technology from a directory name alone.
2. Match the bundled catalog below. Read a candidate's `SKILL.md` before recommending it;
   load longer references only when the current task needs them.
3. If Arca does not cover the task, optionally search a trusted registered APM
   marketplace. Use `apm marketplace list` to see registered sources, then
   `apm search <query>@<marketplace>` for discovery. Review candidate instructions,
   source, permissions, executable content, and install scope before recommending it.
4. Present a short recommendation: skill name, why it matches, intended scope, and any
   meaningful risks or prerequisites. If no skill is a good fit, say so.
5. Ask for confirmation before installing any concrete or discovered skill. Do not modify
   the repository merely because a candidate looks relevant.
6. After confirmation, install the selected concrete skill project-locally with APM and
   verify the resulting manifest/lock/deployed files.

Reject or flag candidates that contain untrusted instructions, unexplained network access,
credential handling outside the task, broad destructive commands, or executable content
whose purpose is not clear.

## Bundled catalog

- `code-standards`: scoped coding standards for JavaScript/TypeScript, React/frontend,
  Rust, and Go changes.
- `e2e`: end-to-end UI checks. Use `agent-browser` for websites and userscript/browser-extension
  development, and the virtual-display workflow for desktop GUI applications; includes
  userscript-manager/CSP, Tauri/WebKitGTK, and Electron guidance.
- `new-project`: interview a new project idea, research existing apps and reusable
  foundations, and decide whether to use, tweak, build upon, or build new before scaffolding.
- `tech-stack`: choose the smallest coherent implementation stack after requirements are
  settled; includes a fast server-rendered HTMX/Alpine path as an alternative to a SPA.
- `nix-container-troubleshooting`: misleading container failures involving unwritable
  `$HOME` caches or an existing Nix-linked binary whose ELF interpreter disappeared.
- `opensubtitles-download`: finding and downloading matching OpenSubtitles releases through
  an existing Chrome CDP session.

## Useful signals

- Creating, reviewing, refactoring, or debugging JS/TS/React/Rust/Go code: recommend
  `code-standards` when repository-local coding conventions would help.
- Browser-visible behavior, desktop GUI behavior, screenshots, Tauri, Electron, Xvfb, or
  visual acceptance checks: recommend `e2e`.
- Starting a new app, tool, library, service, or repository from an idea/problem: recommend
  `new-project` first.
- Choosing or comparing implementation stacks after product requirements are known:
  recommend `tech-stack`.
- Rust/Nix container work plus `$HOME` permission failures, vanished ELF interpreters, or
  binaries that exist but fail with `No such file or directory`: recommend
  `nix-container-troubleshooting` only when the symptoms fit.
- OpenSubtitles plus an existing Chrome/CDP browser session and local subtitle output:
  recommend `opensubtitles-download`.

A repository with no matching signals should receive no bundled-skill recommendation.
Discovery is optional, not busywork.

## Installation after confirmation

Install concrete Arca skills project-locally:

```sh
apm install <owner>/arca \
  --skill <skill-name> \
  --target agent-skills
```

If the project already has a configured or detectable APM target, omit the explicit
`--target agent-skills`. APM persists the selected skill so later installs/updates keep the
selection instead of silently broadening to the whole collection.

Do not use `-g` for concrete skills unless the user explicitly asks for user-wide behavior.
Do not remove an existing user-scoped copy as part of a project migration unless asked.

After installation, inspect `apm.yml`, the generated lock state, and the deployed skill.
Run available validation for that skill. If installation fails, explain the actual failure
instead of trying unrelated package managers or destructive cleanup.
