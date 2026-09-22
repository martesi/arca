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
  type Runtime,
} from './runtime.ts'

const THIS_FILE = fileURLToPath(import.meta.url)

interface CdpBrowserOptions {
  root: string
  name: string
  profile: string
  command: string[]
  args?: string[]
  extensions?: string[]
  headed?: boolean
  port?: number
  timeout?: number
  env?: NodeJS.ProcessEnv
}

export interface CdpBrowser {
  runtime: Runtime
  profile: string
  port: number
  endpoint: string
  started: boolean
}

interface WaitForCdpOptions {
  requestedPort: number
  profile: string
  pidFile: string
  logFile: string
  timeout: number
}

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
}: CdpBrowserOptions): Promise<CdpBrowser> {
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
    '--disable-dev-shm-usage',
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

export function beginIdleWindow(runtime: Runtime): string {
  cancelIdleStop(runtime)
  const token = `${Date.now()}-${process.pid}-${process.hrtime.bigint()}`
  writeFileSync(runtime.path('activity-token'), token)
  return token
}

export function scheduleIdleStop(runtime: Runtime, token: string, timeoutMs: number): boolean {
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

export function stopCdpBrowser(runtime: Runtime): boolean {
  cancelIdleStop(runtime)
  const stopped = stopOwnedProcess(runtime.path('browser.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
  return stopped
}

export async function stopCdpBrowserAndWait(runtime: Runtime, timeout = 5000): Promise<boolean> {
  const pid = Number(readText(runtime.path('browser.pid')))
  if (!pid || !hasRunningProcess(runtime.path('browser.pid'))) {
    rmSync(runtime.dir, { recursive: true, force: true })
    return false
  }

  cancelIdleStop(runtime)
  const deadline = Date.now() + timeout
  const graceful = await requestBrowserClose(readPort(runtime.path('cdp-port')))
  if (graceful) {
    const gracefulDeadline = Math.min(deadline, Date.now() + 1500)
    while (Date.now() < gracefulDeadline) {
      if (!processExists(pid)) {
        rmSync(runtime.dir, { recursive: true, force: true })
        return true
      }
      await sleep(50)
    }
  }

  stopOwnedProcess(runtime.path('browser.pid'))

  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      rmSync(runtime.dir, { recursive: true, force: true })
      return true
    }
    await sleep(50)
  }
  throw new Error(`Chromium ${pid} did not exit within ${timeout}ms`)
}

async function requestBrowserClose(port: number): Promise<boolean> {
  if (!port) return false
  try {
    const response = await fetch(`${endpointFor(port)}/json/version`, { signal: AbortSignal.timeout(800) })
    if (!response.ok) return false
    const value: unknown = await response.json()
    const websocketUrl = value && typeof value === 'object' && 'webSocketDebuggerUrl' in value
      ? value.webSocketDebuggerUrl
      : undefined
    if (typeof websocketUrl !== 'string') return false

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(websocketUrl)
      const timer = setTimeout(() => reject(new Error('CDP browser close timed out')), 800)
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('CDP browser close failed'))
      }, { once: true })
    })
    return true
  } catch {
    return false
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function cancelIdleStop(runtime: Runtime): void {
  stopOwnedProcess(runtime.path('reaper.pid'))
}

async function waitForCdp({
  requestedPort,
  profile,
  pidFile,
  logFile,
  timeout,
}: WaitForCdpOptions): Promise<number> {
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

function readDevToolsPort(profile: string): number {
  const file = path.join(profile, 'DevToolsActivePort')
  if (!existsSync(file)) return 0
  return Number(readFileSync(file, 'utf8').split('\n')[0]) || 0
}

function readPort(file: string): number {
  return Number(readText(file)) || 0
}

function readText(file: string): string {
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8').trim()
}

function endpointFor(port: number): string {
  return `http://127.0.0.1:${port}`
}

function reap(runtimeDir: string, token: string): void {
  const runtime: Runtime = { dir: runtimeDir, path: (file) => path.join(runtimeDir, file) }
  if (readText(runtime.path('activity-token')) !== token) return
  rmSync(runtime.path('reaper.pid'), { force: true })
  stopOwnedProcess(runtime.path('browser.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE && process.argv[2] === '__reap') {
  reap(process.argv[3], process.argv[4])
}
