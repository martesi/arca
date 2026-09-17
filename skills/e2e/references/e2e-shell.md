# Declaring the e2e shell tools

## Why a separate `devShells.e2e`

The GUI closure (Xvfb, imagemagick, mesa) is dead weight for everyday development, which is
most of what the default shell gets used for. Putting these in `devShells.default` makes
every `nix develop` pay for tools that only end-to-end GUI runs touch.

So add a sibling shell instead. This also keeps the capability *in the repo* — anyone who
clones it can run the GUI headlessly without depending on what their machine or container
image happens to preinstall.

## The shell

Add alongside your existing shells, reusing whatever the `let` block already binds:

```nix
devShells.e2e = pkgs.mkShell {
  packages = [
    pkgs.xvfb        # the X server itself
    pkgs.xdpyinfo    # readiness check — see references/driving.md
    pkgs.xdotool     # synthetic mouse/keyboard input
    pkgs.imagemagick # `import` for screenshots
  ] ++ <whatever devShells.default lists>;

  shellHook = ''
    ${commonHook}
    export DISPLAY="''${DISPLAY:-:99}"
  '';
};
```

Factor the hook that `default` already has into a `let` binding (`commonHook`) shared by
both shells rather than copy-pasting it — the two drift otherwise, and the EGL line below
is exactly the kind of thing you do not want present in one shell and missing from the
other.

`imagemagick` is the assumed screenshot tool throughout these docs because `import` needs
no wrapper. `scrot` is a smaller closure if that matters to you; it writes PNG directly
too, so only the command name changes.

## Fonts

A slim container has no `/etc/fonts` and no font files at all. Fontconfig finds nothing,
every toolkit falls back to its last-resort built-in, and text renders as tofu — or the app
aborts outright. The screenshots come out structurally perfect and completely unreadable,
which reads as a rendering bug rather than a missing dependency.

Declare fonts in the same shell:

```nix
export FONTCONFIG_FILE="''${FONTCONFIG_FILE:-${pkgs.makeFontsConf {
  fontDirectories = with pkgs; [ dejavu_fonts liberation_ttf ];
}}}"
```

`makeFontsConf` writes a self-contained config naming those store paths. The environment
variable is not optional: fontconfig's compiled-in default location is
`/etc/fonts/fonts.conf`, which does not exist here, so without it the config is never
found. DejaVu plus Liberation covers Latin; add the `noto-fonts` variants
(`noto-fonts-cjk-sans`, `noto-fonts-color-emoji`) only if the app ships non-Latin catalogs
— they are large.

Verify with `fc-list | wc -l` inside the shell. Zero means you will be screenshotting tofu.

## The EGL fix

**This is the part that is invisible until it bites.** Anything needing a GL context —
every Tauri app, since WebKitGTK requires one — aborts on startup with:

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

or comes up as a blank white window. It reads like an application bug. It is not.

libglvnd looks for vendor ICD json in `/usr/share/glvnd/egl_vendor.d`, which does not exist
on NixOS or in a slim container. With no ICD there is no EGL vendor at all. WebKitGTK
resolves `libEGL` through its own RPATH, so the library is present — only the ICD lookup
fails, which is why this does not look like a missing dependency.

Point glvnd at mesa to get a software (llvmpipe) context:

```nix
export __EGL_VENDOR_LIBRARY_DIRS="''${__EGL_VENDOR_LIBRARY_DIRS:-${pkgs.mesa}/share/glvnd/egl_vendor.d}"
```

Keep the `:-` guard. A real NixOS desktop already exports this to `/run/opengl-driver/...`,
and clobbering it would drop hardware acceleration for e.g. nvidia users.

This one variable is the whole fix. `LIBGL_DRIVERS_PATH`, `LIBGL_ALWAYS_SOFTWARE`,
`GALLIUM_DRIVER=llvmpipe`, `WEBKIT_DISABLE_DMABUF_RENDERER` and extra `LD_LIBRARY_PATH`
entries are **not** needed for this — don't cargo-cult them in while debugging.

## Agent-browser setup

For agent-driven website E2E, keep the browser environment in `devShells.e2e` and make
`test:agent` a thin pass-through to `agent-browser`. A repository can provide stable paths
without making agent-browser a project dependency:

```nix
shellHook = ''
  ${commonHook}
  export AGENT_BROWSER_SESSION="''${AGENT_BROWSER_SESSION:-my-project-agent}"
  export AGENT_BROWSER_PROFILE="''${AGENT_BROWSER_PROFILE:-$PWD/.browser-state/agent}"
  export AGENT_BROWSER_EXECUTABLE_PATH="''${AGENT_BROWSER_EXECUTABLE_PATH:-${pkgs.chromium}/bin/chromium}"
'';
```

Put project-specific extension paths in the same shell when needed. `test:agent:start`
should prepare only the agent-owned runtime (display, dev server, profile/bootstrap), and
`test:agent:stop` should stop only processes that start command owns. Keep the persistent agent
profile after stop when it contains one-time browser/extension permissions.

## Playwright browser setup

For automated browser E2E, prefer Playwright's managed browser when the environment can
run it cleanly. In Nix/slim environments where the downloaded FHS Chromium is the problem,
a repository-declared Chromium is a pragmatic fallback. Add it to `devShells.e2e` and
expose its path to the Playwright config:

```nix
devShells.e2e = pkgs.mkShell {
  packages = [
    pkgs.chromium
    # desktop-only tools such as xvfb/xdotool may stay here too
  ] ++ devPackages;

  shellHook = ''
    ${commonHook}
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE="''${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-${pkgs.chromium}/bin/chromium}"
  '';
};
```

Then let `playwright.config.js` pass that value as `use.launchOptions.executablePath`; see
`references/playwright.md`. This keeps browser availability reproducible and avoids adding
FHS GUI libraries merely to run a downloaded browser.

If a project intentionally uses Playwright-managed browser downloads instead, provide the
runtime libraries that binary requires. Do not add a large `NIX_LD_LIBRARY_PATH` closure by
default when `pkgs.chromium` already solves the problem.

Chromium also wants more than podman's 64M `/dev/shm` default once a page is non-trivial;
if renderers crash under load, check shared-memory size before changing test code.

## Ad-hoc fallback

For a one-off, or a repo with no flake:

```sh
nix shell nixpkgs#xvfb nixpkgs#xdotool nixpkgs#xdpyinfo nixpkgs#imagemagick
```

You still need the EGL variable for GL apps, and outside a flake you have no `pkgs.mesa`
to interpolate, so resolve it explicitly:

```sh
export __EGL_VENDOR_LIBRARY_DIRS="$(nix build --no-link --print-out-paths nixpkgs#mesa)/share/glvnd/egl_vendor.d"
```

Prefer the committed `devShells.e2e` when the repo has a flake — the ad-hoc form works for
you today and for nobody else tomorrow.
