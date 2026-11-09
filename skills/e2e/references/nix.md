# Nix E2E shell

Add a sibling E2E shell and reuse the default shell's package/hook bindings instead of
copying them.

Minimal browser/GUI additions are commonly:

```nix
pkgs.firefox
pkgs.xvfb
pkgs.xdpyinfo
pkgs.xdotool
pkgs.imagemagick
pkgs.fontconfig
```

Add only what the selected E2E path uses.

For a virtual display, expose a default without overriding a real display:

```nix
export DISPLAY="''${DISPLAY:-:99}"
```

For slim Nix/container environments with no system fontconfig, provide a self-contained
font config:

```nix
export FONTCONFIG_FILE="''${FONTCONFIG_FILE:-${pkgs.makeFontsConf {
  fontDirectories = with pkgs; [ dejavu_fonts liberation_ttf ];
}}}"
```

For WebKitGTK/other EGL consumers on a slim Nix environment, point libglvnd at Mesa only
when the host has not already provided a vendor path:

```nix
export __EGL_VENDOR_LIBRARY_DIRS="''${__EGL_VENDOR_LIBRARY_DIRS:-${pkgs.mesa}/share/glvnd/egl_vendor.d}"
```

Do not cargo-cult `LIBGL_ALWAYS_SOFTWARE`, `GALLIUM_DRIVER`, broad `LD_LIBRARY_PATH`, or
other graphics overrides into every repository. Add platform-specific workarounds only when
the application actually needs them.

For the agent-driven Playwright browser:

```nix
export PLAYWRIGHT_FIREFOX_EXECUTABLE="''${PLAYWRIGHT_FIREFOX_EXECUTABLE:-${pkgs.firefox}/bin/firefox}"
```

Keep Bun and Playwright scratch space writable in slim or task-runner
environments. A project shell can use a checkout-local task directory (the
harness sets the same variables for owned processes):

```sh
export E2E_HARNESS_TEMP_DIR="''${E2E_HARNESS_TEMP_DIR:-$PWD/.cache/arca/tmp}"
mkdir -p "$E2E_HARNESS_TEMP_DIR"
export TMPDIR="$E2E_HARNESS_TEMP_DIR"
export BUN_TMPDIR="$E2E_HARNESS_TEMP_DIR/bun"
mkdir -p "$BUN_TMPDIR"
```

Run `bun install` inside that shell. Do not rely on a system temporary
directory that may be mounted read-only by the task runner.

The harness uses stock Firefox through `moz-firefox`. For an explicit Chromium profile
(`browser = "chromium"`) or Playwright using nixpkgs Chromium:

```nix
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="''${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-${pkgs.chromium}/bin/chromium}"
```

Keep project-specific extension paths and dev-server variables in the consuming repository.
