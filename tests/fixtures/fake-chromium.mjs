#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const requested = Number(args.find((arg) => arg.startsWith('--remote-debugging-port='))?.split('=')[1] ?? 2000)
const profile = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
const root = profile ? path.resolve(profile, '../../../..') : process.cwd()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: requested,
  fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === '/json/version') return Response.json({ Browser: 'Fake Chromium' })
    return new Response('ok')
  },
})

appendFileSync(path.join(root, 'chromium.jsonl'), JSON.stringify(args) + '\n')
if (profile) {
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'DevToolsActivePort'), String(server.port) + '\n/devtools/browser/fake')
}
process.on('SIGTERM', () => {
  server.stop(true)
  process.exit(0)
})
setInterval(() => {}, 1000)
