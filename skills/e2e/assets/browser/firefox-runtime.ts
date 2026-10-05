import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { firefox } from 'playwright'
import { createRuntime, hasRunningProcess, spawnOwned, stopOwnedProcess } from './runtime.ts'
import type { CdpBrowser } from './cdp-runtime.ts'
import { installFirefoxUserscript, prepareFirefoxScriptCat, type FirefoxScriptCat } from './firefox-userscript.ts'

const THIS_FILE = fileURLToPath(import.meta.url)

interface FirefoxOptions {
  root: string
  runtimeDir: string
  name: string
  profile: string
  executable: string
  commandPrefix: string[]
  args: string[]
  headed: boolean
  port: number
  timeout: number
  scriptCat?: FirefoxScriptCat
  userscriptUrls?: string[]
}

export async function ensureFirefoxBrowser(options: FirefoxOptions): Promise<CdpBrowser> {
  const { root, runtimeDir, name, profile, commandPrefix, port, timeout } = options
  const runtime = createRuntime(root, name, runtimeDir)
  stopOwnedProcess(runtime.path('reaper.pid'))
  const endpointFile = runtime.path('browser-endpoint')
  if (hasRunningProcess(runtime.path('browser.pid')) && existsSync(endpointFile)) {
    return { runtime, profile, port, endpoint: readFileSync(endpointFile, 'utf8'), started: false }
  }
  rmSync(endpointFile, { force: true })
  writeFileSync(runtime.path('firefox-options.json'), JSON.stringify(options))
  // The endpoint owner must use Node even when a Bun test invokes the harness.
  const executable = process.versions.bun ? 'node' : process.execPath
  const command = [...commandPrefix, executable, ...process.execArgv, THIS_FILE, '__launch', runtime.path('firefox-options.json')]
  spawnOwned(command[0], command.slice(1), {
    cwd: root,
    pidFile: runtime.path('browser.pid'),
    logFile: runtime.path('browser.log'),
  })
  const startupTimeout = timeout * (1 + (options.userscriptUrls?.length ?? 0))
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    if (existsSync(endpointFile)) {
      const endpoint = readFileSync(endpointFile, 'utf8')
      return { runtime, profile, port: Number(new URL(endpoint).port), endpoint, started: true }
    }
    if (!hasRunningProcess(runtime.path('browser.pid'))) break
    await sleep(100)
  }
  await requestFirefoxClose(runtime.path('firefox-owner.pid'))
  stopOwnedProcess(runtime.path('browser.pid'))
  throw new Error(`Firefox did not become ready within ${startupTimeout}ms; see ${runtime.path('browser.log')}`)
}

export async function requestFirefoxClose(pidFile: string): Promise<boolean> {
  // Signal only the owner so it can flush the persistent profile before exiting.
  return Promise.resolve().then(() => {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM')
    return true
  }).catch(() => false)
}

async function launch(optionsFile: string): Promise<void> {
  const options: FirefoxOptions = JSON.parse(readFileSync(optionsFile, 'utf8'))
  const executablePath = path.isAbsolute(options.executable)
    ? options.executable
    : process.env.PATH?.split(path.delimiter)
      .map((directory) => path.join(directory, options.executable)).find(existsSync)
  if (!executablePath) throw new Error(`Firefox executable not found: ${options.executable}`)
  writeFileSync(path.join(path.dirname(optionsFile), 'firefox-owner.pid'), String(process.pid))
  const launching = firefox.launchPersistentContext(options.profile, {
    channel: 'moz-firefox',
    executablePath,
    headless: !options.headed,
    handleSIGTERM: false,
    args: options.args,
    timeout: options.timeout,
    ...(options.scriptCat ? {
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
      firefoxUserPrefs: prepareFirefoxScriptCat(options.profile, options.scriptCat),
    } : {}),
  })
  process.once('SIGTERM', () => {
    void launching.then((context) => context.close()).then(() => process.exit(0)).catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
  })
  const context = await launching
  const browser = context.browser()
  if (!browser) throw new Error('Firefox did not expose its browser')
  if (options.scriptCat) {
    for (const url of options.userscriptUrls ?? []) {
      await installFirefoxUserscript(context, options.profile, options.scriptCat.id, url, options.timeout)
        .catch(async (error: unknown) => {
          await context.close()
          throw error
        })
    }
  }
  const { endpoint } = await browser.bind(options.name, {
    host: '127.0.0.1', port: options.port, workspaceDir: options.root,
  })
  writeFileSync(path.join(path.dirname(optionsFile), 'browser-endpoint'), endpoint)
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE && process.argv[2] === '__launch') {
  await launch(process.argv[3])
}
