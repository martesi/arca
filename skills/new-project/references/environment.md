# Environment setup

Make project bootstrap reproducible before depending on local machine state.

1. Inspect the repository for an existing environment contract such as `flake.nix`, devenv, a devcontainer, container config, tool-version files, package-manager metadata, CI setup, or documented bootstrap steps. Reuse it instead of creating a competing path.
2. If the project already uses Nix, or Nix is the selected environment mechanism, encode required runtimes, CLIs, native libraries, browser tooling, and non-secret environment variables in a pinned `devShells.default`. Commit the lockfile. Set up direnv to activate that default shell automatically: commit a `.envrc` using `use flake` (prefer nix-direnv when available) and document the one-time `direnv allow`. Keep unusually heavy GUI/E2E tooling in a separate shell only when that meaningfully reduces the normal development closure.
3. If Nix is not present, do not add it solely to satisfy this skill. Add a concise reproducible setup section to `README.md`, `CONTRIBUTING.md`, or the repository's existing development documentation. Include:
   - supported OS/system dependencies;
   - exact runtime/tool versions or the committed source that pins them;
   - install/bootstrap commands;
   - development, check, test, and build commands;
   - required environment variable names without secret values;
   - browser/native dependency setup when relevant.
4. Commit package lockfiles and existing version-manager or container metadata. Do not introduce a second version manager merely for redundancy.
5. Verify the documented bootstrap path and the smallest project check. Avoid user-specific absolute paths or undocumented host assumptions.

For browser or GUI work, provide the browser/runtime and any required font, display, or library configuration through the reproducible environment rather than assuming the host already has them.
