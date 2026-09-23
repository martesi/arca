#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session')
const session = args.find((arg) => arg.startsWith('-s='))?.slice(3)
  ?? (sessionIndex >= 0 ? args[sessionIndex + 1] : 'default')
const stateRoot = process.env.E2E_HARNESS_PROFILE
  ? path.resolve(process.env.E2E_HARNESS_PROFILE, '../../../..')
  : process.cwd()
const stateFile = path.join(stateRoot, 'agent-state.' + session)

appendFileSync(path.join(stateRoot, 'agent.jsonl'), JSON.stringify({
  args,
  session,
  profileName: process.env.E2E_HARNESS_PROFILE_NAME,
  profile: process.env.AGENT_BROWSER_PROFILE,
  cdp: process.env.E2E_HARNESS_CDP_ENDPOINT,
  harnessProfile: process.env.E2E_HARNESS_PROFILE,
  outputDir: process.env.PLAYWRIGHT_MCP_OUTPUT_DIR,
}) + '\n')

if (args[0] === 'attach') {
  writeFileSync(stateFile, '0')
  process.exit(0)
}
if (args.includes('detach')) {
  rmSync(stateFile, { force: true })
  process.exit(0)
}
if (args.includes('tab-list') && args.includes('--json')) {
  if (!existsSync(stateFile)) process.exit(1)
  console.log(JSON.stringify({ result: '- 0: (current) [](about:blank)' }))
}
if (args.includes('run-code') && args.includes('--raw') && args.some((arg) => arg.includes('page.context().pages()'))) {
  if (!existsSync(stateFile)) process.exit(1)
  const count = Number(readFileSync(stateFile, 'utf8')) || 0
  const tabs = count === 0
    ? [{ tabId: '0', url: 'about:blank' }]
    : [{ tabId: '0', url: 'about:blank' }, { tabId: '1', url: 'chrome-extension://manager/confirm' }]
  writeFileSync(stateFile, String(count + 1))
  console.log(JSON.stringify(JSON.stringify(tabs)))
}
if (args.includes('run-code') && args.includes('--raw') && args.some((arg) => arg.includes('developerPrivate'))) {
  console.log(JSON.stringify({ changed: true, active: true, id: 'manager' }))
}
if (args.includes('run-code') && args.includes('--raw') && args.some((arg) => arg.includes('serviceWorker/script/installByCode'))) {
  const code = args.find((arg) => arg.includes('serviceWorker/script/installByCode')) ?? ''
  const uuid = code.match(/"uuid":"([^"]+)"/)?.[1]
  console.log(JSON.stringify({ uuid }))
}
