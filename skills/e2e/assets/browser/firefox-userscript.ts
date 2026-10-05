import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright'
import { expect } from 'playwright/test'
import { z } from 'zod'

const addonSchema = z.object({
  guid: z.string().regex(/^[\w{}@.-]+$/),
  current_version: z.object({
    version: z.string(),
    file: z.object({ url: z.url(), hash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  }),
})
const cacheSchema = z.object({ id: z.string().regex(/^[\w{}@.-]+$/), version: z.string() })
const uuidSchema = z.record(z.string(), z.string().uuid())

export interface FirefoxScriptCat {
  id: string
  version: string
  file: string
}

export async function ensureFirefoxScriptCat(cacheDir: string, version?: string): Promise<FirefoxScriptCat> {
  const root = path.join(cacheDir, 'scriptcat', 'firefox')
  const infoFile = path.join(root, 'addon.json')
  const file = path.join(root, 'scriptcat.xpi')
  if (version && existsSync(file) && existsSync(infoFile)) {
    const cached = cacheSchema.parse(JSON.parse(readFileSync(infoFile, 'utf8')))
    if (cached.version === version) return { ...cached, file }
  }
  const response = await fetch('https://addons.mozilla.org/api/v5/addons/addon/scriptcat/')
  if (!response.ok) throw new Error(`Failed to resolve Firefox ScriptCat: HTTP ${response.status}`)
  const addon = addonSchema.parse(await response.json())
  let release = addon.current_version
  if (version && release.version !== version) {
    const schema = z.object({
      next: z.url().nullable(),
      results: z.array(addonSchema.shape.current_version),
    })
    let next: string | null = 'https://addons.mozilla.org/api/v5/addons/addon/scriptcat/versions/?page_size=50'
    let found: typeof release | undefined
    while (next && !found) {
      const versions = await fetch(next)
      if (!versions.ok) throw new Error(`Failed to resolve ScriptCat ${version}: HTTP ${versions.status}`)
      const page = schema.parse(await versions.json())
      found = page.results.find((item) => item.version === version)
      next = page.next
    }
    if (!found) throw new Error(`Firefox ScriptCat ${version} is not published on Mozilla Add-ons`)
    release = found
  }
  const download = await fetch(release.file.url)
  if (!download.ok) throw new Error(`Failed to download Firefox ScriptCat: HTTP ${download.status}`)
  const bytes = new Uint8Array(await download.arrayBuffer())
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (hash !== release.file.hash) throw new Error('Firefox ScriptCat package hash mismatch')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, bytes)
  const info = { id: addon.guid, version: release.version }
  writeFileSync(infoFile, JSON.stringify(info))
  return { ...info, file }
}

export function prepareFirefoxScriptCat(profile: string, addon: FirefoxScriptCat) {
  const directory = path.join(profile, 'extensions')
  mkdirSync(directory, { recursive: true })
  const target = path.join(directory, `${addon.id}.xpi`)
  // Recopying identical packages triggers Firefox's add-on update/onboarding path.
  if (!existsSync(target) || !readFileSync(target).equals(readFileSync(addon.file)))
    copyFileSync(addon.file, target)
  const uuids = firefoxExtensionUuids(profile)
  uuids[addon.id] ??= crypto.randomUUID()
  return {
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 15,
    'extensions.webextensions.uuids': JSON.stringify(uuids),
    'intl.locale.requested': 'en-US',
  }
}

export async function installFirefoxUserscript(context: BrowserContext, profile: string, addonId: string, url: string, timeout: number) {
  const page = await context.newPage()
  const operation = async () => {
    const uuid = firefoxExtensionUuids(profile)[addonId]
    if (!uuid) throw new Error('Firefox ScriptCat extension UUID is unavailable')
    // BiDi does not emit normal load events for extension pages; commit is enough.
    await expect(async () => {
      await page.goto(`moz-extension://${uuid}/src/options.html`, { waitUntil: 'commit', timeout: 5000 })
    }).toPass({ timeout, intervals: [100] })
    await page.waitForFunction(() => document.body.innerText.includes('Installed Scripts'), undefined, { timeout })
    // Firefox's MV2 release uses ScriptCat's internal port API to open its normal install UI.
    const [install] = await Promise.all([
      context.waitForEvent('page', { timeout }),
      page.evaluate(`(url => {
        const port = browser.runtime.connect({ name: 'options' })
        port.postMessage({ action: 'script-importByUrl', data: url, stream: crypto.randomUUID(), channel: false })
      })(${JSON.stringify(url)})`),
    ])
    // The button appears before metadata loads; clicking it early cannot install.
    await install.waitForFunction((url) => /^(Install Script|Update Script) - .+ - ScriptCat$/.test(document.title) && document.body.innerText.includes(url), url, { timeout })
    // BiDi's isolated realm actions and close events stall on extension pages.
    await install.evaluate(() => {
      // Keep the receipt visible until Playwright closes the tab. ScriptCat's
      // window.close() otherwise leaves a stale BiDi page during attachment.
      window.close = () => undefined
      const button = [...document.querySelectorAll('button')].find((item) => /^(Install Script|Update Script)$/.test(item.textContent?.replace(/\s+/g, ' ').trim() ?? ''))
      if (!button) throw new Error('Firefox ScriptCat install button was not found')
      button.click()
    })
    await install.waitForFunction(() => /Install success|Update success/i.test(document.body.innerText), undefined, { timeout })
    await install.goto('about:blank', { waitUntil: 'commit', timeout })
    await install.close()
  }
  return operation().finally(async () => {
    if (!page.isClosed()) {
      await page.goto('about:blank', { waitUntil: 'commit', timeout })
      await page.close()
    }
  })
}

function firefoxExtensionUuids(profile: string): Record<string, string> {
  const file = path.join(profile, 'prefs.js')
  if (!existsSync(file)) return {}
  const value = readFileSync(file, 'utf8').split('\n')
    .find((line) => line.startsWith('user_pref("extensions.webextensions.uuids", '))
    ?.slice('user_pref("extensions.webextensions.uuids", '.length, -2)
  return value ? uuidSchema.parse(JSON.parse(JSON.parse(value))) : {}
}
