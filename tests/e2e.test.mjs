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
  startHarness,
  stopHarness,
  stopManagedHarness,
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

test('runtime state defaults under .cache/arca and owns only recorded processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const runtime = createRuntime(root, 'agent')
    assert.equal(runtime.dir, path.join(root, '.cache', 'arca', 'runtime', 'agent'))
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

test('config defaults to cache-backed profiles, headless Chromium, and port 2000', () => {
  const root = '/tmp/arca-e2e'
  const config = normalizeConfig({}, root, {})
  assert.equal(config.cacheDir, path.join(root, '.cache', 'arca'))
  assert.equal(config.playwrightDir, path.join(root, '.cache', 'arca', 'playwright'))
  assert.equal(config.runtimeDir, path.join(root, '.cache', 'arca', 'runtime'))
  assert.equal(config.shell, undefined)
  assert.equal(config.display, undefined)
  assert.equal(config.cookies, undefined)
  assert.equal(config.userscript, undefined)
  assert.equal(config.profiles.default.dataDir, path.join(root, '.cache', 'arca', 'browser', 'default'))
  assert.equal(config.profiles.default.headed, false)
  assert.equal(config.profiles.default.port, 2000)
  assert.equal(config.profiles.default.idleTimeout, 300000)
})

test('profile defaults are inherited while data directories remain profile-specific', () => {
  const root = '/tmp/arca-e2e'
  const config = normalizeConfig({
    cacheDir: '.tmp/arca',
    playwrightDir: '.tmp/playwright',
    shell: { command: ['nix', 'develop', '--command'], executable: 'chromium' },
    profile: {
      default: {
        args: ['--global'],
        extensions: ['./shared-extension'],
      },
      mobile: {
        args: ['--window-size=390,844'],
        port: 2200,
      },
    },
  }, root, {})

  assert.equal(config.cacheDir, path.join(root, '.tmp', 'arca'))
  assert.equal(config.playwrightDir, path.join(root, '.tmp', 'playwright'))
  assert.deepEqual(config.shell, { command: ['nix', 'develop', '--command'], executable: 'chromium' })
  assert.deepEqual(config.profiles.default.args, ['--global'])
  assert.equal(config.profiles.default.dataDir, path.join(root, '.tmp', 'arca', 'browser', 'default'))
  assert.deepEqual(config.profiles.mobile.args, ['--window-size=390,844'])
  assert.deepEqual(config.profiles.mobile.extensions, [path.join(root, 'shared-extension')])
  assert.equal(config.profiles.mobile.dataDir, path.join(root, '.tmp', 'arca', 'browser', 'mobile'))
  assert.equal(config.profiles.mobile.port, 2200)
})

test('legacy false sentinels are rejected; omitted sections are the empty state', () => {
  assert.throws(() => normalizeConfig({ cookies: false }, '/tmp/arca-e2e'))
  assert.throws(() => normalizeConfig({ display: false }, '/tmp/arca-e2e'))
  assert.throws(() => normalizeConfig({ userscript: false }, '/tmp/arca-e2e'))
})

test('default harness config lives under project .config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    await mkdir(path.join(root, '.config'), { recursive: true })
    await writeFile(path.join(root, '.config', 'arca.toml'), '')
    const config = await loadHarnessConfig(root)
    assert.equal(config.root, root)
    assert.equal(config.profiles.default.port, 2000)
    assert.equal(inferProjectRoot(path.join(root, 'skills', 'e2e')), root)
    assert.equal(inferProjectRoot(path.join(root, '.agents', 'skills', 'e2e')), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('plugin CLI syntax supports latest and pinned ScriptCat', () => {
  assert.deepEqual(parsePluginOption('disable-csp'), { name: 'disable-csp' })
  assert.deepEqual(parsePluginOption('userscript=https://example.com/dev.user.js'), {
    name: 'userscript', url: 'https://example.com/dev.user.js',
  })
  assert.deepEqual(parsePluginOption('userscript@1.4.0=https://example.com/dev.user.js'), {
    name: 'userscript', url: 'https://example.com/dev.user.js', version: '1.4.0',
  })
})

test('sessions share one profile browser instead of creating browser instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const port = await freePort()
    await withDriver(driver, async () => {
      const config = normalizeConfig({
        profile: { default: { executable: chromium, port, idleTimeout: 0 } },
      }, root)

      await runAgentCommand(config, ['snapshot'], { session: 'task-a' })
      await runAgentCommand(config, ['eval', '() => location.href'], { session: 'task-b' })

      const launches = await readCalls(path.join(root, 'chromium.jsonl'))
      assert.equal(launches.length, 1)
      assert.ok(launches[0].includes(`--user-data-dir=${path.join(root, '.cache', 'arca', 'browser', 'default')}`))

      const calls = await readCalls(driver.log)
      assert.ok(calls.some((call) => call.session === 'task-a'))
      assert.ok(calls.some((call) => call.session === 'task-b'))
      assert.ok(calls.filter((call) => call.cdp).every((call) =>
        call.harnessProfile === path.join(root, '.cache', 'arca', 'browser', 'default')
      ))
      assert.ok(calls.filter((call) => call.cdp).every((call) =>
        call.outputDir.startsWith(path.join(root, '.cache', 'arca', 'playwright', 'default'))
      ))

      await stopHarness(config)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('start keeps the managed browser alive until explicit stop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const port = await freePort()
    await withDriver(driver, async () => {
      const config = normalizeConfig({
        profile: { default: { executable: chromium, port, idleTimeout: 50 } },
      }, root)

      await startHarness(config, { session: 'long-running-suite' })
      const pidFile = path.join(root, '.cache', 'arca', 'runtime', 'browser-default', 'browser.pid')
      await Bun.sleep(200)
      assert.equal(await exists(pidFile), true)

      await stopHarness(config)
      assert.equal(await exists(pidFile), false)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('named profile replaces default startup args and gets its own cached data directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const port = await freePort()
    await withDriver(driver, async () => {
      const config = normalizeConfig({
        profile: {
          default: { executable: chromium, args: ['--global'], idleTimeout: 0 },
          mobile: { args: ['--mobile'], port },
        },
      }, root)

      await runAgentCommand(config, ['snapshot'], { profile: 'mobile', session: 'mobile-task' })
      const [launch] = await readCalls(path.join(root, 'chromium.jsonl'))
      assert.ok(launch.includes('--mobile'))
      assert.equal(launch.includes('--global'), false)
      assert.ok(launch.includes(`--user-data-dir=${path.join(root, '.cache', 'arca', 'browser', 'mobile')}`))
      await stopHarness(config, 'mobile')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shell uses executable consistently and profile executable overrides it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const shell = await makeFakeShell(root, chromium)
    const port = await freePort()
    await withDriver(driver, async () => {
      const config = normalizeConfig({
        shell: { command: [process.execPath, shell], executable: 'chromium' },
        profile: { default: { port, idleTimeout: 0 } },
      }, root)

      await runAgentCommand(config, ['snapshot'])
      const [shellArgs] = await readCalls(path.join(root, 'shell.jsonl'))
      assert.equal(shellArgs[0], 'chromium')
      await stopHarness(config)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extension plugins are deduped, cached under .cache/arca, and remain headless by default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const port = await freePort()
    await withDriver(driver, async () => {
      const config = normalizeConfig({
        profile: { default: { executable: chromium, port, idleTimeout: 0 } },
        plugins: [{ name: 'disable-csp' }, { name: 'disable-csp' }],
      }, root)

      await runAgentCommand(config, ['snapshot'], { plugins: [{ name: 'disable-csp' }] })
      const [launch] = await readCalls(path.join(root, 'chromium.jsonl'))
      const loadExtension = launch.find((arg) => arg.startsWith('--load-extension='))
      assert.ok(loadExtension)
      assert.equal(loadExtension.slice('--load-extension='.length).split(',').length, 1)
      assert.match(loadExtension, /\.cache\/arca\/extensions\/disable-csp\/[a-f0-9]+$/)
      assert.ok(launch.includes('--headless=new'))
      await stopHarness(config)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('userscript plugin caches ScriptCat under .cache/arca and installs without driving confirmation UI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const port = await freePort()
    const scriptCat = path.join(root, '.cache', 'arca', 'scriptcat', 'v1.4.0')
    await mkdir(scriptCat, { recursive: true })
    await writeFile(path.join(scriptCat, 'manifest.json'), JSON.stringify({ name: 'ScriptCat' }))
    await writeFile(path.join(scriptCat, '.extension-root'), '.')
    const installUrl = 'data:text/javascript,//%20==UserScript==%0A//%20@name%20Arca%20E2E%0A//%20==/UserScript=='

    await withDriver(driver, async () => {
      const config = normalizeConfig({
        profile: { default: { executable: chromium, port, idleTimeout: 0 } },
        plugins: [{ name: 'userscript', url: installUrl, version: '1.4.0' }],
      }, root)

      await runAgentCommand(config, ['snapshot'], { session: 'scriptcat-install' })
      const calls = await readCalls(driver.log)
      assert.ok(calls.some((call) => call.args.some((arg) => arg.includes('serviceWorker/script/installByCode'))))
      assert.ok(calls.some((call) => call.args.includes('chrome://extensions/')))
      assert.equal(calls.some((call) => call.args.includes('goto') && call.args.includes(installUrl)), false)
      await stopHarness(config)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('IG Helper shaped bootstrap imports cookies, installs userscript, and opens target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const port = await freePort()
    await writeFile(path.join(root, 'cookies.json'), '[{"name":"sessionid","value":"secret","domain":".instagram.com","secure":true}]')

    await withDriver(driver, async () => {
      const config = normalizeConfig({
        targetUrl: 'https://www.instagram.com/',
        profile: {
          default: {
            executable: chromium,
            port,
            idleTimeout: 0,
            args: ['--disable-features=LocalNetworkAccessChecks'],
          },
        },
        cookies: { required: true },
        userscript: {
          manager: 'scriptcat',
          installUrl: 'http://127.0.0.1:9000/ig-helper.dev.user.js',
        },
      }, root)

      await startHarness(config, { session: 'ig-helper' })
      assert.equal(await importCookies(config, { profile: 'default', session: 'ig-helper' }), 1)
      const calls = await readCalls(driver.log)
      assert.ok(calls.some((call) => call.args.includes('sessionid') && call.args.includes('.instagram.com')))
      assert.ok(calls.some((call) => call.args.includes('http://127.0.0.1:9000/ig-helper.dev.user.js')))
      assert.ok(calls.some((call) => call.args.includes('https://www.instagram.com/')))
      assert.ok(calls.some((call) => call.args.includes('attach') && call.args.includes('ig-helper')))
      await stopHarness(config)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser CLI selects profile/session and accepts launch overrides before --', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const shell = await makeFakeShell(root, chromium)
    const port = await freePort()
    const configFile = path.join(root, 'e2e.toml')
    await writeFile(path.join(root, 'cookies.json'), '[{"name":"sessionid","value":"secret","domain":".example.com"}]')
    await writeFile(configFile, `
[shell]
command = [${JSON.stringify(process.execPath)}, ${JSON.stringify(shell)}]
executable = "chromium"

[profile.default]
args = ["--global"]
idleTimeout = 0

[profile.inspect]
args = ["--inspect"]

[cookies]
required = true
`)

    const result = spawnSync(process.execPath, [
      harnessScript,
      '--config',
      configFile,
      'browser',
      '--profile',
      'inspect',
      '--session',
      'cli-a',
      '--port',
      String(port),
      '--no-cookies',
      '--',
      'snapshot',
    ], {
      cwd: root,
      env: { ...process.env, E2E_HARNESS_DRIVER: driver.command },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    const calls = await readCalls(driver.log)
    assert.ok(calls.some((call) => call.args.at(-1) === 'snapshot'))
    assert.ok(calls.some((call) => call.args.at(-1) === 'cookie-clear'))
    assert.equal(calls.some((call) => call.args.includes('sessionid')), false)
    assert.ok(calls.every((call) => call.session === 'cli-a'))
    assert.ok(calls.filter((call) => call.cdp).every((call) => call.cdp === `http://127.0.0.1:${port}`))
    const [launch] = await readCalls(path.join(root, 'shell.jsonl'))
    assert.ok(launch.includes('--inspect'))
    assert.equal(launch.includes('--global'), false)

    const stop = spawnSync(process.execPath, [
      harnessScript, 'stop', '--config', configFile, '--profile', 'inspect',
    ], {
      cwd: root,
      env: { ...process.env, E2E_HARNESS_DRIVER: driver.command },
      encoding: 'utf8',
    })
    assert.equal(stop.status, 0, stop.stderr)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stopping one profile leaves another profile browser running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  try {
    const driver = await makeFakeAgent(root)
    const chromium = await makeFakeChromium(root)
    const onePort = await freePort()
    const twoPort = await freePort()

    await withDriver(driver, async () => {
      const config = normalizeConfig({
        profile: {
          default: { executable: chromium, port: onePort, idleTimeout: 0 },
          mobile: { port: twoPort },
        },
      }, root)

      await runAgentCommand(config, ['snapshot'], { profile: 'default', session: 'one' })
      await runAgentCommand(config, ['snapshot'], { profile: 'mobile', session: 'two' })

      const onePid = path.join(root, '.cache', 'arca', 'runtime', 'browser-default', 'browser.pid')
      const twoPid = path.join(root, '.cache', 'arca', 'runtime', 'browser-mobile', 'browser.pid')
      assert.equal(await exists(onePid), true)
      assert.equal(await exists(twoPid), true)

      await stopManagedHarness(config, 'mobile')
      assert.equal(await exists(onePid), true)
      assert.equal(await exists(twoPid), false)
      await stopManagedHarness(config, 'default')
      assert.equal(await exists(onePid), false)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildAgentEnv reflects profile startup settings and Playwright output cache', () => {
  const root = '/tmp/arca-e2e'
  const config = normalizeConfig({
    playwrightDir: '.cache/custom-playwright',
    profile: {
      default: {
        executable: '/custom/chromium',
        extensions: ['./one', './two'],
        args: ['--no-sandbox'],
      },
    },
  }, root, {})

  const env = buildAgentEnv(config, { PLAYWRIGHT_MCP_OUTPUT_DIR: '/stale/output' }, 'default')
  assert.equal(env.AGENT_BROWSER_PROFILE, path.join(root, '.cache', 'arca', 'browser', 'default'))
  assert.equal(env.AGENT_BROWSER_EXECUTABLE_PATH, '/custom/chromium')
  assert.equal(env.AGENT_BROWSER_EXTENSIONS, `${path.join(root, 'one')},${path.join(root, 'two')}`)
  assert.equal(env.AGENT_BROWSER_ARGS, '--no-sandbox')
  assert.equal(env.PLAYWRIGHT_MCP_OUTPUT_DIR, path.join(root, '.cache', 'custom-playwright', 'default', path.basename(root)))
})

async function makeFakeAgent(root) {
  const command = path.join(root, 'fake-agent.mjs')
  const log = path.join(root, 'agent.jsonl')
  await writeFile(command, `#!/usr/bin/env bun
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
}) + '\\n')
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
`)
  await chmod(command, 0o755)
  return { command, log }
}

async function withDriver(driver, action) {
  const previous = process.env.E2E_HARNESS_DRIVER
  process.env.E2E_HARNESS_DRIVER = driver.command
  try {
    return await action()
  } finally {
    if (previous === undefined) delete process.env.E2E_HARNESS_DRIVER
    else process.env.E2E_HARNESS_DRIVER = previous
  }
}

async function makeFakeChromium(root) {
  const command = path.join(root, 'fake-chromium.mjs')
  await writeFile(command, `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
appendFileSync(path.join(path.dirname(process.argv[1]), 'chromium.jsonl'), JSON.stringify(args) + '\\n')
const requested = Number(args.find((arg) => arg.startsWith('--remote-debugging-port='))?.split('=')[1] ?? 2000)
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
if (args[0] !== 'chromium') throw new Error('expected chromium executable')
const child = Bun.spawn([${JSON.stringify(chromium)}, ...args.slice(1)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
process.exit(await child.exited)
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
