import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished, test } from 'bun:test'
import { normalizeConfig, runAgent, runAgentCommand, stopHarness } from '../skills/e2e/scripts/harness.ts'
import { waitForUrls } from '../skills/e2e/assets/browser/runtime.ts'
import { freePort } from './harness-fixtures.mjs'

test('default Firefox executes pages, shares persistent state, and restarts cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arca-firefox-'))
  const port = await freePort()
  const server = Bun.spawn([process.execPath, path.join(import.meta.dir, 'fixtures/firefox-site.mjs'), String(port)])
  const url = `http://127.0.0.1:${port}/`
  await writeFile(path.join(root, 'cookies.json'), JSON.stringify([
    { name: 'arca', value: 'firefox', domain: '127.0.0.1', path: '/' },
  ]))
  const config = normalizeConfig({
    targetUrl: url, cookies: { required: true },
    profile: { default: { browser: 'firefox', port: 0, idleTimeout: 0 } },
  }, root, {})
  onTestFinished(async () => {
    await stopHarness(config)
    server.kill()
    await server.exited
    await rm(root, { recursive: true, force: true })
  })
  const evaluate = (code, session) => JSON.parse(runAgent(config, ['eval', code, '--raw'], { session, capture: true }))

  await waitForUrls([url])
  await runAgentCommand(config, ['snapshot'], { session: 'one' })
  assert.match(evaluate('() => navigator.userAgent', 'one'), /Firefox\//)
  assert.equal(evaluate('() => document.cookie', 'one'), 'arca=firefox')
  evaluate('() => { localStorage.setItem("arca", "persistent"); return true }', 'one')
  const runtime = path.join(root, '.cache', 'arca', 'runtime', 'browser-default')
  const pid = await readFile(path.join(runtime, 'browser.pid'), 'utf8')

  await runAgentCommand(config, ['snapshot'], { session: 'two' })
  assert.equal(await readFile(path.join(runtime, 'browser.pid'), 'utf8'), pid)
  assert.equal(evaluate('() => localStorage.getItem("arca")', 'two'), 'persistent')
  await stopHarness(config)
  assert.throws(() => process.kill(Number(pid), 0))

  await runAgentCommand(config, ['snapshot'], { session: 'one', cookies: false })
  assert.equal(evaluate('() => localStorage.getItem("arca")', 'one'), 'persistent')
  assert.equal(evaluate('() => document.cookie', 'one'), '')
}, 30000)

test('Firefox installs ScriptCat and preserves real userscript storage after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arca-firefox-scriptcat-'))
  const port = await freePort()
  const server = Bun.spawn([process.execPath, path.join(import.meta.dir, 'fixtures/firefox-site.mjs'), String(port)])
  const url = `http://127.0.0.1:${port}/`
  const config = normalizeConfig({
    targetUrl: url,
    profile: { default: { browser: 'firefox', port: 0, idleTimeout: 0 } },
    plugins: [{ name: 'userscript', url: `${url}proof.user.js`, version: '0.16.15' }],
  }, root, {})
  onTestFinished(async () => {
    await stopHarness(config)
    server.kill()
    await server.exited
    await rm(root, { recursive: true, force: true })
  })
  const runs = () => JSON.parse(runAgent(config, ['run-code', `async page => {
    await page.waitForFunction(() => document.body.dataset.userscriptRuns)
    return Number(await page.locator('body').getAttribute('data-userscript-runs'))
  }`, '--raw'], { capture: true }))
  await waitForUrls([url])
  await runAgentCommand(config, ['snapshot'])
  assert.equal(runs(), 1)
  await stopHarness(config)
  await runAgentCommand(config, ['snapshot'])
  assert.equal(runs(), 2)
}, 60000)
