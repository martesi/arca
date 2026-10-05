#!/usr/bin/env bun
Bun.serve({
  hostname: '127.0.0.1', port: Number(process.argv[2]),
  fetch: () => new Response('<h1>Firefox harness</h1>', { headers: { 'Content-Type': 'text/html' } }),
})
