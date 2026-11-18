import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished, test } from 'bun:test'
import { freePort, makeFakeAgent, makeFakeShell, readCalls } from './harness-fixtures.mjs'

const harnessScript = path.resolve(import.meta.dir, '../skills/e2e/scripts/harness.ts')

test('browser CLI selects profile/session and accepts launch overrides before --', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const driver = makeFakeAgent(root)
  const shell = makeFakeShell()
  const port = await freePort()
  const configFile = path.join(root, 'e2e.toml')
  await writeFile(path.join(root, 'cookies.json'), '[{"name":"sessionid","value":"secret","domain":".example.com"}]')
  await writeFile(configFile, Bun.TOML.stringify({
    shell: { command: [process.execPath, shell], executable: 'firefox' },
    profile: {
      default: { browser: 'firefox', args: ['--width=1280'], idleTimeout: 0 },
      inspect: { browser: 'firefox', args: ['--width=390'] },
    },
    cookies: { required: true },
  }))

  const result = Bun.spawnSync([process.execPath,
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
    stdout: 'pipe',
    stderr: 'pipe',
  })

  assert.equal(result.exitCode, 0, result.stderr.toString())
  const calls = await readCalls(driver.log)
  assert.ok(calls.some((call) => call.args.at(-1) === 'snapshot'))
  assert.ok(calls.some((call) => call.args.at(-1) === 'cookie-clear'))
  assert.equal(calls.some((call) => call.args.includes('sessionid')), false)
  assert.ok(calls.every((call) => call.session === 'inspect-cli-a'))
  assert.ok(calls.filter((call) => call.ws).every((call) => call.ws.startsWith(`ws://127.0.0.1:${port}/`)))
  const [launch] = await readCalls(path.join(root, 'shell.jsonl'))
  assert.equal(launch[0], 'node')
  const options = await Bun.file(path.join(root, '.cache', 'arca', 'runtime', 'browser-inspect', 'firefox-options.json')).json()
  assert.deepEqual(options.args, ['--width=390'])
  const ownerPid = Number(await Bun.file(path.join(root, '.cache', 'arca', 'runtime', 'browser-inspect', 'firefox-owner.pid')).text())

  const stop = Bun.spawnSync([
    process.execPath, harnessScript, 'stop', '--config', configFile, '--profile', 'inspect',
  ], {
    cwd: root,
    env: { ...process.env, E2E_HARNESS_DRIVER: driver.command },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  assert.equal(stop.exitCode, 0, stop.stderr.toString())
  assert.throws(() => process.kill(ownerPid, 0))
}, 30000)
