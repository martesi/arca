import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished, test } from 'bun:test'
import { importCookies, normalizeConfig, runAgentCommand, startHarness, stopHarness, stopManagedHarness } from '../skills/e2e/scripts/harness.ts'
import { exists, freePort, makeFakeAgent, makeFakeChromium, makeFakeShell, readCalls } from './harness-fixtures.mjs'

test('sessions share one profile browser instead of creating browser instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const port = await freePort()
  const config = normalizeConfig({
    profile: { default: { port, idleTimeout: 0 } },
  }, root)
  config.driverCommand = driver.command

  await runAgentCommand(config, ['snapshot'], { session: 'task-a' })
  await runAgentCommand(config, ['eval', '() => location.href'], { session: 'task-b' })

  const optionsFile = path.join(root, '.cache', 'arca', 'runtime', 'browser-default', 'firefox-options.json')
  const launch = await Bun.file(optionsFile).json()
  assert.equal(launch.profile, path.join(root, '.cache', 'arca', 'browser', 'default'))

  const calls = await readCalls(driver.log)
  assert.ok(calls.some((call) => call.session === 'default-task-a'))
  assert.ok(calls.some((call) => call.session === 'default-task-b'))
  assert.ok(calls.filter((call) => call.ws).every((call) =>
    call.harnessProfile === path.join(root, '.cache', 'arca', 'browser', 'default')
  ))
  assert.ok(calls.filter((call) => call.ws).every((call) =>
    call.outputDir.startsWith(path.join(root, '.cache', 'arca', 'playwright', 'default'))
  ))

  await stopHarness(config)
}, 30000)

test('start keeps the managed browser alive until explicit stop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const port = await freePort()
  const config = normalizeConfig({
    profile: { default: { port, idleTimeout: 50 } },
  }, root)
  config.driverCommand = driver.command

  await startHarness(config, { session: 'long-running-suite' })
  const pidFile = path.join(root, '.cache', 'arca', 'runtime', 'browser-default', 'browser.pid')
  await Bun.sleep(200)
  assert.equal(await exists(pidFile), true)

  await stopHarness(config)
  assert.equal(await exists(pidFile), false)
}, 30000)

test('named profile replaces default startup args and gets its own cached data directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const port = await freePort()
  const config = normalizeConfig({
    profile: {
      default: { args: ['--width=1280'], idleTimeout: 0 },
      mobile: { args: ['--width=390'], port },
    },
  }, root)
  config.driverCommand = driver.command

  await runAgentCommand(config, ['snapshot'], { profile: 'mobile', session: 'mobile-task' })
  const launch = await Bun.file(path.join(root, '.cache', 'arca', 'runtime', 'browser-mobile', 'firefox-options.json')).json()
  assert.deepEqual(launch.args, ['--width=390'])
  assert.equal(launch.profile, path.join(root, '.cache', 'arca', 'browser', 'mobile'))
  await stopHarness(config, 'mobile')
}, 30000)

test('shell uses executable consistently and profile executable overrides it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const shell = makeFakeShell()
  const port = await freePort()
  const config = normalizeConfig({
    shell: { command: [process.execPath, shell], executable: 'firefox' },
    profile: { default: { port, idleTimeout: 0 } },
  }, root)
  config.driverCommand = driver.command

  await runAgentCommand(config, ['snapshot'])
  const [shellArgs] = await readCalls(path.join(root, 'shell.jsonl'))
  assert.equal(shellArgs[0], process.execPath)
  const ownerPid = Number(await Bun.file(path.join(root, '.cache', 'arca', 'runtime', 'browser-default', 'firefox-owner.pid')).text())
  await stopHarness(config)
  assert.throws(() => process.kill(ownerPid, 0))
}, 30000)

test('extension plugins are deduped, cached under .cache/arca, and remain headless by default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const chromium = makeFakeChromium()
  const port = await freePort()
  const config = normalizeConfig({
    profile: { default: { browser: 'chromium', executable: chromium, port, idleTimeout: 0 } },
    plugins: [{ name: 'disable-csp' }, { name: 'disable-csp' }],
  }, root)
  config.driverCommand = driver.command

  await runAgentCommand(config, ['snapshot'], { plugins: [{ name: 'disable-csp' }] })
  const [launch] = await readCalls(path.join(root, 'chromium.jsonl'))
  const loadExtension = launch.find((arg) => arg.startsWith('--load-extension='))
  assert.ok(loadExtension)
  assert.equal(loadExtension.slice('--load-extension='.length).split(',').length, 1)
  assert.match(loadExtension, /\.cache\/arca\/extensions\/disable-csp\/[a-f0-9]+$/)
  assert.ok(launch.includes('--headless=new'))
  await stopHarness(config)
})

test('userscript plugin caches ScriptCat under .cache/arca and installs without driving confirmation UI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const chromium = makeFakeChromium()
  const port = await freePort()
  const scriptCat = path.join(root, '.cache', 'arca', 'scriptcat', 'v1.4.0')
  await mkdir(scriptCat, { recursive: true })
  await writeFile(path.join(scriptCat, 'manifest.json'), JSON.stringify({ name: 'ScriptCat' }))
  await writeFile(path.join(scriptCat, '.extension-root'), '.')
  const installUrl = 'data:text/javascript,//%20==UserScript==%0A//%20@name%20Arca%20E2E%0A//%20==/UserScript=='

  const config = normalizeConfig({
    profile: { default: { browser: 'chromium', executable: chromium, port, idleTimeout: 0 } },
    plugins: [{ name: 'userscript', url: installUrl, version: '1.4.0' }],
  }, root)
  config.driverCommand = driver.command

  await runAgentCommand(config, ['snapshot'], { session: 'scriptcat-install' })
  const calls = await readCalls(driver.log)
  assert.ok(calls.some((call) => call.args.some((arg) => arg.includes('serviceWorker/script/installByCode'))))
  assert.ok(calls.some((call) => call.args.includes('chrome://extensions/')))
  assert.equal(calls.some((call) => call.args.includes('goto') && call.args.includes(installUrl)), false)
  await stopHarness(config)
})

test('IG Helper shaped bootstrap imports cookies, installs userscript, and opens target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const chromium = makeFakeChromium()
  const port = await freePort()
  await writeFile(path.join(root, 'cookies.json'), '[{"name":"sessionid","value":"secret","domain":".instagram.com","secure":true}]')

  const scriptCat = path.join(root, '.cache', 'arca', 'scriptcat', 'v1.4.0')
  await mkdir(scriptCat, { recursive: true })
  await writeFile(path.join(scriptCat, 'manifest.json'), JSON.stringify({ name: 'ScriptCat' }))
  await writeFile(path.join(scriptCat, '.extension-root'), '.')
  const server = Bun.serve({ port: 0, fetch: () => new Response('// ==UserScript==\n// @name IG Helper\n// @version 1\n// ==/UserScript==') })
  onTestFinished(() => server.stop(true))
  const scriptUrl = `http://127.0.0.1:${server.port}/ig-helper.dev.user.js`
  const config = normalizeConfig({
    targetUrl: 'https://www.instagram.com/',
    profile: {
      default: {
        browser: 'chromium', executable: chromium,
        port,
        idleTimeout: 0,
        args: ['--disable-features=LocalNetworkAccessChecks'],
      },
    },
    cookies: { required: true },
    plugins: [{ name: 'userscript', url: scriptUrl, version: '1.4.0' }],
  }, root)
  config.driverCommand = driver.command

  await startHarness(config, { session: 'ig-helper' })
  assert.equal(await importCookies(config, { profile: 'default', session: 'ig-helper' }), 1)
  const calls = await readCalls(driver.log)
  assert.ok(calls.some((call) => call.args.includes('sessionid') && call.args.includes('.instagram.com')))
  assert.ok(calls.some((call) => call.args.some((arg) => arg.includes('serviceWorker/script/installByCode'))))
  assert.equal(calls.some((call) => call.args.includes('goto') && call.args.includes(scriptUrl)), false)
  assert.ok(calls.some((call) => call.args.includes('https://www.instagram.com/')))
  assert.ok(calls.some((call) => call.args.includes('attach') && call.args.includes('default-ig-helper')))
  await stopHarness(config)
})

test('stopping one profile leaves another profile browser running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const onePort = await freePort()
  const twoPort = await freePort()

  const config = normalizeConfig({
    profile: {
      default: { port: onePort, idleTimeout: 0 },
      mobile: { port: twoPort },
    },
  }, root)
  config.driverCommand = driver.command

  await runAgentCommand(config, ['snapshot'], { profile: 'default', session: 'shared-task' })
  await runAgentCommand(config, ['snapshot'], { profile: 'mobile', session: 'shared-task' })

  const calls = await readCalls(driver.log)
  assert.ok(calls.some(call => call.args.includes('attach') && call.session === 'default-shared-task' && call.ws?.startsWith(`ws://127.0.0.1:${onePort}/`)))
  assert.ok(calls.some(call => call.args.includes('attach') && call.session === 'mobile-shared-task' && call.ws?.startsWith(`ws://127.0.0.1:${twoPort}/`)))
  const onePid = path.join(root, '.cache', 'arca', 'runtime', 'browser-default', 'browser.pid')
  const twoPid = path.join(root, '.cache', 'arca', 'runtime', 'browser-mobile', 'browser.pid')
  assert.equal(await exists(onePid), true)
  assert.equal(await exists(twoPid), true)

  await stopManagedHarness(config, 'mobile')
  assert.equal(await exists(onePid), true)
  assert.equal(await exists(twoPid), false)
  await stopManagedHarness(config, 'default')
  assert.equal(await exists(onePid), false)
}, 30000)
