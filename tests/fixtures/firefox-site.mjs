#!/usr/bin/env bun
Bun.serve({
  hostname: '127.0.0.1', port: Number(process.argv[2]),
  fetch: (request) => new URL(request.url).pathname === '/proof.user.js'
    ? new Response(`// ==UserScript==
// @name Arca Firefox proof
// @namespace arca.e2e
// @version 1.0.0
// @match http://*/*
// @run-at document-idle
// @grant GM.getValue
// @grant GM.setValue
// ==/UserScript==
(async () => {
  const runs = await GM.getValue('runs', 0) + 1;
  await GM.setValue('runs', runs);
  document.body.dataset.userscriptRuns = String(runs);
})();`, { headers: { 'Content-Type': 'text/javascript' } })
    : new Response('<h1>Firefox harness</h1>', { headers: { 'Content-Type': 'text/html' } }),
})
