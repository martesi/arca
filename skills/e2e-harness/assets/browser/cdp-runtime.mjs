import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createRuntime,
  hasRunningProcess,
  isReachable,
  spawnOwned,
  stopOwnedProcess,
} from './runtime.mjs'

const THIS_FILE = fileURLToPath(import.meta.url)

export async function ensureCdpBrowser({
  root,
  name,
  profile,
  command,
  args = [],
  extensions = [],
  headed = false,
  port = 0,
  timeout = 10_000,
  env = process.env,
}) {
  const runtime = createRuntime(root, name)
  cancelIdleStop(runtime)

  const recordedPort = readPort(runtime.path('cdp-port'))
  if (hasRunningProcess(runtime.path('browser.pid')) && recordedPort) {
    const endpoint = endpointFor(recordedPort)
    if (await isReachable(`${endpoint}/json/version`)) {
      return { runtime, profile, port: recordedPort, endpoint, started: false }
    }
    stopOwnedProcess(runtime.path('browser.pid'))
  }

  if (port && await isReachable(`${endpointFor(port)}/json/version`)) {
    throw new Error(`CDP port is already in use: ${port}`)
  }

  mkdirSync(profile, { recursive: true })
  rmSync(path.join(profile, 'DevToolsActivePort'), { force: true })

  const extensionList = extensions.filter(Boolean).join(',')
  const browserArgs = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(extensionList
      ? [`--disable-extensions-except=${extensionList}`, `--load-extension=${extensionList}`]
      : []),
    ...args,
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ]

  spawnOwned(command[0], [...command.slice(1), ...browserArgs], {
    cwd: root,
    pidFile: runtime.path('browser.pid'),
    logFile: runtime.path('browser.log'),
    env,
  })

  const actualPort = await waitForCdp({
    requestedPort: port,
    profile,
    pidFile: runtime.path('browser.pid'),
    logFile: runtime.path('browser.log'),
    timeout,
  })
  writeFileSync(runtime.path('cdp-port'), String(actualPort))
  return {
    runtime,
    profile,
    port: actualPort,
    endpoint: endpointFor(actualPort),
    started: true,
  }
}

export function beginIdleWindow(runtime) {
  cancelIdleStop(runtime)
  const token = `${Date.now()}-${process.pid}-${process.hrtime.bigint()}`
  writeFileSync(runtime.path('activity-token'), token)
  return token
}

export function scheduleIdleStop(runtime, token, timeoutMs) {
  if (!timeoutMs || readText(runtime.path('activity-token')) !== token) return false
  const seconds = Math.max(timeoutMs / 1000, 0.05)
  spawnOwned('sh', [
    '-c',
    'sleep "$1"; shift; exec "$@"',
    'e2e-idle-reaper',
    String(seconds),
    process.execPath,
    THIS_FILE,
    '__reap',
    runtime.dir,
    token,
  ], {
    cwd: runtime.dir,
    pidFile: runtime.path('reaper.pid'),
    logFile: runtime.path('reaper.log'),
  })
  return true
}

export function stopCdpBrowser(runtime) {
  cancelIdleStop(runtime)
  const stopped = stopOwnedProcess(runtime.path('browser.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
  return stopped
}

function cancelIdleStop(runtime) {
  stopOwnedProcess(runtime.path('reaper.pid'))
}

async function waitForCdp({ requestedPort, profile, pidFile, logFile, timeout }) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const port = requestedPort || readDevToolsPort(profile)
    if (port && await isReachable(`${endpointFor(port)}/json/version`)) return port
    if (!hasRunningProcess(pidFile)) {
      throw new Error(`Chromium exited before CDP became ready; see ${logFile}`)
    }
    await sleep(100)
  }
  throw new Error(`Chromium did not expose CDP within ${timeout}ms; see ${logFile}`)
}

function readDevToolsPort(profile) {
  const file = path.join(profile, 'DevToolsActivePort')
  if (!existsSync(file)) return 0
  return Number(readFileSync(file, 'utf8').split('\n')[0]) || 0
}

function readPort(file) {
  return Number(readText(file)) || 0
}

function readText(file) {
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8').trim()
}

function endpointFor(port) {
  return `http://127.0.0.1:${port}`
}

function reap(runtimeDir, token) {
  const runtime = { dir: runtimeDir, path: (file) => path.join(runtimeDir, file) }
  if (readText(runtime.path('activity-token')) !== token) return
  rmSync(runtime.path('reaper.pid'), { force: true })
  stopOwnedProcess(runtime.path('browser.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
}

if (import.meta.main && process.argv[2] === '__reap') {
  reap(process.argv[3], process.argv[4])
}
