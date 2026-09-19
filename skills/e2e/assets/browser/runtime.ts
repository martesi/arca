import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'

export interface Runtime {
  dir: string
  path(file: string): string
}

interface SpawnOwnedOptions {
  cwd?: string
  pidFile?: string
  logFile?: string
  env?: NodeJS.ProcessEnv
}

interface XvfbOptions {
  display?: string
  pidFile?: string
  logFile?: string
  cwd?: string
  timeout?: number
}

export function createRuntime(root = process.cwd(), name = 'e2e'): Runtime {
  const dir = path.join(root, '.browser-state', `${name}-runtime`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    path: (file) => path.join(dir, file),
  }
}

export function spawnOwned(
  command: string,
  args: string[],
  { cwd = process.cwd(), pidFile, logFile, env = process.env }: SpawnOwnedOptions = {},
): number | undefined {
  if (!pidFile || !logFile) throw new Error('pidFile and logFile are required')
  if (hasRunningProcess(pidFile)) return Number(readFileSync(pidFile, 'utf8'))

  const output = openSync(logFile, 'a')
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', output, output],
  })
  closeSync(output)
  if (child.pid === undefined) throw new Error(`Failed to start ${command}`)
  writeFileSync(pidFile, String(child.pid))
  child.unref()
  return child.pid
}

export function hasRunningProcess(pidFile: string | undefined): boolean {
  if (!pidFile || !existsSync(pidFile)) return false
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0)
    return true
  } catch {
    rmSync(pidFile, { force: true })
    return false
  }
}

export function stopOwnedProcess(
  pidFile: string | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  if (!hasRunningProcess(pidFile) || !pidFile) return false
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ESRCH') throw error
  }
  rmSync(pidFile, { force: true })
  return true
}

export async function ensureXvfb({
  display = process.env.DISPLAY ?? ':99',
  pidFile,
  logFile,
  cwd = process.cwd(),
  timeout = 5000,
}: XvfbOptions = {}): Promise<boolean> {
  process.env.DISPLAY = display
  if (spawnSync('xdpyinfo', { stdio: 'ignore' }).status === 0) return false
  spawnOwned('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-noreset'], {
    cwd,
    pidFile,
    logFile,
  })

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (spawnSync('xdpyinfo', { stdio: 'ignore' }).status === 0) return true
    await sleep(100)
  }
  throw new Error(`Xvfb did not become ready on ${display}; see ${logFile}`)
}

export async function waitForUrls(
  urls: string[],
  { timeout = 10_000, interval = 100 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ready = await Promise.all(urls.map(isReachable))
    if (ready.every(Boolean)) return
    await sleep(interval)
  }
  throw new Error(`E2E readiness timed out: ${urls.join(', ')}`)
}

export async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) })
    return response.ok
  } catch {
    return false
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
