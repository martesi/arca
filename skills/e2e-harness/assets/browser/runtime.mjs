import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'

export function createRuntime(root = process.cwd(), name = 'e2e') {
  const dir = path.join(root, '.browser-state', `${name}-runtime`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    path: (file) => path.join(dir, file),
  }
}

export function spawnOwned(command, args, { cwd = process.cwd(), pidFile, logFile, env = process.env } = {}) {
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
  writeFileSync(pidFile, String(child.pid))
  child.unref()
  return child.pid
}

export function hasRunningProcess(pidFile) {
  if (!pidFile || !existsSync(pidFile)) return false
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0)
    return true
  } catch {
    rmSync(pidFile, { force: true })
    return false
  }
}

export function stopOwnedProcess(pidFile, signal = 'SIGTERM') {
  if (!hasRunningProcess(pidFile)) return false
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
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
} = {}) {
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

export async function waitForUrls(urls, { timeout = 10_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ready = await Promise.all(urls.map(isReachable))
    if (ready.every(Boolean)) return
    await sleep(interval)
  }
  throw new Error(`E2E readiness timed out: ${urls.join(', ')}`)
}

export async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) })
    return response.ok
  } catch {
    return false
  }
}
