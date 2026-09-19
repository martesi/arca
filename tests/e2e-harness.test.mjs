import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadLocalCookies, parseJsonCookies, parseNetscapeCookies } from '../skills/e2e-harness/assets/browser/cookie-loader.mjs'
import {
  createRuntime,
  hasRunningProcess,
  spawnOwned,
  stopOwnedProcess,
} from '../skills/e2e-harness/assets/browser/runtime.mjs'
import {
  buildAgentEnv,
  importCookies,
  inferProjectRoot,
  loadHarnessConfig,
  normalizeConfig,
  runAgentCommand,
  startHarness,
  stopHarness,
} from '../skills/e2e-harness/scripts/harness.mjs'

const harnessScript = fileURLToPath(new URL('../skills/e2e-harness/scripts/harness.mjs', import.meta.url))

test('cookie parser accepts browser JSON and Netscape exports', () => {
  assert.equal(parseJsonCookies('[{"name":"sid","value":"x","domain":".example.com"}]')[0].name, 'sid')
  assert.equal(parseNetscapeCookies('.example.com\tTRUE\t/\tTRUE\t0\tsid\tx')[0].secure, true)
})

test('cookies.json takes precedence and an explicit cookie source can be selected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    await writeFile(path.join(root, 'cookies-old.txt'), '.example.com\tTRUE\t/\tFALSE\t0\told\tx\n')
    await writeFile(path.join(root, 'cookies.json'), '[{"name":"new","value":"x","domain":".example.com"}]')
    assert.deepEqual((await loadLocalCookies(root)).map((cookie) => cookie.name), ['new'])
    assert.deepEqual((await loadLocalCookies(root, { file: 'cookies-old.txt' })).map((cookie) => cookie.name), ['old'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime owns and stops only the process recorded in its pid file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    const runtime = createRuntime(root, 'agent')
    const pidFile = runtime.path('owned.pid')
    const logFile = runtime.path('owned.log')
    spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { pidFile, logFile })
    assert.equal(hasRunningProcess(pidFile), true)
    assert.equal(stopOwnedProcess(pidFile), true)
    assert.equal(hasRunningProcess(pidFile), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TOML config and environment are explicit harness inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    await writeFile(path.join(root, 'flake.nix'), '')
    const configFile = path.join(root, 'e2e.toml')
    await writeFile(configFile, `
display = false
cookies = false
userscript = false

[agent]
command = "true"
`)

    const env = {
      AGENT_BROWSER_SESSION: 'env-agent',
      AGENT_BROWSER_PROFILE: '.browser-state/from-env',
      AGENT_BROWSER_EXECUTABLE_PATH: '/env/chromium',
      AGENT_BROWSER_EXTENSIONS: './one,./two',
    }
    const config = await loadHarnessConfig(root, configFile, env)
    assert.equal(config.shell, false)
    assert.equal(config.agent.session, 'env-agent')
    assert.equal(config.agent.profile, path.join(root, '.browser-state', 'from-env'))
    assert.equal(config.agent.executablePath, '/env/chromium')
    assert.deepEqual(config.agent.extensions, [path.join(root, 'one'), path.join(root, 'two')])
    assert.equal(inferProjectRoot(path.join(root, 'skills', 'e2e-harness')), root)

    const result = spawnSync(process.execPath, [harnessScript, 'stop'], {
      cwd: root,
      env: { ...process.env, E2E_CONFIG: configFile },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ig-helper-shaped start owns ScriptCat setup, env, cookies, install, target, and cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    const { command, log, state } = await makeFakeAgent(root)
    await writeFile(path.join(root, 'cookies.json'), '[{"name":"sessionid","value":"secret","domain":".instagram.com","secure":true}]')

    const config = normalizeConfig({
      display: false,
      agent: {
        command,
        session: 'ig-helper-agent',
        profile: '.browser-state/agent',
        extensions: ['/nix/store/scriptcat', './disable-csp'],
        args: ['--disable-features=LocalNetworkAccessChecks'],
        screenshotDir: 'e2e/artifacts',
        env: { FAKE_LOG: log, FAKE_STATE: state },
      },
      cookies: { required: true },
      userscript: {
        manager: 'scriptcat',
        installUrl: 'http://127.0.0.1:9000/__vite-plugin-monkey.install.user.js',
      },
      targetUrl: 'https://www.instagram.com/',
    }, root)

    await startHarness(config)
    stopHarness(config)

    const calls = await readCalls(log)
    assert.deepEqual(calls[0].args.slice(0, 5), ['--session', 'ig-helper-agent', '--headed', 'open', 'about:blank'])
    assert.ok(calls.some((call) => call.args.includes('chrome://extensions/')))
    assert.ok(calls.some((call) => call.args.includes('sessionid') && call.args.includes('.instagram.com')))
    assert.ok(calls.some((call) => call.args.includes('http://127.0.0.1:9000/__vite-plugin-monkey.install.user.js')))
    assert.ok(calls.some((call) => call.args.includes('confirm')))
    assert.ok(calls.some((call) => call.args.includes('https://www.instagram.com/')))
    assert.equal(calls.at(-1).args.at(-1), 'close')
    assert.ok(calls.every((call) => call.profile === path.join(root, '.browser-state', 'agent')))
    assert.ok(calls.every((call) => call.extensions === `/nix/store/scriptcat,${path.join(root, 'disable-csp')}`))
    assert.ok(calls.every((call) => call.browserArgs === '--disable-features=LocalNetworkAccessChecks'))
    assert.equal(calls[0].screenshotDir, path.join(root, 'e2e', 'artifacts'))
    assert.equal(await exists(path.join(root, '.browser-state', 'agent-runtime')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('orphic-shaped config pins its cookie source and browser args without local wrapper code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    const { command, log, state } = await makeFakeAgent(root)
    await writeFile(
      path.join(root, 'cookies.txt'),
      '#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1818824112\txs\tsecret\n.facebook.com\tTRUE\t/\tFALSE\t0\tdatr\tplain\n'
    )

    const config = normalizeConfig({
      display: false,
      agent: {
        command,
        session: 'facebook-media-helper',
        profile: '.browser-state/profile',
        extensions: ['/nix/store/violentmonkey'],
        args: ['--no-sandbox', '--no-proxy-server'],
        env: { FAKE_LOG: log, FAKE_STATE: state },
      },
      cookies: { file: 'cookies.txt', required: true },
      userscript: {
        manager: 'violentmonkey',
        installUrl: 'http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js',
        installOnStart: false,
      },
    }, root)

    assert.equal(buildAgentEnv(config).AGENT_BROWSER_ARGS, '--no-sandbox --no-proxy-server')
    assert.equal(await importCookies(config), 2)

    const calls = await readCalls(log)
    const xs = calls.find((call) => call.args.includes('xs'))
    assert.ok(xs)
    assert.ok(xs.args.includes('--httpOnly'))
    assert.ok(xs.args.includes('--secure'))
    assert.ok(xs.args.includes('1818824112'))
    assert.ok(calls.every((call) => call.profile === path.join(root, '.browser-state', 'profile')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser command lazily starts shell Chromium, isolates instances, reuses it, and reaps it when idle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    const { command: agentCommand, log } = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const shell = await makeFakeShell(root, chromium)
    const port = await freePort()
    const config = normalizeConfig({
      display: false,
      shell: { command: [process.execPath, shell], chromium: 'chromium' },
      agent: {
        command: agentCommand,
        session: 'arca-agent',
        profile: '.browser-state/agent',
        port,
        idleTimeout: 150,
        env: { FAKE_LOG: log },
      },
      cookies: false,
      userscript: false,
    }, root)

    await runAgentCommand(config, ['snapshot'], { instance: 'worker-a' })
    await runAgentCommand(config, ['get', 'url'], { instance: 'worker-a' })

    const calls = await readCalls(log)
    const attached = calls.filter((call) => call.cdp)
    assert.ok(attached.length >= 3)
    assert.ok(attached.every((call) => call.args.includes('--pin-tab')))
    assert.ok(attached.every((call) => call.args.includes('arca-agent-worker-a')))
    assert.ok(attached.every((call) => call.cdp === `http://127.0.0.1:${port}`))
    assert.ok(attached.every((call) => call.instance === 'worker-a'))
    assert.ok(attached.every((call) => call.harnessProfile === path.join(root, '.browser-state', 'agent', 'worker-a')))

    const shellCalls = await readCalls(path.join(root, 'shell.jsonl'))
    assert.equal(shellCalls.length, 1)
    assert.ok(shellCalls[0].includes(`--remote-debugging-port=${port}`))

    await Bun.sleep(450)
    assert.equal(await exists(path.join(root, '.browser-state', 'agent-worker-a-runtime', 'browser.pid')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('playwright CLI gets its own browser/profile and receives the CDP environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    const chromium = await makeFakeChromium(root)
    const playwright = await makeFakePlaywright(root)
    const configFile = path.join(root, 'e2e.toml')
    await writeFile(configFile, `
display = false
cookies = false
userscript = false

[playwright]
command = [${JSON.stringify(playwright)}]
executablePath = ${JSON.stringify(chromium)}
profile = ".browser-state/playwright"
idleTimeout = 100

[playwright.env]
FAKE_PLAYWRIGHT_LOG = ${JSON.stringify(path.join(root, 'playwright.jsonl'))}
`)

    const result = spawnSync(process.execPath, [
      harnessScript,
      'playwright',
      '--config',
      configFile,
      '--instance',
      'pw-a',
      '--',
      'test',
      'smoke',
      '--config',
      'playwright.e2e.config.js',
    ], {
      cwd: root,
      env: { ...process.env, E2E_CONFIG: path.join(root, 'missing.toml') },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    const [call] = await readCalls(path.join(root, 'playwright.jsonl'))
    assert.deepEqual(call.args, ['test', 'smoke', '--config', 'playwright.e2e.config.js'])
    assert.match(call.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(call.instance, 'pw-a')
    assert.equal(call.profile, path.join(root, '.browser-state', 'playwright', 'pw-a'))
    assert.notEqual(call.profile, path.join(root, '.browser-state', 'agent', 'pw-a'))
    await Bun.sleep(300)
    assert.equal(await exists(path.join(root, '.browser-state', 'playwright-pw-a-runtime', 'browser.pid')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser CLI passes harness options before -- and agent-browser args after it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    const { command: agentCommand, log } = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const shell = await makeFakeShell(root, chromium)
    const port = await freePort()
    const configFile = path.join(root, 'e2e.toml')
    await writeFile(configFile, `
display = false
cookies = false
userscript = false

[shell]
command = [${JSON.stringify(process.execPath)}, ${JSON.stringify(shell)}]
chromium = "chromium"

[agent]
command = ${JSON.stringify(agentCommand)}
session = "cli-agent"
profile = ".browser-state/agent"
idleTimeout = 100

[agent.env]
FAKE_LOG = ${JSON.stringify(log)}
`)

    const result = spawnSync(process.execPath, [
      harnessScript,
      'browser',
      '--config',
      configFile,
      '--instance',
      'cli-a',
      '--port',
      String(port),
      '--',
      'snapshot',
    ], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    const calls = await readCalls(log)
    assert.ok(calls.some((call) => call.args.at(-1) === 'snapshot'))
    assert.ok(calls.every((call) => call.args.includes('cli-agent-cli-a')))
    assert.ok(calls.every((call) => call.cdp === `http://127.0.0.1:${port}`))
    await Bun.sleep(300)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function makeFakeAgent(root) {
  const command = path.join(root, 'fake-agent.mjs')
  const log = path.join(root, 'agent.jsonl')
  const state = path.join(root, 'agent-state')
  await writeFile(command, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  args,
  profile: process.env.AGENT_BROWSER_PROFILE,
  cdp: process.env.E2E_HARNESS_CDP_ENDPOINT,
  instance: process.env.E2E_HARNESS_INSTANCE,
  harnessProfile: process.env.E2E_HARNESS_PROFILE,
  extensions: process.env.AGENT_BROWSER_EXTENSIONS,
  browserArgs: process.env.AGENT_BROWSER_ARGS,
  screenshotDir: process.env.AGENT_BROWSER_SCREENSHOT_DIR,
}) + '\\n')
if (args.includes('tab') && args.includes('list') && args.includes('--json')) {
  const count = existsSync(process.env.FAKE_STATE) ? Number(readFileSync(process.env.FAKE_STATE, 'utf8')) : 0
  const tabs = count === 0
    ? [{ tabId: 'base', url: 'about:blank' }]
    : [{ tabId: 'base', url: 'about:blank' }, { tabId: 'confirm', url: 'chrome-extension://manager/confirm' }]
  writeFileSync(process.env.FAKE_STATE, String(count + 1))
  console.log(JSON.stringify({ data: { tabs } }))
}
`)
  await chmod(command, 0o755)
  return { command, log, state }
}

async function makeFakeChromium(root) {
  const command = path.join(root, 'fake-chromium.mjs')
  await writeFile(command, `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const requested = Number(args.find((arg) => arg.startsWith('--remote-debugging-port='))?.split('=')[1] ?? 0)
const profile = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: requested,
  fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === '/json/version') return Response.json({ Browser: 'Fake Chromium' })
    return new Response('ok')
  },
})
if (profile) {
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'DevToolsActivePort'), String(server.port) + '\\n/devtools/browser/fake')
}
process.on('SIGTERM', () => {
  server.stop(true)
  process.exit(0)
})
setInterval(() => {}, 1000)
`)
  await chmod(command, 0o755)
  return command
}

async function makeFakeShell(root, chromium) {
  const command = path.join(root, 'fake-shell.mjs')
  await writeFile(command, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(path.join(root, 'shell.jsonl'))}, JSON.stringify(args) + '\\n')
if (args[0] !== 'chromium') throw new Error('expected chromium command')
const child = Bun.spawn([${JSON.stringify(chromium)}, ...args.slice(1)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
process.exit(await child.exited)
`)
  await chmod(command, 0o755)
  return command
}

async function makeFakePlaywright(root) {
  const command = path.join(root, 'fake-playwright.mjs')
  await writeFile(command, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_PLAYWRIGHT_LOG, JSON.stringify({
  args: process.argv.slice(2),
  endpoint: process.env.PLAYWRIGHT_CDP_ENDPOINT,
  instance: process.env.E2E_HARNESS_INSTANCE,
  profile: process.env.E2E_HARNESS_PROFILE,
}) + '\\n')
`)
  await chmod(command, 0o755)
  return command
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function readCalls(file) {
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
}

async function exists(file) {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}
