# Userscript E2E

Use this workflow for browser-visible userscript behavior, especially projects using `vite-plugin-monkey` with Violentmonkey and `agent-browser`.

## Reuse a persistent browser profile

Keep the browser profile outside source-controlled output, for example:

```sh
export AGENT_BROWSER_PROFILE="$PWD/.browser-state/profile"
```

Load the userscript manager as an unpacked extension with `AGENT_BROWSER_EXTENSIONS`. Persist the profile so the manager's one-time permissions and installed userscript survive source edits.

## Development install loop

For `vite-plugin-monkey`, prefer the development install endpoint exposed by the Vite server instead of manually injecting the built bundle:

```text
http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js
```

Open that URL with `agent-browser`, switch to the userscript manager confirmation tab, confirm installation, then navigate to the target site. Normal source edits can arrive through Vite HMR; reinstall only when userscript metadata or the install bootstrap changes.

Keep any authentication import or site-specific navigation in the consuming repository. The reusable E2E skill must not contain cookies, fixed accounts, or site credentials.

## CSP during development

`inject-into: page` development scripts can be blocked by a site's HTTP `Content-Security-Policy` even when the userscript manager itself is loaded correctly. Browser flags such as `--disable-web-security` are not a reliable CSP switch.

When the observed failure is specifically an HTTP CSP header, load the bundled helper beside the userscript manager from the installed skill path:

```sh
export AGENT_BROWSER_EXTENSIONS="$VIOLENTMONKEY_PATH,$PWD/.agents/skills/e2e/assets/disable-csp"
```

If the host deploys skills somewhere else, resolve the active `e2e` skill root and use its `assets/disable-csp` directory instead. Do not copy the extension into the repository merely to run it.

The bundled extension is intentionally generic: it strips only `Content-Security-Policy` and `Content-Security-Policy-Report-Only` from HTTP(S) main-frame and sub-frame responses. It contains no JavaScript or background worker.

Do not enable it by default. Removing CSP disables a site security boundary and can hide production behavior. Use it only for a test browser after reproducing a CSP-blocked development injection.

The helper does not remove HTML `<meta http-equiv="Content-Security-Policy">` policies. If the site uses meta CSP, first confirm that is the actual blocker; handling response bodies requires a heavier debugger/CDP interception path and is not part of this minimal helper.

## Repository-specific wrapper

A consuming userscript repository can keep a small local skill or script for facts that are genuinely local, such as:

- authenticated cookie/bootstrap source;
- fixed E2E URLs;
- project dev-server port;
- expected control selectors and acceptance checks.

Keep generic browser setup, userscript-manager behavior, and CSP diagnosis here rather than duplicating them per repository.
