import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished, test } from 'bun:test'
import { buildAgentEnv, inferProjectRoot, loadHarnessConfig, normalizeConfig, parsePluginOption } from '../skills/e2e/scripts/harness.ts'

test('config defaults to cache-backed profiles, headless Firefox, and port 2000', () => {
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
  assert.equal(config.profiles.default.browser, 'firefox')
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
        browser: 'chromium',
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
  assert.equal(config.profiles.mobile.browser, 'chromium')
})

test('legacy false sentinels are rejected; omitted sections are the empty state', () => {
  assert.throws(() => normalizeConfig({ cookies: false }, '/tmp/arca-e2e'))
  assert.throws(() => normalizeConfig({ display: false }, '/tmp/arca-e2e'))
  assert.throws(() => normalizeConfig({ userscript: false }, '/tmp/arca-e2e'))
})

test('default harness config lives under project .config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.config'), { recursive: true })
  await writeFile(path.join(root, '.config', 'arca.toml'), Bun.TOML.stringify({}))
  const config = await loadHarnessConfig(root)
  assert.equal(config.root, root)
  assert.equal(config.profiles.default.port, 2000)
  assert.equal(inferProjectRoot(path.join(root, 'skills', 'e2e')), root)
  assert.equal(inferProjectRoot(path.join(root, '.agents', 'skills', 'e2e')), root)
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
