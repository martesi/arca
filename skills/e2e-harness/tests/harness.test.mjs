import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadLocalCookies, parseJsonCookies, parseNetscapeCookies } from '../assets/browser/cookie-loader.mjs'
import { createRuntime } from '../assets/browser/runtime.mjs'

test('cookie parser accepts browser JSON and Netscape exports', () => {
  assert.equal(parseJsonCookies('[{"name":"sid","value":"x","domain":".example.com"}]')[0].name, 'sid')
  assert.equal(parseNetscapeCookies('.example.com\tTRUE\t/\tTRUE\t0\tsid\tx')[0].secure, true)
})

test('cookies.json takes precedence over cookies*.txt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    await writeFile(path.join(root, 'cookies-old.txt'), '.example.com\tTRUE\t/\tFALSE\t0\told\tx\n')
    await writeFile(path.join(root, 'cookies.json'), '[{"name":"new","value":"x","domain":".example.com"}]')
    assert.deepEqual((await loadLocalCookies(root)).map((cookie) => cookie.name), ['new'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime directory is repository-local and deterministic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-harness-'))
  try {
    assert.equal(createRuntime(root, 'agent').dir, path.join(root, '.browser-state', 'agent-runtime'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
