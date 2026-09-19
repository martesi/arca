# Electron headless

Electron is real Chromium, not a system webview - almost everything in `driving.md` still
applies (you still need Xvfb, the EGL fix, fonts), but for *input and inspection* prefer CDP
over `xdotool`. This is the opposite recommendation from `tauri.md`: that file's "CDP is a
dead end" is a WebKitGTK problem, not a general e2e problem.

## Turn on the CDP port

Most Electron project scripts have (or can easily get) a debug variant, e.g.:

```json
"dev:remote": "electron-vite dev -- --remote-debugging-port=9222 --remote-allow-origins=\"*\""
```

Any Electron entry point accepts `--remote-debugging-port=<port>` directly. `--remote-allow-origins`
is needed on recent Electron or connections get rejected with a 403.

Find the actual page target - a packaged app may also list `background_page`/`webview`
targets you don't want:

```sh
curl -s http://127.0.0.1:9222/json/version   # sanity check the port is up
curl -s http://127.0.0.1:9222/json/list      # find the "type": "page" target, grab webSocketDebuggerUrl
```

## Driving it: no client library needed

Node 18+'s global `WebSocket` is enough to speak CDP directly - don't reach for
puppeteer/playwright for a one-off e2e check. Connect to `webSocketDebuggerUrl`, send
`{id, method, params}` frames, match responses by `id`. `Runtime.evaluate` (with
`returnByValue: true`) covers reading state and clicking things; `DOM.setFileInputFiles`
covers file inputs. That's usually the whole toolkit needed.

## React-controlled inputs need the native-setter trick

Setting `.value` directly and dispatching `input` does nothing on a React-controlled
`<input>` - React patches the element's own `value` setter, so a plain assignment is
invisible to it. Go through the prototype's setter instead:

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
setter.call(inputEl, "some text")
inputEl.dispatchEvent(new Event("input", { bubbles: true }))
```

Same idea for `<textarea>`/`<select>` if the framework controls those too - swap in
`HTMLTextAreaElement.prototype`/`HTMLSelectElement.prototype`.

## File inputs: skip the OS dialog entirely

A plain `<input type="file">` (even one hidden behind a styled dropzone and only reachable
by JS `.click()`) can be fed directly:

```js
// Runtime.evaluate with returnByValue: false to get an objectId instead of a value:
// expression: `document.querySelector('input[type="file"]')`
```

```json
{"method": "DOM.setFileInputFiles", "params": {"files": ["/abs/path/to/file"], "objectId": "<from above>"}}
```

This fires the real `change` event with real `FileList` contents - exactly what a user
dropping or picking a file produces. No `xdotool`, no native dialog, no Xvfb interaction at
all needed for this specific step.

## What CDP *can't* reach

`dialog.showOpenDialog`/`showSaveFilePicker` and other native OS dialogs a main-process
`ipcMain.handle` opens are not DOM - CDP has no visibility into them at all. Two ways
around it, in order of preference:

1. **Look for a paired plain input.** Apps that pair a "Browse" button with a real native
   dialog often *also* let you type the path directly into a text field next to it (the
   field round-trips to the same state either way). Prefer that - it's what the
   native-setter trick above is for - and skip the dialog entirely.
2. **If there's truly no text-input path**, this is the one case in an Electron app where
   you fall back to `xdotool` (see `driving.md`) to click through the native dialog once it
   opens - same as the Tauri flow.

## Native file chooser schemas in Nix shells

Electron's GTK file chooser reads GSettings schemas lazily. Missing schemas may only surface
when clicking a directory picker, then abort Electron with `No GSettings schemas are installed`
or `Settings schema 'org.gtk.Settings.FileChooser' is not installed`.

Include `gsettings-desktop-schemas` and `gtk3` in the e2e shell and set `GSETTINGS_SCHEMA_DIR`
to both versioned schema directories. Do not use a wildcard: it is not expanded by GLib.

```nix
packages = [ pkgs.gsettings-desktop-schemas pkgs.gtk3 ... ];
export GSETTINGS_SCHEMA_DIR="''${GSETTINGS_SCHEMA_DIR:-${pkgs.gtk3}/share/gsettings-schemas/gtk+3-${pkgs.gtk3.version}/glib-2.0/schemas:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/gsettings-desktop-schemas-${pkgs.gsettings-desktop-schemas.version}/glib-2.0/schemas}"
```

`libglvnd`/`libGL.so.1` must also be available through `LD_LIBRARY_PATH` for the downloaded
Electron binary. GPU/GLX fallback messages are usually harmless if CDP responds and the page
paints; a native chooser crash specifically points to the missing schema setup.


Expect a wall of `ERROR:ui/gl/gl_display.cc` / `ANGLE Display::initialize error 12289:
Could not dlopen libGL.so.1` / `Exiting GPU process due to errors during initialization` on
launch under Xvfb, even with the EGL fix from `e2e-shell.md` applied. Unlike Tauri/WebKitGTK
(where a GL failure is fatal - blank white window or abort), Chromium's GPU process failing
to init just makes Electron fall back to software compositing - the renderer still comes up
and paints correctly. Don't chase this log spam; screenshot or query the DOM to check whether
the app actually rendered before assuming it's broken. Missing fonts (see `e2e-shell.md`'s
`FONTCONFIG_FILE`) will still ruin the screenshot even when GL "fails" harmlessly like this,
so don't skip that part.

## Prebuilt binary, not a Nix derivation

`node_modules/electron`'s downloaded binary is dynamically linked against a full GTK/Chromium
stack and was never built by Nix - see `e2e-shell.md`'s "Prebuilt GUI binaries" section for
the `LD_LIBRARY_PATH` fix (`error while loading shared libraries: libglib-2.0.so.0` is the
symptom). This is a plain shared-library problem, unrelated to the CDP/GPU material above.

## Screenshots: CDP or `import` both work

`Page.captureScreenshot` (base64 PNG in the response) avoids shelling out to `import`
entirely and doesn't care whether a window manager is present. `import -window root` (see
`driving.md`) is equally valid and sometimes more convenient when you're already in a shell
loop - pick whichever fits the surrounding script. Either way, read the result back; a
window existing is still not the same as it having painted (same caveat as `driving.md`).
