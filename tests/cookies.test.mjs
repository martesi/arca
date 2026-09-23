import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished, test } from 'bun:test'
import { loadLocalCookies, parseJsonCookies, parseNetscapeCookies } from '../skills/e2e/assets/browser/cookie-loader.ts'

test('cookie parser accepts browser JSON and Netscape exports', () => {
  assert.equal(parseJsonCookies('[{"name":"sid","value":"x","domain":".example.com"}]')[0].name, 'sid')
  assert.equal(parseNetscapeCookies('.example.com\tTRUE\t/\tTRUE\t0\tsid\tx')[0].secure, true)
})

test('cookies.json takes precedence and an explicit cookie source can be selected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'cookies-old.txt'), '.example.com\tTRUE\t/\tFALSE\t0\told\tx\n')
  await writeFile(path.join(root, 'cookies.json'), '[{"name":"new","value":"x","domain":".example.com"}]')
  assert.deepEqual((await loadLocalCookies(root)).map((cookie) => cookie.name), ['new'])
  assert.deepEqual((await loadLocalCookies(root, { file: 'cookies-old.txt' })).map((cookie) => cookie.name), ['old'])
})
