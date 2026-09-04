# Tauri / WebKitGTK headless

Tauri on Linux is **WebKitGTK**, not Chromium. Almost every surprise below follows from
that.

## Launch through the dev shell

```sh
nix develop .#e2e --command <the app's dev command>    # e.g. bun run dev
```

The webview needs a GL context, so a launch outside the shell dies at
`Could not create default EGL display: EGL_BAD_PARAMETER` with a blank white window. See
`e2e-shell.md` — this is the single most common way to waste an afternoon here.

`libEGL warning: DRI3 error: Could not get DRI3 device` appears on every headless start and
is harmless. Its presence in the log is not a diagnosis.

## Use the app's own dev command

Prefer `tauri dev` (usually wrapped as `bun run dev` / `npm run dev`) over launching a
binary out of `target/`. It starts the frontend dev server, compiles, and launches in one
step.

A binary built by plain `cargo build` loads the **devUrl** from `tauri.conf.json` (typically
`http://localhost:1420`), not the bundled `dist`. Run one directly without the dev server up
and the window shows "Connection refused" — which looks like an app bug and isn't.

The first `tauri dev` in a fresh environment is a cold build of the full dependency tree.
Run it in the background and watch the log rather than blocking on it.

## CDP is a dead end

Do not try to drive the Tauri window with the Chrome DevTools Protocol. WebKitGTK speaks the
WebKit Remote Inspector protocol instead. `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9222` does open
a listener — which makes it look like CDP is available — but it serves no HTTP at all: no
`/json/version`, empty reply to `GET /`. Every CDP client fails against it.

For real end-to-end checks, use Xvfb and `xdotool` as described in `driving.md`.

If you only need fast assertions against frontend behaviour, run the **frontend dev server**
in headless Chromium (`nixpkgs#ungoogled-chromium`) instead of the Tauri window. The app will
crash on `window.__TAURI_INTERNALS__` unless you inject an IPC shim via
`Page.addScriptToEvaluateOnNewDocument` mocking the commands it invokes plus
`plugin:event|listen`. That tests the web layer only — it does not exercise the Rust side.
