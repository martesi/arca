---
name: opensubtitles-download
description: Download subtitle files from OpenSubtitles through an existing Chrome CDP session, including multi-episode seasons and language/release matching. Use when the user asks to find or download subtitles from a browser connected on localhost:9222, especially when the output should be copied into a local r/ directory.
---

# OpenSubtitles Download

## Overview

Use the Nix-packaged `agent-browser` to reuse the user's browser session on CDP port 9222, locate the requested title, season, and episodes, and download the requested language and release. Preserve the browser session, verify every file, and copy the results to the requested `r/` directory.

## Workflow

### 1. Connect safely

Use a named browser session and connect to the existing browser:

```sh
nix run github:numtide/llm-agents.nix#agent-browser -- session id --scope worktree --prefix subtitles
nix run github:numtide/llm-agents.nix#agent-browser -- --session <session> --cdp 9222 tab list
```

Do not close the user's attached browser or use an unscoped shared session. Inspect the current tab first; reuse it when it already shows the relevant OpenSubtitles page.

### 2. Identify the subtitle entries

Use `snapshot -i` or `snapshot -u` after every navigation. Confirm:

- title, season, and episode;
- requested language, preferably through the site's language-filtered page;
- release name, resolution, and FPS when the user specifies a video release.

If the title, season, language, or release is ambiguous, ask before downloading. Do not silently substitute a different language or release.

For a season, enumerate the episode links from the season page and process them sequentially. Expect one English subtitle row per episode only after verifying the page; report missing entries rather than skipping them silently.

### 3. Use the free download flow

On each subtitle detail page:

1. Open the normal `Download` control (`a.download-trigger`).
2. Skip `Direct download`/`a.ddl_trigger`; it is a disabled VIP-only link.
3. In the modal, activate `Download SRT`/`a.no-opt-link` and wait until `Your file is ready` appears.
4. Read the resulting signed URL from the ready modal's `a[download]` element.
5. Fetch that signed URL to the chosen output path. With the Nix package, use `ax` rather than `curl`:

```sh
nix run github:numtide/llm-agents.nix#ax -- "$SIGNED_URL" -o "$OUTPUT_FILE"
```

When an overlay covers the download control, use an in-page click through `agent-browser eval` after inspecting the selector:

```sh
nix run github:numtide/llm-agents.nix#agent-browser -- --session <session> --cdp 9222 eval 'document.querySelector("a.download-trigger").click()'
```

The browser `download` command may report `Download was canceled` when attached to an existing CDP browser. Treat that as a transport issue, not a failed subtitle request: obtain the ready modal's signed `href` and fetch it with `ax`.

### 4. Store and verify files

Resolve the destination explicitly. Treat a relative destination such as `r/` as relative to the current repository or workspace unless the user provides another path. Use an absolute root-level path such as `/r/` only when it actually exists or the user explicitly requests it. Do not create or recursively modify a broad root directory without explicit confirmation.

Use predictable names such as `S03E01.en.srt`. Keep the original downloads in a separate directory when practical, then copy them into `r/`.

After downloading, verify that:

- every expected episode has a file;
- each file is non-empty and has the expected subtitle extension;
- the first lines look like SRT cues, not an HTML error page;
- the final destination contains the complete set.

Report the destination, file count, and any missing or mismatched episodes. Never claim completion based only on a successful browser click.
