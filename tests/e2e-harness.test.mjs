import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
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
  normalizeConfig,
  startHarness,
  stopHarness,
} from '../skills/e2e-harness/scripts/harness.mjs'

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
