# agent-browser from Podman

Use this when `agent-browser` runs inside a Podman container but must control a Chrome/Chromium instance on the host through CDP (Chrome DevTools Protocol).

## Connect to host Chrome

Expose Chrome's remote-debugging port on the host, for example `9223`, so the container can reach it through Podman's host gateway.

Do not pass `host.containers.internal` directly to `agent-browser --cdp`. Chrome can reject CDP discovery requests whose HTTP `Host` header is a hostname other than `localhost`:

```text
Host header is specified and is not an IP address or localhost.
```

Resolve the Podman host alias to its numeric address, then pass an HTTP URL:

```sh
host_ip="$(awk '$2 == "host.containers.internal" { print $1; exit }' /etc/hosts)"
agent-browser --cdp "http://${host_ip}:9223" get url
```

`host.containers.internal` is normally injected into `/etc/hosts` by Podman. Do not hard-code the resolved address; it can differ between hosts or container network configurations.

If the image includes `getent`, this is equivalent:

```sh
host_ip="$(getent ahostsv4 host.containers.internal | awk 'NR == 1 { print $1 }')"
```

## Always isolate the session

Use a fresh named session before the first browser command. The unnamed default daemon is shared state and can remain alive without a valid attached browser, which can make an otherwise healthy CDP endpoint appear to hang.

```sh
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix e2e)"
host_ip="$(awk '$2 == "host.containers.internal" { print $1; exit }' /etc/hosts)"
agent-browser --cdp "http://${host_ip}:9223" tab list
```

Keep that `AGENT_BROWSER_SESSION` for the whole test.

## Diagnose attach failures

Check the layers in this order:

1. Verify CDP discovery from inside the container:

   ```sh
   curl "http://${host_ip}:9223/json/version"
   ```

   A healthy response includes `Browser`, `Protocol-Version`, and `webSocketDebuggerUrl`.

2. If discovery through `host.containers.internal` reports the Host-header error but the numeric IP works, use the numeric IP with `agent-browser`. Do not add a TCP proxy just to rewrite the header.

3. If `/json/version` works but `agent-browser` hangs, retry with a fresh named session. Inspect current state with:

   ```sh
   agent-browser session list
   agent-browser session info --json
   ```

   A stale session commonly reports no useful attached pages while its background daemon remains active.

4. Only investigate CDP/WebSocket transport after both numeric-IP discovery and a fresh session fail. A successful `/json/version` response proves the HTTP route alone, not the WebSocket attach.

## Existing authenticated host browser

Attaching to the host Chrome instance reuses that browser's existing tabs and authenticated state. Prefer `tab list` first, select the intended tab, and avoid navigating or closing unrelated tabs. Use `--pin-tab` when a task should stay bound to one tab.
