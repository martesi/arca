# Driving the virtual display

## Starting Xvfb

```sh
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -noreset >/dev/null 2>&1 &
```

`-nolisten tcp` keeps it to a local socket; `-noreset` stops the server exiting when the
last client disconnects, which otherwise tears the display down between two app launches.

Redirect its output. A backgrounded Xvfb inherits the shell's stdout, so if you are
capturing or piping that output the pipe never closes and the whole command reads as hung
long after the display is up and working.

Pick a display number nothing else is using. If a previous run may have left one behind,
either use a fresh number or check `ls /tmp/.X11-unix/`.

## Wait for it — do not skip this

```sh
until DISPLAY=:99 xdpyinfo >/dev/null 2>&1; do sleep 0.1; done
export DISPLAY=:99
```

Xvfb takes a moment to accept connections. An app launched too early fails in exactly the
same way as one launched with `DISPLAY` unset, which sends you debugging the wrong thing.

`xvfb-run <cmd>` is a self-contained alternative that handles the server lifecycle for a
single command. It is convenient for one-shots, but you cannot screenshot or click a
display you do not keep alive, so the explicit form above is usually what you want.

## Screenshots when visual assessment is required

```sh
import -window root shot.png
```

Read a required image back. File size is a smoke signal, not a verdict: a blank window
lands around 2.2 KB and a painted one around 40 KB, so a tiny file means something is
wrong — but a plausible size does not mean the UI rendered what you expected. There is no
image-diff tooling here; your own eyes on the PNG are the check.

**A window existing is not the same as a window having painted.** `xdotool search` succeeds
as soon as the window is mapped, which is well before the webview has rendered anything —
screenshot at that moment and you get a blank 2.2 KB frame from an app that is perfectly
healthy. Poll until the screenshot stops being blank, rather than treating the first
successful `search` as ready:

```sh
until [ "$(stat -c%s shot.png 2>/dev/null || echo 0)" -gt 10000 ]; do
  sleep 1; import -window root shot.png
done
```

## Input

```sh
xdotool search --onlyvisible --name 'My App'   # confirm the window exists first
xdotool mousemove 85 132 click 1
xdotool key Return
xdotool type 'some text'
```

Coordinates are screen-absolute, so read them off a screenshot.

**There is no window manager.** `xdotool windowactivate` fails with "your windowmanager
claims not to support `_NET_ACTIVE_WINDOW`" and `windowfocus` is unreliable for the same
reason. You do not need either — `mousemove … click` reaches the window regardless. Nothing
is broken; skip activation entirely.

When visual assessment is part of the acceptance criterion, screenshot after each relevant
interaction to confirm the app actually reacted, rather than assuming the click landed.
For a function-only button or trigger check, use a direct state, DOM, return-value, or
other behavioral assertion instead of capturing screenshots.

## Watching it live

When a human wants to see what is happening rather than read screenshots:

```sh
nix shell nixpkgs#x11vnc
x11vnc -display :99 -localhost -forever -shared -nopw -quiet &
```

Then tunnel port 5900 to wherever they are. Add `nixpkgs#novnc` and a websockify bridge if
a browser client is easier than a VNC one. This is optional and costs closure size — leave
it out of `devShells.e2e` and pull it ad-hoc.

## Cleanup

Kill the app, then Xvfb. Note that if the container or session is torn down, both die with
it — a dead display after a gap is expected, not a bug to investigate.

**Killing the launcher does not kill what it spawned.** A dev command like `bun run dev`
starts a frontend server as a separate process that outlives its parent, so the next run
fails with `Port 1420 is already in use` — which looks like a problem with the new run
rather than debris from the old one. Kill the process group, or sweep by name:

```sh
for p in /proc/[0-9]*; do
  case "$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null)" in
    *vite*|*<your-binary>*) kill "${p#/proc/}" ;;
  esac
done
```

`pgrep`/`pkill` are often absent from slim images; the `/proc` scan above needs nothing.

Remove temporary screenshots, logs, and test output after the result is confirmed when
they are not being retained for user confirmation. If an artifact was shown or kept for
the user to review, ask whether it should be removed after confirmation.
