import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadLocalCookies, parseJsonCookies, parseNetscapeCookies } from '../skills/e2e/assets/browser/cookie-loader.ts'
import {
  createRuntime,
  hasRunningProcess,
  spawnOwned,
  stopOwnedProcess,
} from '../skills/e2e/assets/browser/runtime.ts'
import {
  buildAgentEnv,
  importCookies,
  inferProjectRoot,
  loadHarnessConfig,
  normalizeConfig,
  parsePluginOption,
  runAgentCommand,
  runPlaywrightCommand,
  startHarness,
  stopHarness,
} from '../skills/e2e/scripts/harness.ts'

const harnessScript = fileURLToPath(new URL('../skills/e2e/scripts/harness.ts', import.meta.url))

test('cookie parser accepts browser JSON and Netscape exports', () => {
  assert.equal(parseJsonCookies('[{"name":"sid","value":"x","domain":".example.com"}]')[0].name, 'sid')
  assert.equal(parseNetscapeCookies('.example.com\tTRUE\t/\tTRUE\t0\tsid\tx')[0].secure, true)
})

test('cookies.json takes precedence and an explicit cookie source can be selected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
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
    assert.equal(inferProjectRoot(path.join(root, 'skills', 'e2e')), root)
    assert.equal(inferProjectRoot(path.join(root, '.agents', 'skills', 'e2e')), root)

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

test('plugin config and CLI userscript syntax support latest and pinned ScriptCat', () => {
  const config = normalizeConfig({
    display: false,
    cookies: false,
    userscript: false,
    plugins: [
      { name: 'disable-csp' },
      { name: 'disable-csp' },
      { name: 'userscript', url: 'https://example.com/dev.user.js', version: '1.4.0' },
    ],
  }, '/tmp/arca-e2e')
  assert.equal(config.plugins.length, 3)
  assert.deepEqual(parsePluginOption('disable-csp'), { name: 'disable-csp' })
  assert.deepEqual(parsePluginOption('userscript=https://example.com/dev.user.js'), {
    name: 'userscript', url: 'https://example.com/dev.user.js',
  })
  assert.deepEqual(parsePluginOption('userscript@1.4.0=https://example.com/dev.user.js'), {
    name: 'userscript', url: 'https://example.com/dev.user.js', version: '1.4.0',
  })
})

test('disable-csp plugin is deduped for agent and Playwright browser launches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const { command: agentCommand, log } = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const playwright = await makeFakePlaywright(root)
    const config = normalizeConfig({
      display: false,
      agent: { command: agentCommand, executablePath: chromium, idleTimeout: 0, env: { FAKE_LOG: log } },
      playwright: {
        command: [playwright], executablePath: chromium, idleTimeout: 0,
        env: { FAKE_PLAYWRIGHT_LOG: path.join(root, 'playwright.jsonl') },
      },
      cookies: false,
      userscript: false,
      plugins: [{ name: 'disable-csp' }, { name: 'disable-csp' }],
    }, root)
    await runAgentCommand(config, ['snapshot'], { plugins: [{ name: 'disable-csp' }] })
    await runPlaywrightCommand(config, ['test'], { plugins: [{ name: 'disable-csp' }] })
    const launches = await readCalls(path.join(root, 'chromium.jsonl'))
    assert.equal(launches.length, 2)
    for (const args of launches) {
      const loadExtension = args.find((arg) => arg.startsWith('--load-extension='))
      assert.ok(loadExtension)
      assert.equal(loadExtension.slice('--load-extension='.length).split(',').length, 1)
      assert.match(loadExtension, /\.cache\/e2e\/extensions\/disable-csp\/[a-f0-9]+$/)
      assert.ok(args.includes('--disable-dev-shm-usage'))
    }
    await stopHarness(config)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('userscript plugin installs through ScriptCat without driving its install UI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const { command, log, state } = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const scriptCat = path.join(root, '.cache', 'e2e', 'scriptcat', 'v1.4.0')
    await mkdir(scriptCat, { recursive: true })
    await writeFile(path.join(scriptCat, 'manifest.json'), JSON.stringify({ name: 'ScriptCat' }))
    await writeFile(path.join(scriptCat, '.extension-root'), '.')
    const installUrl = 'data:text/javascript,//%20==UserScript==%0A//%20@name%20Arca%20E2E%0A//%20==/UserScript=='
    const config = normalizeConfig({
      display: false,
      agent: {
        command,
        executablePath: chromium,
        idleTimeout: 100,
        env: { FAKE_LOG: log, FAKE_STATE: state },
      },
      cookies: false,
      userscript: false,
      plugins: [{ name: 'userscript', url: installUrl, version: '1.4.0' }],
    }, root)

    await runAgentCommand(config, ['snapshot'], { instance: 'scriptcat-install' })

    const calls = await readCalls(log)
    const installCall = calls.find((call) => call.args.some((arg) => arg.includes('serviceWorker/script/installByCode')))
    assert.ok(installCall)
    const source = installCall.args.find((arg) => arg.includes('serviceWorker/script/installByCode'))
    const uuid = source.match(/"uuid":"([^"]+)"/)?.[1]
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.ok(calls.some((call) => call.args.includes('chrome-extension://manager/src/options.html')))
    assert.equal(calls.some((call) => call.args.includes('goto') && call.args.includes(installUrl)), false)
    await Bun.sleep(300)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ig-helper-shaped start owns ScriptCat setup, env, cookies, install, target, and cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const { command, log, state } = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    await writeFile(path.join(root, 'cookies.json'), '[{"name":"sessionid","value":"secret","domain":".instagram.com","secure":true}]')

    const config = normalizeConfig({
      display: false,
      agent: {
        command,
        session: 'ig-helper-agent',
        profile: '.browser-state/agent',
        executablePath: chromium,
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
    await stopHarness(config)

    const calls = await readCalls(log)
    assert.ok(calls.some((call) => call.args.includes('attach') && call.args.includes('ig-helper-agent')))
    assert.ok(calls.some((call) => call.args.includes('chrome://extensions/')))
    assert.ok(calls.some((call) => call.args.includes('sessionid') && call.args.includes('.instagram.com')))
    assert.ok(calls.some((call) => call.args.includes('http://127.0.0.1:9000/__vite-plugin-monkey.install.user.js')))
    assert.ok(calls.some((call) => call.args.includes('tab-select')))
    assert.ok(calls.some((call) => call.args.includes('https://www.instagram.com/')))
    assert.equal(calls.at(-1).args.at(-1), 'detach')
    assert.ok(calls.filter((call) => call.cdp).every((call) => call.harnessProfile === path.join(root, '.browser-state', 'agent')))
    assert.equal(await exists(path.join(root, '.browser-state', 'agent-default-runtime', 'browser.pid')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('orphic-shaped config pins its cookie source and browser args without local wrapper code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
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
    await runAgentCommand(config, ['eval', '() => location.href'], { instance: 'worker-a' })
    await runAgentCommand(config, ['open', 'https://example.com/'], { instance: 'worker-a' })

    const calls = await readCalls(log)
    const attached = calls.filter((call) => call.cdp)
    assert.ok(attached.length >= 3)
    assert.ok(attached.every((call) => call.args.includes('-s=arca-agent-worker-a') || call.args.includes('--session')))
    assert.ok(attached.every((call) => call.cdp === `http://127.0.0.1:${port}`))
    assert.ok(attached.every((call) => call.instance === 'worker-a'))
    assert.ok(attached.every((call) => call.harnessProfile === path.join(root, '.browser-state', 'agent', 'worker-a')))
    assert.ok(attached.some((call) => call.args.includes('goto') && call.args.includes('https://example.com/')))
    assert.ok(attached.every((call) => call.args[1] !== 'open'))

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
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

test('playwright browser enables a configured userscript manager before the suite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const { command: agentCommand, log, state } = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const playwright = await makeFakePlaywright(root)
    const config = normalizeConfig({
      display: false,
      agent: { command: agentCommand, env: { FAKE_LOG: log, FAKE_STATE: state } },
      playwright: {
        command: [playwright], executablePath: chromium, idleTimeout: 100,
        env: { FAKE_PLAYWRIGHT_LOG: path.join(root, 'playwright.jsonl') },
      },
      cookies: false,
      userscript: { manager: 'scriptcat', installOnStart: false },
    }, root)

    await runPlaywrightCommand(config, ['test'])

    const calls = await readCalls(log)
    assert.ok(calls.some((call) => call.args.includes('attach') && call.args.some((arg) => arg.endsWith('-playwright-default'))))
    assert.ok(calls.some((call) => call.args.includes('chrome://extensions/')))
    await Bun.sleep(300)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser CLI passes harness options before -- and Playwright CLI args after it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
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
      '--config',
      configFile,
      'browser',
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
    assert.ok(calls.every((call) => call.args.includes('-s=cli-agent-cli-a') || call.args.includes('--session')))
    assert.ok(calls.every((call) => call.cdp === `http://127.0.0.1:${port}`))
    await Bun.sleep(300)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stop CLI honors --instance and leaves sibling browser instances running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  const configFile = path.join(root, 'e2e.toml')
  try {
    const { command: agentCommand, log } = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    await writeFile(configFile, `
display = false
cookies = false
userscript = false

[agent]
command = ${JSON.stringify(agentCommand)}
executablePath = ${JSON.stringify(chromium)}
session = "stop-agent"
profile = ".browser-state/agent"
idleTimeout = 0

[agent.env]
FAKE_LOG = ${JSON.stringify(log)}
`)

    for (const instance of ['one', 'two']) {
      const start = spawnSync(process.execPath, [
        harnessScript, 'browser', '--config', configFile, '--instance', instance, '--', 'snapshot',
      ], { cwd: root, encoding: 'utf8' })
      assert.equal(start.status, 0, start.stderr)
    }

    const onePid = path.join(root, '.browser-state', 'agent-one-runtime', 'browser.pid')
    const twoPid = path.join(root, '.browser-state', 'agent-two-runtime', 'browser.pid')
    assert.equal(await exists(onePid), true)
    assert.equal(await exists(twoPid), true)

    const stopOne = spawnSync(process.execPath, [
      harnessScript, 'stop', '--config', configFile, '--instance', 'one',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(stopOne.status, 0, stopOne.stderr)
    assert.equal(await exists(onePid), false)
    assert.equal(await exists(twoPid), true)

    const stopTwo = spawnSync(process.execPath, [
      harnessScript, 'stop', '--config', configFile, '--instance', 'two',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(stopTwo.status, 0, stopTwo.stderr)
    assert.equal(await exists(twoPid), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function makeFakeAgent(root) {
  const command = path.join(root, 'fake-agent.mjs')
  const log = path.join(root, 'agent.jsonl')
  const state = path.join(root, 'agent-state')
  await writeFile(command, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const stateFile = process.env.FAKE_STATE ?? process.env.FAKE_LOG + '.state'
const sessionIndex = args.indexOf('--session')
const session = args.find((arg) => arg.startsWith('-s='))?.slice(3)
  ?? (sessionIndex >= 0 ? args[sessionIndex + 1] : 'default')
const sessionFile = stateFile + '.' + session
appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  args,
  profile: process.env.AGENT_BROWSER_PROFILE,
  cdp: process.env.E2E_HARNESS_CDP_ENDPOINT,
  instance: process.env.E2E_HARNESS_INSTANCE,
  harnessProfile: process.env.E2E_HARNESS_PROFILE,
}) + '\\n')
if (args[0] === 'attach') {
  writeFileSync(sessionFile, '0')
  process.exit(0)
}
if (args.includes('detach')) {
  rmSync(sessionFile, { force: true })
  process.exit(0)
}
if (args.includes('tab-list') && args.includes('--json')) {
  if (!existsSync(sessionFile)) process.exit(1)
  console.log(JSON.stringify({ result: '- 0: (current) [](about:blank)' }))
}
if (args.includes('run-code') && args.includes('--raw') && args.some((arg) => arg.includes('page.context().pages()'))) {
  if (!existsSync(sessionFile)) process.exit(1)
  const count = Number(readFileSync(sessionFile, 'utf8')) || 0
  const tabs = count === 0
    ? [{ tabId: '0', url: 'about:blank' }]
    : [{ tabId: '0', url: 'about:blank' }, { tabId: '1', url: 'chrome-extension://manager/confirm' }]
  writeFileSync(sessionFile, String(count + 1))
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
`)
  await chmod(command, 0o755)
  return { command, log, state }
}

async function makeFakeChromium(root) {
  const command = path.join(root, 'fake-chromium.mjs')
  await writeFile(command, `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
appendFileSync(path.join(path.dirname(process.argv[1]), 'chromium.jsonl'), JSON.stringify(args) + '\\n')
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
