#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { loadLocalCookies } from '../assets/browser/cookie-loader.ts'
import {
  beginIdleWindow,
  ensureCdpBrowser,
  scheduleIdleStop,
  stopCdpBrowserAndWait,
  type CdpBrowser,
} from '../assets/browser/cdp-runtime.ts'
import {
  createRuntime,
  ensureXvfb,
  isReachable,
  spawnOwned,
  stopOwnedProcess,
  waitForUrls,
  type Runtime,
} from '../assets/browser/runtime.ts'

const DEFAULT_CONFIG = '.config/arca.toml'
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IDLE_TIMEOUT = 5 * 60_000
const DEFAULT_BROWSER_PORT = 2000
const DEFAULT_CDP_TIMEOUT = 30_000
const PLAYWRIGHT_CLI = path.join(SKILL_ROOT, 'node_modules', '.bin', 'playwright-cli')
const envValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const envSchema = z.record(z.string(), envValueSchema)
const commandSchema = z.union([z.string(), z.array(z.string())])
const devSchema = z.object({
  command: z.array(z.string()),
  ready: z.array(z.string()).optional(),
  env: envSchema.optional(),
})
const profileSchema = z.object({
  dataDir: z.string().optional(),
  executable: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  headed: z.boolean().optional(),
  port: z.number().int().optional(),
  idleTimeout: z.number().nonnegative().optional(),
})
const pluginSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('userscript'),
    url: z.string().url(),
    version: z.string().optional(),
  }),
  z.object({ name: z.literal('disable-csp') }),
])
const harnessInputSchema = z.object({
  cacheDir: z.string().optional(),
  playwrightDir: z.string().optional(),
  shell: z.object({ command: commandSchema.optional(), executable: z.string().optional() }).optional(),
  display: z.object({ value: z.string().optional(), timeout: z.number().nonnegative().optional() }).optional(),
  dev: z.union([devSchema, z.array(devSchema)]).optional(),
  profile: z.record(z.string(), profileSchema).optional(),
  cookies: z.object({ file: z.string().optional(), required: z.boolean().optional() }).optional(),
  userscript: z.object({
    installUrl: z.string().optional(),
    installOnStart: z.boolean().optional(),
    enableUserScripts: z.boolean().optional(),
    manager: z.string().optional(),
    managerName: z.string().optional(),
    confirmationTimeout: z.number().nonnegative().optional(),
  }).optional(),
  plugins: z.array(pluginSchema).optional(),
  targetUrl: z.string().optional(),
})
const INSTALL_READY = `() => {
  const confirm = document.querySelector('#confirm')
  if (confirm && !confirm.disabled) return true
  return [...document.querySelectorAll('button')].some((button) =>
    /^(Install Script|Update Script)$/.test(button.textContent?.trim() ?? '')
  )
}`
const INSTALL_CLICK = `() => {
  const confirm = document.querySelector('#confirm')
  if (confirm && !confirm.disabled) {
    confirm.click()
    return 'violentmonkey'
  }
  const button = [...document.querySelectorAll('button')].find((item) =>
    /^(Install Script|Update Script)$/.test(item.textContent?.trim() ?? '')
  )
  if (!button) throw new Error('userscript confirmation control not found')
  button.click()
  return 'scriptcat'
}`
const INSTALL_DONE = `() => {
  const text = document.body?.innerText ?? ''
  if (/Script (?:installed|updated)\./i.test(text) || /(?:installed|updated)/i.test(document.querySelector('.status')?.textContent ?? '')) return true
  const confirm = document.querySelector('#confirm')
  const scriptcat = [...document.querySelectorAll('button')].some((button) =>
    /^(Install Script|Update Script)$/.test(button.textContent?.trim() ?? '')
  )
  return !confirm && !scriptcat
}`

export async function loadHarnessConfig(
  root = inferProjectRoot(),
  configFile = DEFAULT_CONFIG,
  env = process.env,
) {
  const file = path.isAbsolute(configFile) ? configFile : path.resolve(root, configFile)
  if (!existsSync(file)) throw new Error(`E2E harness config not found: ${file}`)
  return normalizeConfig(parseToml(readFileSync(file, 'utf8')), root, env)
}

export function inferProjectRoot(skillRoot = SKILL_ROOT) {
  const root = path.resolve(skillRoot, '../..')
  return path.basename(root) === '.agents' ? path.dirname(root) : root
}

export function normalizeConfig(input: unknown, root = process.cwd(), env = process.env): HarnessConfig {
  const parsed = harnessInputSchema.parse(input)
  const cacheDir = resolveProjectPath(root, parsed.cacheDir ?? '.cache/arca')
  const playwrightDir = resolveProjectPath(root, parsed.playwrightDir ?? path.join(cacheDir, 'playwright'))
  const rawProfiles = parsed.profile ?? {}
  const defaultProfile = rawProfiles.default ?? {}
  const profileNames = unique(['default', ...Object.keys(rawProfiles)])
  return {
    root,
    cacheDir,
    playwrightDir,
    runtimeDir: path.join(cacheDir, 'runtime'),
    shell: parsed.shell ? {
      command: normalizeCommand(parsed.shell.command),
      executable: parsed.shell.executable ?? 'chromium',
    } : undefined,
    display: parsed.display ? {
      value: parsed.display.value ?? env.DISPLAY ?? ':99',
      timeout: parsed.display.timeout ?? 5000,
    } : undefined,
    dev: Array.isArray(parsed.dev) ? parsed.dev : parsed.dev ? [parsed.dev] : [],
    profiles: Object.fromEntries(profileNames.map((name) => {
      const value = name === 'default' ? defaultProfile : { ...defaultProfile, ...rawProfiles[name] }
      const dataDir = rawProfiles[name]?.dataDir
        ?? (name === 'default' ? defaultProfile.dataDir : undefined)
        ?? path.join(cacheDir, 'browser', name)
      const extensions = value.extensions ?? commaList(env.AGENT_BROWSER_EXTENSIONS)
      return [normalizeProfileName(name), {
        dataDir: resolveProjectPath(root, dataDir),
        executable: value.executable
          ?? env.AGENT_BROWSER_EXECUTABLE_PATH
          ?? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        extensions: extensions.filter(Boolean).map((item) => resolveProjectPath(root, item)),
        args: value.args ?? [],
        headed: value.headed ?? false,
        port: normalizePort(value.port ?? DEFAULT_BROWSER_PORT),
        idleTimeout: normalizeTimeout(value.idleTimeout ?? DEFAULT_IDLE_TIMEOUT),
      }]
    })),
    cookies: parsed.cookies ? {
      file: parsed.cookies?.file,
      required: parsed.cookies?.required ?? false,
    } : undefined,
    userscript: parsed.userscript ? {
      installUrl: parsed.userscript.installUrl,
      installOnStart: parsed.userscript.installOnStart ?? Boolean(parsed.userscript.installUrl),
      enableUserScripts: parsed.userscript.enableUserScripts ?? Boolean(parsed.userscript.manager),
      manager: parsed.userscript.manager,
      managerName: parsed.userscript.managerName ?? managerName(parsed.userscript.manager),
      confirmationTimeout: parsed.userscript.confirmationTimeout ?? 30_000,
    } : undefined,
    plugins: parsed.plugins ?? [],
    targetUrl: parsed.targetUrl,
  }
}

type EnvValues = Record<string, string | number | boolean | null>

interface DevConfig {
  command: string[]
  ready?: string[]
  env?: EnvValues
}

interface ProfileConfig {
  dataDir: string
  executable?: string
  extensions: string[]
  args: string[]
  headed: boolean
  port: number
  idleTimeout: number
}

interface HarnessConfig {
  root: string
  cacheDir: string
  playwrightDir: string
  runtimeDir: string
  shell?: { command: string[]; executable: string }
  display?: { value: string; timeout: number }
  dev: DevConfig[]
  profiles: Record<string, ProfileConfig>
  cookies?: { file?: string; required: boolean }
  userscript?: {
    installUrl?: string
    installOnStart: boolean
    enableUserScripts: boolean
    manager?: string
    managerName?: string
    confirmationTimeout: number
  }
  plugins: PluginConfig[]
  targetUrl?: string
}

type PluginConfig =
  | { name: 'userscript'; url: string; version?: string }
  | { name: 'disable-csp' }

interface PreparedPlugins {
  extensions: string[]
  key: string
  scriptCatId?: string
  userscriptUrls: string[]
}

interface ProfileScope {
  name: string
  profile: ProfileConfig
  session: string
}

interface BrowserTab {
  tabId: string
  url: string
}

interface AgentOptions {
  capture?: boolean
  allowFailure?: boolean
  endpoint?: string
  profile?: string
  session?: string
  dataDir?: string
  sensitive?: boolean
}

interface SurfaceOptions {
  profile?: string
  session?: string
  port?: number
  browserArgs?: string[]
  plugins?: PluginConfig[]
  keepAlive?: boolean
}

export function buildAgentEnv(
  config: HarnessConfig,
  base = process.env,
  profile = 'default',
): NodeJS.ProcessEnv {
  const scope = profileScope(config, profile)
  const env = { ...base }
  env.AGENT_BROWSER_PROFILE = scope.profile.dataDir
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(scope.profile.idleTimeout)
  if (scope.profile.executable) env.AGENT_BROWSER_EXECUTABLE_PATH = scope.profile.executable
  if (scope.profile.extensions.length) env.AGENT_BROWSER_EXTENSIONS = scope.profile.extensions.join(',')
  if (scope.profile.args.length) env.AGENT_BROWSER_ARGS = scope.profile.args.join(' ')
  env.PLAYWRIGHT_MCP_OUTPUT_DIR ??= path.join(config.playwrightDir, scope.name, scope.session)
  return env
}

export async function startHarness(config: HarnessConfig, options: SurfaceOptions = {}): Promise<void> {
  await runAgentCommand(config, ['snapshot'], { ...options, keepAlive: true })
}

export async function stopHarness(config: HarnessConfig, profile?: string): Promise<void> {
  await stopManagedHarness(config, profile)
}

export async function importCookies(config: HarnessConfig, agentOptions: AgentOptions = {}): Promise<number> {
  if (!config.cookies) return 0
  const cookies = await loadLocalCookies(config.root, { file: config.cookies.file })
  if (!cookies.length && config.cookies.required) {
    const source = config.cookies.file ?? 'cookies.json or cookies*.txt'
    throw new Error(`Required cookie source not found or empty: ${source}`)
  }

  for (const cookie of cookies) {
    const args = [
      'cookie-set',
      cookie.name,
      cookie.value,
      '--domain',
      cookie.domain,
      '--path',
      cookie.path ?? '/',
    ]
    if (cookie.secure) args.push('--secure')
    if (cookie.httpOnly) args.push('--httpOnly')
    if (cookie.expires > 0) args.push('--expires', String(cookie.expires))
    runAgent(config, args, { ...agentOptions, sensitive: true })
  }
  return cookies.length
}

export async function installUserscript(config: HarnessConfig, agentOptions: AgentOptions = {}): Promise<void> {
  const installUrl = config.userscript && config.userscript.installUrl
  if (!installUrl) throw new Error('userscript.installUrl is required')

  return installUserscriptUrl(config, installUrl, agentOptions)
}

async function installUserscriptUrl(
  config: HarnessConfig,
  installUrl: string,
  agentOptions: AgentOptions = {},
): Promise<void> {

  const before = new Set((await listTabs(config, agentOptions)).map((tab) => tab.tabId))
  runAgent(config, ['tab-new', 'about:blank'], agentOptions)
  try {
    runAgent(config, ['goto', installUrl], agentOptions)

    const confirmation = await waitForConfirmationTab(config, before, agentOptions)
    runAgent(config, ['tab-select', confirmation.tabId], agentOptions)
    runAgent(config, ['run-code', `async page => { await page.waitForFunction(${INSTALL_READY}); return true }`], agentOptions)
    runAgent(config, ['eval', INSTALL_CLICK], agentOptions)
    runAgent(config, ['run-code', `async page => { await page.waitForFunction(${INSTALL_DONE}); return true }`], agentOptions)
  } finally {
    const extraTabs = (await listTabs(config, agentOptions))
      .filter((tab) => !before.has(tab.tabId))
      .sort((left, right) => Number(right.tabId) - Number(left.tabId))
    for (const tab of extraTabs) {
      runAgent(config, ['tab-close', tab.tabId], { ...agentOptions, allowFailure: true })
    }
  }
}

async function installScriptCatUrl(
  config: HarnessConfig,
  installUrl: string,
  extensionId: string,
  agentOptions: AgentOptions,
): Promise<void> {
  runAgent(config, ['goto', `chrome-extension://${extensionId}/src/options.html`], agentOptions)
  const payload = JSON.stringify({ url: installUrl, uuid: stableUuid(installUrl) })
  const installOutput = runAgent(config, ['run-code', `async page => await page.evaluate(async ({ url, uuid }) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error('userscript fetch failed: HTTP ' + response.status)
    const result = await chrome.runtime.sendMessage({
      action: 'serviceWorker/script/installByCode',
      data: { uuid, code: await response.text(), upsertBy: 'user' },
    })
    if (!result || result.code) throw new Error(result?.message || 'ScriptCat install failed')
    return { uuid: result.data?.uuid }
  }, ${payload})`, '--raw'], { ...agentOptions, capture: true })
  const result: unknown = JSON.parse(installOutput.trim())
  if (!isRecord(result) || result.uuid !== stableUuid(installUrl)) throw new Error('ScriptCat install did not persist')
}

export async function enableUserScripts(config: HarnessConfig, agentOptions: AgentOptions = {}): Promise<boolean> {
  const name = config.userscript && config.userscript.managerName
  if (!name) throw new Error('userscript.manager or userscript.managerName is required')

  return (await enableUserScriptsNamed(config, name, agentOptions)).changed
}

async function enableUserScriptsNamed(
  config: HarnessConfig,
  name: string,
  agentOptions: AgentOptions = {},
): Promise<{ changed: boolean; id: string }> {

  runAgent(config, ['goto', 'chrome://extensions/'], agentOptions)
  const output = runAgent(config, ['run-code', `async page => await page.evaluate(async () => {
    const wanted = ${JSON.stringify(name)}.toLowerCase()
    const extension = (await chrome.developerPrivate.getExtensionsInfo())
      .find((item) => item.name.toLowerCase().includes(wanted))
    if (!extension) throw new Error('userscript manager extension not found')
    const changed = !extension.userScriptsAccess?.isActive
    if (changed) {
      await chrome.developerPrivate.updateExtensionConfiguration({
        extensionId: extension.id,
        userScriptsAccess: true,
      })
    }
    const updated = (await chrome.developerPrivate.getExtensionsInfo())
      .find((item) => item.id === extension.id)
    if (!updated?.userScriptsAccess?.isActive) throw new Error('user scripts permission did not activate')
    return { changed, active: true, id: extension.id }
  })`, '--raw'], { ...agentOptions, capture: true })
  const result: unknown = JSON.parse(output.trim())
  if (!isRecord(result) || typeof result.id !== 'string') throw new Error('Invalid userscript manager extension state')
  return { changed: result.changed === true, id: result.id }
}

export function runAgent(config: HarnessConfig, args: string[], {
  capture = false,
  allowFailure = false,
  endpoint,
  profile = 'default',
  session,
  dataDir,
  sensitive = false,
}: AgentOptions = {}): string {
  const scope = profileScope(config, profile, session)
  const fullArgs = [
    ...(scope.session ? [`-s=${scope.session}`] : []),
    ...args,
  ]
  const captureOutput = capture || sensitive
  const result = spawnSync(driverCommand(), fullArgs, {
    cwd: config.root,
    env: endpoint
      ? buildAttachedAgentEnv(config, scope, endpoint, dataDir)
      : buildAgentEnv(config, process.env, scope.name),
    encoding: captureOutput ? 'utf8' : undefined,
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (!allowFailure && result.status !== 0) {
    const detail = capture && !sensitive ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(`playwright-cli failed (${result.status})${detail ? `: ${detail}` : ''}`)
  }
  return capture ? String(result.stdout ?? '') : ''
}

function ensurePlaywrightSession(
  config: HarnessConfig,
  endpoint: string,
  profile: string,
  session: string,
  dataDir?: string,
): void {
  const scope = profileScope(config, profile, session)
  const probe = spawnSync(driverCommand(), [`-s=${scope.session}`, 'tab-list', '--json'], {
    cwd: config.root,
    env: buildAttachedAgentEnv(config, scope, endpoint, dataDir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (probe.status === 0) return

  const result = spawnSync(driverCommand(), [
    'attach',
    '--cdp',
    endpoint,
    '--session',
    scope.session,
    '--idle-timeout',
    String(scope.profile.idleTimeout),
  ], {
    cwd: config.root,
    env: buildAttachedAgentEnv(config, scope, endpoint, dataDir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(`playwright-cli attach failed (${result.status})${detail ? `: ${detail}` : ''}`)
  }
}

async function listTabs(config: HarnessConfig, agentOptions: AgentOptions): Promise<BrowserTab[]> {
  const code = 'async page => JSON.stringify(page.context().pages().map((item, index) => ({ tabId: String(index), url: item.url() })))'
  return readTabs(runAgent(config, ['run-code', code, '--raw'], { ...agentOptions, capture: true }))
}

export async function runAgentCommand(
  config: HarnessConfig,
  args: string[],
  options: SurfaceOptions = {},
): Promise<string> {
  let managed = await ensureManagedBrowser(config, options)
  managed = await ensureUserScriptsAccess(config, options, managed)
  const { browser, preparedPlugins, scope } = managed
  const token = beginIdleWindow(browser.runtime)
  const agentOptions = {
    endpoint: browser.endpoint,
    profile: scope.name,
    session: scope.session,
    dataDir: browser.profile,
  }

  try {
    ensurePlaywrightSession(config, browser.endpoint, scope.name, scope.session, browser.profile)
    if (browser.started) {
      await bootstrapPlugins(config, preparedPlugins, agentOptions)
      await bootstrapAttachedAgent(config, agentOptions)
    }
    return runAgent(config, normalizeAttachedCommand(args), agentOptions)
  } finally {
    if (!options.keepAlive) scheduleIdleStop(browser.runtime, token, scope.profile.idleTimeout)
  }
}

async function runAgentAction<T>(
  config: HarnessConfig,
  action: (options: AgentOptions) => Promise<T>,
  options: SurfaceOptions = {},
): Promise<T> {
  const { browser, scope } = await ensureManagedBrowser(config, options)
  const token = beginIdleWindow(browser.runtime)
  const agentOptions = {
    endpoint: browser.endpoint,
    profile: scope.name,
    session: scope.session,
    dataDir: browser.profile,
  }
  try {
    ensurePlaywrightSession(config, browser.endpoint, scope.name, scope.session, browser.profile)
    return await action(agentOptions)
  } finally {
    scheduleIdleStop(browser.runtime, token, scope.profile.idleTimeout)
  }
}

export async function stopManagedHarness(
  config: HarnessConfig,
  profile?: string,
): Promise<void> {
  const profiles = profile ? [normalizeProfileName(profile)] : Object.keys(config.profiles)
  for (const name of profiles) {
    if (!config.profiles[name]) continue
    runAgent(config, ['detach'], { allowFailure: true, profile: name })
    await stopCdpBrowserAndWait(createRuntime(config.root, runtimeName(name), config.runtimeDir))
  }

  const runtime = createRuntime(config.root, 'e2e', config.runtimeDir)
  config.dev.forEach((_, index) => stopOwnedProcess(runtime.path(`dev-${index}.pid`)))
  stopOwnedProcess(runtime.path('xvfb.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
}

async function ensureManagedBrowser(
  config: HarnessConfig,
  options: SurfaceOptions = {},
): Promise<{ browser: CdpBrowser; preparedPlugins: PreparedPlugins; scope: ProfileScope }> {
  const scope = profileScope(
    config,
    options.profile ?? process.env.E2E_HARNESS_PROFILE_NAME ?? 'default',
    options.session,
    options,
  )
  const preparedPlugins = await preparePlugins(config, options.plugins ?? [])
  const configuredExtensions = preparedPlugins.userscriptUrls.length
    ? scope.profile.extensions.filter((extension) => !isScriptCatExtension(extension))
    : scope.profile.extensions
  const extensions = unique([...configuredExtensions, ...preparedPlugins.extensions])
  const headed = scope.profile.headed
  const browserArgs = scope.profile.args
  const command = chromiumCommand(config, scope.profile)
  const runtime = createRuntime(config.root, runtimeName(scope.name), config.runtimeDir)
  const browserKey = JSON.stringify({
    args: browserArgs,
    command,
    extensions,
    headed,
    plugins: preparedPlugins.key,
    port: scope.profile.port,
    profile: scope.profile.dataDir,
  })
  const keyFile = runtime.path('browser-key')
  if (existsSync(runtime.path('browser.pid')) && readTextFile(keyFile) !== browserKey) {
    await stopCdpBrowserAndWait(runtime)
  }
  await ensureSharedRuntime(config, headed)
  const browser = await ensureCdpBrowser({
    root: config.root,
    runtimeDir: config.runtimeDir,
    name: runtimeName(scope.name),
    profile: scope.profile.dataDir,
    command,
    args: browserArgs,
    extensions,
    headed,
    port: scope.profile.port,
    timeout: DEFAULT_CDP_TIMEOUT,
  })
  writeFileSync(browser.runtime.path('browser-key'), browserKey)
  return { browser, preparedPlugins, scope }
}

async function ensureSharedRuntime(config: HarnessConfig, needsDisplay: boolean): Promise<void> {
  const runtime = createRuntime(config.root, 'e2e', config.runtimeDir)
  if (needsDisplay && config.display) {
    await ensureXvfb({
      display: config.display.value,
      pidFile: runtime.path('xvfb.pid'),
      logFile: runtime.path('xvfb.log'),
      cwd: config.root,
      timeout: config.display.timeout,
      commandPrefix: config.shell ? config.shell.command : [],
    })
  }
  await startDevProcesses(config, runtime)
}

async function bootstrapAttachedAgent(config: HarnessConfig, agentOptions: AgentOptions): Promise<void> {
  runAgent(config, ['goto', 'about:blank'], agentOptions)
  if (config.cookies) await importCookies(config, agentOptions)
  if (config.userscript && config.userscript.installOnStart && config.userscript.installUrl) {
    await installUserscript(config, agentOptions)
  }
  if (config.targetUrl) runAgent(config, ['goto', config.targetUrl], agentOptions)
}

async function bootstrapPlugins(
  config: HarnessConfig,
  plugins: PreparedPlugins,
  agentOptions: AgentOptions,
): Promise<void> {
  if (!plugins.userscriptUrls.length) return
  if (!plugins.scriptCatId) throw new Error('ScriptCat extension id is unavailable')
  runAgent(config, ['goto', 'about:blank'], agentOptions)
  for (const url of plugins.userscriptUrls) {
    await installScriptCatUrl(config, url, plugins.scriptCatId, agentOptions)
  }
}

function normalizeAttachedCommand(args: string[]): string[] {
  if (args[0] !== 'open') return args
  if (args.length > 2) throw new Error('browser open accepts only an optional URL; browser lifecycle is managed by the harness')
  return ['goto', args[1] ?? 'about:blank']
}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function ensureUserScriptsAccess(
  config: HarnessConfig,
  options: SurfaceOptions,
  managed: { browser: CdpBrowser; preparedPlugins: PreparedPlugins; scope: ProfileScope },
): Promise<{ browser: CdpBrowser; preparedPlugins: PreparedPlugins; scope: ProfileScope }> {
  if (!managed.browser.started) return managed
  const managers = unique([
    ...(managed.preparedPlugins.userscriptUrls.length ? ['ScriptCat'] : []),
    ...(config.userscript && config.userscript.enableUserScripts && config.userscript.managerName
      ? [config.userscript.managerName]
      : []),
  ])
  if (!managers.length) return managed

  const setupSession = `setup-${managed.scope.name}`
  const agentOptions = {
    endpoint: managed.browser.endpoint,
    profile: managed.scope.name,
    session: setupSession,
    dataDir: managed.browser.profile,
  }
  ensurePlaywrightSession(
    config,
    managed.browser.endpoint,
    managed.scope.name,
    setupSession,
    managed.browser.profile,
  )
  let changed = false
  let scriptCatId: string | undefined
  try {
    for (const manager of managers) {
      const state = await enableUserScriptsNamed(config, manager, agentOptions)
      changed = state.changed || changed
      if (manager.toLowerCase().includes('scriptcat')) scriptCatId = state.id
    }
  } finally {
    runAgent(config, ['detach'], { ...agentOptions, allowFailure: true })
  }
  managed.preparedPlugins.scriptCatId = scriptCatId
  if (!changed) return managed

  await stopCdpBrowserAndWait(managed.browser.runtime)
  const restarted = await ensureManagedBrowser(config, options)
  restarted.preparedPlugins.scriptCatId = scriptCatId
  return restarted
}

function buildAttachedAgentEnv(
  config: HarnessConfig,
  scope: ProfileScope,
  endpoint: string,
  dataDir = scope.profile.dataDir,
  base = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of [
    'AGENT_BROWSER_PROFILE',
    'AGENT_BROWSER_EXECUTABLE_PATH',
    'AGENT_BROWSER_EXTENSIONS',
    'AGENT_BROWSER_ARGS',
  ]) delete env[key]
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(scope.profile.idleTimeout)
  env.E2E_HARNESS_CDP_ENDPOINT = endpoint
  env.E2E_HARNESS_PROFILE_NAME = scope.name
  env.E2E_HARNESS_SESSION = scope.session
  env.E2E_HARNESS_PROFILE = dataDir
  env.PLAYWRIGHT_MCP_OUTPUT_DIR ??= path.join(config.playwrightDir, scope.name, scope.session)
  return env
}

function chromiumCommand(
  config: HarnessConfig,
  profile: ProfileConfig,
): string[] {
  if (profile.executable) return [profile.executable]
  if (config.shell?.command.length) return [...config.shell.command, config.shell.executable]
  return [config.shell?.executable ?? 'chromium']
}

function profileScope(
  config: HarnessConfig,
  profile: string,
  session?: string,
  overrides: SurfaceOptions = {},
): ProfileScope {
  const name = normalizeProfileName(profile)
  const configured = config.profiles[name]
  if (!configured) throw new Error(`Unknown E2E profile: ${name}`)
  return {
    name,
    profile: {
      ...configured,
      args: overrides.browserArgs ?? configured.args,
      port: overrides.port === undefined ? configured.port : normalizePort(overrides.port),
    },
    session: normalizeSession(session ?? process.env.AGENT_BROWSER_SESSION ?? path.basename(config.root)),
  }
}

function runtimeName(profile: string): string {
  return `browser-${normalizeProfileName(profile)}`
}

async function startDevProcesses(config: HarnessConfig, runtime: Runtime): Promise<void> {
  const readyUrls = []
  for (const [index, entry] of config.dev.entries()) {
    const urls = entry.ready ?? []
    readyUrls.push(...urls)
    const alreadyReady = urls.length && (await Promise.all(urls.map(isReachable))).every(Boolean)
    if (alreadyReady) continue

    const command = entry.command
    if (!Array.isArray(command) || !command.length) throw new Error(`dev[${index}].command must be a non-empty array`)
    spawnOwned(command[0], command.slice(1), {
      cwd: config.root,
      pidFile: runtime.path(`dev-${index}.pid`),
      logFile: runtime.path(`dev-${index}.log`),
      env: { ...process.env, ...stringEnv(entry.env ?? {}) },
    })
  }
  if (readyUrls.length) await waitForUrls(readyUrls)
}

async function waitForConfirmationTab(
  config: HarnessConfig,
  previousIds: Set<string>,
  agentOptions: AgentOptions = {},
): Promise<BrowserTab> {
  const deadline = Date.now() + (config.userscript ? config.userscript.confirmationTimeout : 30_000)
  while (Date.now() < deadline) {
    const tabs = await listTabs(config, agentOptions)
    const confirmation = tabs.find((tab) =>
      /^chrome-extension:\/\//i.test(tab.url)
      && (/\/(?:confirm(?:\/|[?#]|$)|src\/install\.html(?:[?#]|$))/i.test(tab.url) || !previousIds.has(tab.tabId))
    )
    if (confirmation) return confirmation
    await sleep(250)
  }
  throw new Error('Userscript manager confirmation tab did not appear')
}

export function readTabs(output: string): BrowserTab[] {
  const value: unknown = JSON.parse(output.trim())
  const tabs: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(tabs)) throw new Error('playwright-cli returned no browser tabs')
  return tabs.flatMap((tab) => isRecord(tab) && typeof tab.tabId === 'string' && typeof tab.url === 'string'
    ? [{ tabId: tab.tabId, url: tab.url }]
    : [])
}

function resolveProjectPath(root: string, value: string): string
function resolveProjectPath(root: string, value: undefined): undefined
function resolveProjectPath(root: string, value: string | undefined): string | undefined
function resolveProjectPath(root: string, value: string | undefined): string | undefined {
  if (!value || path.isAbsolute(value)) return value
  return path.resolve(root, value)
}

function stringEnv(values: Record<string, string | number | boolean | null | undefined>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  )
}

function commaList(value: string | undefined): string[] {
  if (!value) return []
  return String(value).split(',').map((item) => item.trim()).filter(Boolean)
}

function normalizeCommand(value: string | string[] | undefined): string[] {
  const command = Array.isArray(value) ? value : value ? [value] : []
  if (command.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('command entries must be non-empty strings')
  }
  return command
}

function normalizePort(value: string | number): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid CDP port: ${value}`)
  }
  return port
}

function normalizeTimeout(value: number): number {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error(`invalid idle timeout: ${value}`)
  }
  return timeout
}

function normalizeProfileName(value: string | undefined): string {
  const profile = String(value || 'default')
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error('profile must contain only letters, numbers, dot, underscore, or hyphen')
  }
  return profile
}

function normalizeSession(value: string | undefined): string {
  const session = String(value || 'default')
  if (!/^[A-Za-z0-9._-]+$/.test(session)) {
    throw new Error('session must contain only letters, numbers, dot, underscore, or hyphen')
  }
  return session
}

function managerName(manager: string | undefined): string | undefined {
  if (!manager) return undefined
  if (manager.toLowerCase() === 'scriptcat') return 'ScriptCat'
  if (manager.toLowerCase() === 'violentmonkey') return 'Violentmonkey'
  return manager
}

function isScriptCatExtension(extension: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'))
    return isRecord(manifest)
      && typeof manifest.name === 'string'
      && manifest.name.toLowerCase().includes('scriptcat')
  } catch {
    return false
  }
}

async function preparePlugins(config: HarnessConfig, cliPlugins: PluginConfig[]): Promise<PreparedPlugins> {
  const plugins = [...config.plugins, ...cliPlugins]
  const userscripts = plugins.filter((plugin): plugin is Extract<PluginConfig, { name: 'userscript' }> =>
    plugin.name === 'userscript'
  )
  const userscriptUrls = unique(userscripts.map((plugin) => plugin.url))
  const version = [...userscripts].reverse().find((plugin) => plugin.version)?.version
  const extensions: string[] = []

  if (userscriptUrls.length) extensions.push(await ensureScriptCat(config.cacheDir, version))
  if (plugins.some((plugin) => plugin.name === 'disable-csp')) {
    extensions.push(ensureDisableCsp(config.cacheDir))
  }

  return {
    extensions: unique(extensions),
    key: JSON.stringify({
      userscriptUrls: [...userscriptUrls].sort(),
      version: version ?? 'latest',
      disableCsp: plugins.some((plugin) => plugin.name === 'disable-csp'),
    }),
    userscriptUrls,
  }
}

function ensureDisableCsp(cacheDir: string): string {
  const source = path.join(SKILL_ROOT, 'assets', 'disable-csp')
  const files = ['manifest.json', 'rules.json']
  const hash = createHash('sha256')
  for (const file of files) hash.update(readFileSync(path.join(source, file)))
  const target = path.join(cacheDir, 'extensions', 'disable-csp', hash.digest('hex').slice(0, 16))
  if (existsSync(path.join(target, 'manifest.json'))) return target

  mkdirSync(target, { recursive: true })
  for (const file of files) writeFileSync(path.join(target, file), readFileSync(path.join(source, file)))
  return target
}

async function ensureScriptCat(cacheDir: string, version?: string): Promise<string> {
  const requestedTag = version ? normalizeScriptCatVersion(version) : undefined
  if (requestedTag) {
    const cached = cachedScriptCat(cacheDir, requestedTag)
    if (cached) return cached
  }

  let release: ScriptCatRelease
  try {
    release = await fetchScriptCatRelease(version)
  } catch (error) {
    if (!version) {
      const cached = latestCachedScriptCat(cacheDir)
      if (cached) return cached
    }
    throw error
  }
  const cacheRoot = path.join(cacheDir, 'scriptcat', release.tag_name)
  const cached = cachedScriptCat(cacheDir, release.tag_name)
  if (cached) return cached

  const asset = release.assets.find((item) => /chrome\.zip$/i.test(item.name))
    ?? release.assets.find((item) => /\.zip$/i.test(item.name))
  if (!asset) throw new Error(`ScriptCat ${release.tag_name} has no Chrome ZIP release asset`)

  const response = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'arca-e2e' } })
  if (!response.ok) throw new Error(`Failed to download ScriptCat ${release.tag_name}: HTTP ${response.status}`)
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
  const manifest = Object.keys(files)
    .filter((name) => /(^|\/)manifest\.json$/i.test(name))
    .sort((a, b) => a.length - b.length)[0]
  if (!manifest) throw new Error(`ScriptCat ${release.tag_name} archive has no manifest.json`)

  const tempRoot = `${cacheRoot}.tmp-${process.pid}`
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(tempRoot, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) {
    const destination = path.resolve(tempRoot, name)
    if (!destination.startsWith(`${path.resolve(tempRoot)}${path.sep}`)) {
      throw new Error(`Invalid ScriptCat archive path: ${name}`)
    }
    if (name.endsWith('/')) {
      mkdirSync(destination, { recursive: true })
      continue
    }
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, bytes)
  }
  const extensionRoot = path.dirname(manifest) === '.' ? '' : path.dirname(manifest)
  writeFileSync(path.join(tempRoot, '.extension-root'), extensionRoot || '.')
  rmSync(cacheRoot, { recursive: true, force: true })
  mkdirSync(path.dirname(cacheRoot), { recursive: true })
  renameSync(tempRoot, cacheRoot)
  return path.join(cacheRoot, extensionRoot)
}

function cachedScriptCat(cacheDir: string, tag: string): string | undefined {
  const cacheRoot = path.join(cacheDir, 'scriptcat', tag)
  const cachedRoot = readTextFile(path.join(cacheRoot, '.extension-root'))
  if (!cachedRoot) return undefined
  const extensionRoot = path.join(cacheRoot, cachedRoot === '.' ? '' : cachedRoot)
  return existsSync(path.join(extensionRoot, 'manifest.json')) ? extensionRoot : undefined
}

function latestCachedScriptCat(cacheDir: string): string | undefined {
  const cacheRoot = path.join(cacheDir, 'scriptcat')
  if (!existsSync(cacheRoot)) return undefined
  const tags = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
  for (const tag of tags) {
    const cached = cachedScriptCat(cacheDir, tag)
    if (cached) return cached
  }
  return undefined
}

async function fetchScriptCatRelease(version?: string): Promise<ScriptCatRelease> {
  const tag = version ? normalizeScriptCatVersion(version) : undefined
  const endpoint = tag
    ? `https://api.github.com/repos/scriptscat/scriptcat/releases/tags/${encodeURIComponent(tag)}`
    : 'https://api.github.com/repos/scriptscat/scriptcat/releases/latest'
  const response = await fetch(endpoint, { headers: { 'User-Agent': 'arca-e2e' } })
  if (!response.ok) {
    throw new Error(`Failed to resolve ScriptCat ${tag ?? 'latest'}: HTTP ${response.status}`)
  }
  const value: unknown = await response.json()
  if (!isRecord(value) || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)) {
    throw new Error('Invalid ScriptCat release response')
  }
  return {
    tag_name: value.tag_name,
    assets: value.assets.flatMap((asset) =>
      isRecord(asset) && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string'
        ? [{ name: asset.name, browser_download_url: asset.browser_download_url }]
        : []
    ),
  }
}

interface ScriptCatRelease {
  tag_name: string
  assets: Array<{ name: string; browser_download_url: string }>
}

function normalizeScriptCatVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function driverCommand(): string {
  return process.env.E2E_HARNESS_DRIVER ?? PLAYWRIGHT_CLI
}

function readTextFile(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCli(argv: string[]) {
  const args = [...argv]
  let configFile
  const separator = args.indexOf('--')
  const configIndex = args.findIndex((value, index) =>
    value === '--config'
    && (separator < 0 || index < separator)
  )
  if (configIndex >= 0) {
    if (!args[configIndex + 1]) throw new Error('--config requires a path')
    configFile = args[configIndex + 1]
    args.splice(configIndex, 2)
  }
  configFile ??= process.env.E2E_CONFIG ?? process.env.E2E_HARNESS_CONFIG
  return { command: args[0], args: args.slice(1), configFile }
}

function parseSurfaceArgs(args: string[]) {
  const separator = args.indexOf('--')
  if (separator < 0) {
    return {
      args,
      profile: process.env.E2E_HARNESS_PROFILE_NAME ?? 'default',
      session: process.env.AGENT_BROWSER_SESSION,
      port: undefined,
      browserArgs: undefined,
      plugins: [],
    }
  }

  const control = args.slice(0, separator)
  const passthrough = args.slice(separator + 1)
  let profile = process.env.E2E_HARNESS_PROFILE_NAME ?? 'default'
  let session = process.env.AGENT_BROWSER_SESSION
  let port
  const browserArgs: string[] = []
  const plugins: PluginConfig[] = []
  for (let index = 0; index < control.length; index += 1) {
    const option = control[index]
    if (option === '--profile') {
      if (!control[index + 1]) throw new Error('--profile requires a value')
      profile = control[++index]
      continue
    }
    if (option === '--session') {
      if (!control[index + 1]) throw new Error('--session requires a value')
      session = control[++index]
      continue
    }
    if (option === '--port') {
      if (!control[index + 1]) throw new Error('--port requires a value')
      port = normalizePort(control[++index])
      continue
    }
    if (option === '--browser-arg') {
      if (!control[index + 1]) throw new Error('--browser-arg requires a value')
      browserArgs.push(control[++index])
      continue
    }
    if (option === '--plugin') {
      if (!control[index + 1]) throw new Error('--plugin requires a value')
      plugins.push(parsePluginOption(control[++index]))
      continue
    }
    throw new Error(`Unknown harness option: ${option}`)
  }
  return {
    args: passthrough,
    profile: normalizeProfileName(profile),
    session: session ? normalizeSession(session) : undefined,
    port,
    browserArgs: browserArgs.length ? browserArgs : undefined,
    plugins,
  }
}

export function parsePluginOption(value: string): PluginConfig {
  if (value === 'disable-csp') return { name: 'disable-csp' }
  const match = /^userscript(?:@([^=]+))?=(.+)$/.exec(value)
  if (!match) throw new Error(`Unknown plugin: ${value}`)
  const [, version, url] = match
  return pluginSchema.parse({ name: 'userscript', url, ...(version ? { version } : {}) })
}

async function main(argv = process.argv.slice(2)): Promise<void | string | number | boolean> {
  const { command, args, configFile } = parseCli(argv)
  if (!command || command === 'help' || command === '--help') {
    console.log('usage: node <e2e>/scripts/harness.ts <browser|start|stop|cookies|install-userscript|enable-user-scripts> [--config path] [--profile name --session id --port n --browser-arg arg --plugin disable-csp --plugin userscript[@version]=url --] [args]')
    return
  }

  const projectRoot = inferProjectRoot()
  const configPath = configFile
    ? path.resolve(process.cwd(), configFile)
    : path.join(projectRoot, DEFAULT_CONFIG)
  const config = await loadHarnessConfig(configFile ? process.cwd() : projectRoot, configPath)
  if (command === 'start') {
    const surface = parseSurfaceArgs(args.includes('--') ? args : [...args, '--'])
    if (surface.args.length) throw new Error('start does not accept passthrough arguments')
    return startHarness(config, surface)
  }
  if (command === 'stop') {
    const surface = parseSurfaceArgs(args.includes('--') ? args : [...args, '--'])
    if (surface.args.length) throw new Error('stop does not accept passthrough arguments')
    return stopManagedHarness(config, surface.profile)
  }
  if (command === 'browser') {
    const surface = parseSurfaceArgs(args)
    return runAgentCommand(config, surface.args, surface)
  }
  if (command === 'cookies' || command === 'install-userscript' || command === 'enable-user-scripts') {
    const surface = parseSurfaceArgs(args)
    if (surface.args.length) throw new Error(`${command} does not accept passthrough arguments`)
    if (command === 'cookies') return runAgentAction(config, (options) => importCookies(config, options), surface)
    if (command === 'install-userscript') {
      return runAgentAction(config, (options) => installUserscript(config, options), surface)
    }
    return runAgentAction(config, (options) => enableUserScripts(config, options), surface)
  }
  throw new Error(`Unknown E2E harness command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
