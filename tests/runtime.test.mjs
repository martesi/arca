import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'bun:test'
import { createRuntime, hasRunningProcess, spawnOwned, stopOwnedProcess } from '../skills/e2e/assets/browser/runtime.ts'

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
