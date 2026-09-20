#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
  stopCdpBrowser,
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

const DEFAULT_CONFIG = 'e2e.toml'
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IDLE_TIMEOUT = 5 * 60_000
const DEFAULT_CDP_TIMEOUT = 10_000
const envValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const envSchema = z.record(z.string(), envValueSchema)
const commandSchema = z.union([z.string(), z.array(z.string())])
const devSchema = z.object({
  command: z.array(z.string()),
  readyUrls: z.array(z.string()).optional(),
  env: envSchema.optional(),
})
const surfaceSchema = z.object({
  profile: z.string().optional(),
  executablePath: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  env: envSchema.optional(),
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
  shell: z.union([
    z.literal(false),
    z.object({ command: commandSchema.optional(), chromium: z.string().optional() }),
  ]).optional(),
  display: z.union([
    z.literal(false),
    z.object({ value: z.string().optional(), timeout: z.number().nonnegative().optional() }),
  ]).optional(),
  dev: z.union([devSchema, z.array(devSchema)]).optional(),
  agent: surfaceSchema.extend({
    command: z.string().optional(),
    session: z.string().optional(),
    screenshotDir: z.string().optional(),
  }).optional(),
  playwright: surfaceSchema.extend({
    command: commandSchema.optional(),
    endpointEnv: z.string().optional(),
  }).optional(),
  cookies: z.union([
    z.literal(false),
    z.object({ file: z.string().optional(), required: z.boolean().optional() }),
  ]).optional(),
  userscript: z.union([
    z.literal(false),
    z.object({
      installUrl: z.string().optional(),
      installOnStart: z.boolean().optional(),
      enableUserScripts: z.boolean().optional(),
      manager: z.string().optional(),
      managerName: z.string().optional(),
      confirmationTimeout: z.number().nonnegative().optional(),
    }),
  ]).optional(),
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
  const agent = parsed.agent ?? {}
  const playwright = parsed.playwright ?? {}
  const userscript = parsed.userscript ?? false
  const agentExtensions = agent.extensions ?? commaList(env.AGENT_BROWSER_EXTENSIONS)
  return {
    root,
    shell: parsed.shell ? {
      command: normalizeCommand(parsed.shell.command),
      chromium: parsed.shell.chromium ?? 'chromium',
    } : false,
    display: parsed.display === false ? false : {
      value: parsed.display?.value ?? env.DISPLAY ?? ':99',
      timeout: parsed.display?.timeout ?? 5000,
    },
    dev: Array.isArray(parsed.dev) ? parsed.dev : parsed.dev ? [parsed.dev] : [],
    agent: {
      command: agent.command ?? 'agent-browser',
      session: agent.session ?? env.AGENT_BROWSER_SESSION ?? path.basename(root),
      profile: resolveProjectPath(root, agent.profile ?? env.AGENT_BROWSER_PROFILE ?? '.browser-state/agent'),
      executablePath: agent.executablePath ?? env.AGENT_BROWSER_EXECUTABLE_PATH,
      extensions: agentExtensions.filter(Boolean).map((value) => resolveProjectPath(root, value)),
      args: agent.args ?? [],
      env: agent.env ?? {},
      screenshotDir: resolveProjectPath(root, agent.screenshotDir ?? env.AGENT_BROWSER_SCREENSHOT_DIR),
      headed: agent.headed ?? true,
      port: normalizePort(agent.port ?? 0),
      idleTimeout: normalizeTimeout(agent.idleTimeout ?? DEFAULT_IDLE_TIMEOUT),
    },
    playwright: {
      command: normalizeCommand(playwright.command ?? ['npx', 'playwright']),
      profile: resolveProjectPath(root, playwright.profile ?? '.browser-state/playwright'),
      executablePath: playwright.executablePath ?? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      extensions: (playwright.extensions ?? []).filter(Boolean).map((value) => resolveProjectPath(root, value)),
      args: playwright.args ?? [],
      env: playwright.env ?? {},
      headed: playwright.headed ?? Boolean(playwright.extensions?.length),
      port: normalizePort(playwright.port ?? 0),
      idleTimeout: normalizeTimeout(playwright.idleTimeout ?? DEFAULT_IDLE_TIMEOUT),
      endpointEnv: playwright.endpointEnv ?? 'PLAYWRIGHT_CDP_ENDPOINT',
    },
    cookies: parsed.cookies === false ? false : {
      file: parsed.cookies?.file,
      required: parsed.cookies?.required ?? false,
    },
    userscript: userscript === false ? false : {
      installUrl: userscript.installUrl,
      installOnStart: userscript.installOnStart ?? Boolean(userscript.installUrl),
      enableUserScripts: userscript.enableUserScripts ?? Boolean(userscript.manager),
      manager: userscript.manager,
      managerName: userscript.managerName ?? managerName(userscript.manager),
      confirmationTimeout: userscript.confirmationTimeout ?? 30_000,
    },
    plugins: parsed.plugins ?? [],
    targetUrl: parsed.targetUrl,
  }
}

type EnvValues = Record<string, string | number | boolean | null>
type SurfaceMode = 'agent' | 'playwright'

interface DevConfig {
  command: string[]
  readyUrls?: string[]
  env?: EnvValues
}

interface SurfaceConfig {
  profile: string
  executablePath?: string
  extensions: string[]
  args: string[]
  env: EnvValues
  headed: boolean
  port: number
  idleTimeout: number
}

interface HarnessConfig {
  root: string
  shell: false | { command: string[]; chromium: string }
  display: false | { value: string; timeout: number }
  dev: DevConfig[]
  agent: SurfaceConfig & {
    command: string
    session: string
    screenshotDir?: string
  }
  playwright: SurfaceConfig & {
    command: string[]
    endpointEnv: string
  }
  cookies: false | { file?: string; required: boolean }
  userscript: false | {
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
  userscriptUrls: string[]
}

interface SurfaceScope {
  instance: string
  profile: string
}

interface BrowserTab {
  tabId: string
  url: string
}

interface AgentOptions {
  capture?: boolean
  allowFailure?: boolean
  endpoint?: string
  instance?: string
}

interface SurfaceOptions {
  instance?: string
  port?: number
  plugins?: PluginConfig[]
}

export function buildAgentEnv(config: HarnessConfig, base = process.env): NodeJS.ProcessEnv {
  const env = { ...base, ...stringEnv(config.agent.env) }
  env.AGENT_BROWSER_PROFILE = config.agent.profile
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(config.agent.idleTimeout)
  if (config.agent.executablePath) env.AGENT_BROWSER_EXECUTABLE_PATH = config.agent.executablePath
  if (config.agent.extensions.length) env.AGENT_BROWSER_EXTENSIONS = config.agent.extensions.join(',')
  if (config.agent.args.length) env.AGENT_BROWSER_ARGS = config.agent.args.join(' ')
  if (config.agent.screenshotDir) env.AGENT_BROWSER_SCREENSHOT_DIR = config.agent.screenshotDir
  return env
}

export async function startHarness(config: HarnessConfig): Promise<void> {
  const runtime = createRuntime(config.root, 'agent')
  if (config.display) {
    await ensureXvfb({
      display: config.display.value,
      pidFile: runtime.path('xvfb.pid'),
      logFile: runtime.path('xvfb.log'),
      cwd: config.root,
      timeout: config.display.timeout,
    })
  }

  await startDevProcesses(config, runtime)
  runAgent(config, [...(config.agent.headed ? ['--headed'] : []), 'open', 'about:blank'])

  if (config.userscript && config.userscript.enableUserScripts && config.userscript.managerName) {
    await enableUserScripts(config)
  }
  if (config.cookies) await importCookies(config)
  if (config.userscript && config.userscript.installOnStart && config.userscript.installUrl) {
    await installUserscript(config)
  }
  if (config.targetUrl) runAgent(config, ['open', config.targetUrl])
}

export function stopHarness(config: HarnessConfig): void {
  const runtime = createRuntime(config.root, 'agent')
  runAgent(config, ['close'], { allowFailure: true })
  config.dev.forEach((_, index) => stopOwnedProcess(runtime.path(`dev-${index}.pid`)))
  stopOwnedProcess(runtime.path('xvfb.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
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
      'cookies',
      'set',
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
    runAgent(config, args, agentOptions)
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

  const before = new Set(readTabs(runAgent(config, ['tab', 'list', '--json'], { ...agentOptions, capture: true })).map((tab) => tab.tabId))
  runAgent(config, ['open', installUrl], agentOptions)

  const confirmation = await waitForConfirmationTab(config, before, agentOptions)
  runAgent(config, ['tab', confirmation.tabId], agentOptions)
  runAgent(config, ['wait', '--fn', INSTALL_READY], agentOptions)
  runAgent(config, ['eval', INSTALL_CLICK], agentOptions)
  runAgent(config, ['wait', '--fn', INSTALL_DONE], agentOptions)
}

export async function enableUserScripts(config: HarnessConfig, agentOptions: AgentOptions = {}): Promise<void> {
  const name = config.userscript && config.userscript.managerName
  if (!name) throw new Error('userscript.manager or userscript.managerName is required')

  return enableUserScriptsNamed(config, name, agentOptions)
}

async function enableUserScriptsNamed(
  config: HarnessConfig,
  name: string,
  agentOptions: AgentOptions = {},
): Promise<void> {

  runAgent(config, ['open', 'chrome://extensions/'], agentOptions)
  const expression = permissionExpression(name)
  runAgent(config, ['wait', '--fn', `() => (${expression})().found`], agentOptions)
  runAgent(config, ['eval', `() => { const result = (${expression})(); if (!result.enabled) result.toggle.click(); return result.enabled ? 'enabled' : 'enabled-now' }`], agentOptions)
  runAgent(config, ['wait', '--fn', `() => (${expression})().enabled`], agentOptions)
}

export function runAgent(config: HarnessConfig, args: string[], {
  capture = false,
  allowFailure = false,
  endpoint,
  instance = 'default',
}: AgentOptions = {}): string {
  const scope = agentScope(config, instance)
  const fullArgs = [
    ...(scope.session ? ['--session', scope.session] : []),
    ...(endpoint ? ['--namespace', scope.namespace, '--cdp', endpoint, '--pin-tab'] : []),
    ...args,
  ]
  const result = spawnSync(config.agent.command, fullArgs, {
    cwd: config.root,
    env: endpoint ? buildAttachedAgentEnv(config, scope, endpoint) : buildAgentEnv(config),
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (!allowFailure && result.status !== 0) {
    const detail = capture ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(`${config.agent.command} failed (${result.status})${detail ? `: ${detail}` : ''}`)
  }
  return capture ? String(result.stdout ?? '') : ''
}

export async function runAgentCommand(
  config: HarnessConfig,
  args: string[],
  { instance = 'default', port, plugins = [] }: SurfaceOptions = {},
): Promise<string> {
  const { browser, preparedPlugins } = await ensureManagedBrowser(config, 'agent', instance, port, plugins)
  const token = beginIdleWindow(browser.runtime)
  const agentOptions = { endpoint: browser.endpoint, instance }

  try {
    if (browser.started) {
      await bootstrapPlugins(config, preparedPlugins, agentOptions)
      await bootstrapAttachedAgent(config, agentOptions)
    }
    return runAgent(config, args, agentOptions)
  } finally {
    scheduleIdleStop(browser.runtime, token, config.agent.idleTimeout)
  }
}

export async function runPlaywrightCommand(
  config: HarnessConfig,
  args: string[],
  { instance = 'default', port, plugins = [] }: SurfaceOptions = {},
): Promise<void> {
  const { browser, preparedPlugins } = await ensureManagedBrowser(config, 'playwright', instance, port, plugins)
  const token = beginIdleWindow(browser.runtime)
  const command = config.playwright.command

  try {
    if (browser.started) {
      await bootstrapPlugins(config, preparedPlugins, {
        endpoint: browser.endpoint,
        instance: `playwright-${normalizeInstance(instance)}`,
      })
    }
    const result = spawnSync(command[0], [...command.slice(1), ...args], {
      cwd: config.root,
      env: buildPlaywrightEnv(config, browser, instance),
      stdio: 'inherit',
    })
    if (result.status !== 0) throw new Error(`${command[0]} failed (${result.status})`)
  } finally {
    scheduleIdleStop(browser.runtime, token, config.playwright.idleTimeout)
  }
}

export function stopManagedHarness(config: HarnessConfig, instance = 'default'): void {
  const modes: SurfaceMode[] = ['agent', 'playwright']
  for (const mode of modes) {
    stopCdpBrowser(createRuntime(config.root, runtimeName(mode, instance)))
  }

  const runtime = createRuntime(config.root, 'e2e')
  config.dev.forEach((_, index) => stopOwnedProcess(runtime.path(`dev-${index}.pid`)))
  stopOwnedProcess(runtime.path('xvfb.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
}

async function ensureManagedBrowser(
  config: HarnessConfig,
  mode: SurfaceMode,
  instance: string,
  port?: number,
  cliPlugins: PluginConfig[] = [],
): Promise<{ browser: CdpBrowser; preparedPlugins: PreparedPlugins }> {
  const surface = config[mode]
  const scope = surfaceScope(config, mode, instance)
  const preparedPlugins = await preparePlugins(config, cliPlugins)
  const extensions = unique([...surface.extensions, ...preparedPlugins.extensions])
  const headed = surface.headed || preparedPlugins.userscriptUrls.length > 0
  const runtime = createRuntime(config.root, runtimeName(mode, scope.instance))
  const browserKey = JSON.stringify({ extensions, plugins: preparedPlugins.key })
  const keyFile = runtime.path('browser-key')
  if (existsSync(runtime.path('browser.pid')) && readTextFile(keyFile) !== browserKey) {
    stopCdpBrowser(runtime)
  }
  await ensureSharedRuntime(config, headed)
  const browser = await ensureCdpBrowser({
    root: config.root,
    name: runtimeName(mode, scope.instance),
    profile: scope.profile,
    command: chromiumCommand(config, surface),
    args: surface.args,
    extensions,
    headed,
    port: port === undefined ? surface.port : normalizePort(port),
    timeout: DEFAULT_CDP_TIMEOUT,
  })
  writeFileSync(browser.runtime.path('browser-key'), browserKey)
  return { browser, preparedPlugins }
}

async function ensureSharedRuntime(config: HarnessConfig, needsDisplay: boolean): Promise<void> {
  const runtime = createRuntime(config.root, 'e2e')
  if (needsDisplay && config.display) {
    await ensureXvfb({
      display: config.display.value,
      pidFile: runtime.path('xvfb.pid'),
      logFile: runtime.path('xvfb.log'),
      cwd: config.root,
      timeout: config.display.timeout,
    })
  }
  await startDevProcesses(config, runtime)
}

async function bootstrapAttachedAgent(config: HarnessConfig, agentOptions: AgentOptions): Promise<void> {
  runAgent(config, ['open', 'about:blank'], agentOptions)
  if (config.userscript && config.userscript.enableUserScripts && config.userscript.managerName) {
    await enableUserScripts(config, agentOptions)
  }
  if (config.cookies) await importCookies(config, agentOptions)
  if (config.userscript && config.userscript.installOnStart && config.userscript.installUrl) {
    await installUserscript(config, agentOptions)
  }
  if (config.targetUrl) runAgent(config, ['open', config.targetUrl], agentOptions)
}

async function bootstrapPlugins(
  config: HarnessConfig,
  plugins: PreparedPlugins,
  agentOptions: AgentOptions,
): Promise<void> {
  if (!plugins.userscriptUrls.length) return
  runAgent(config, ['open', 'about:blank'], agentOptions)
  await enableUserScriptsNamed(config, 'ScriptCat', agentOptions)
  for (const url of plugins.userscriptUrls) {
    await installUserscriptUrl(config, url, agentOptions)
  }
}

function buildPlaywrightEnv(
  config: HarnessConfig,
  browser: CdpBrowser,
  instance: string,
  base = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base, ...stringEnv(config.playwright.env) }
  env[config.playwright.endpointEnv] = browser.endpoint
  env.E2E_HARNESS_CDP_ENDPOINT = browser.endpoint
  env.E2E_HARNESS_INSTANCE = normalizeInstance(instance)
  env.E2E_HARNESS_PROFILE = browser.profile
  if (config.playwright.executablePath) {
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = config.playwright.executablePath
  }
  return env
}

function buildAttachedAgentEnv(
  config: HarnessConfig,
  scope: SurfaceScope,
  endpoint: string,
  base = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base, ...stringEnv(config.agent.env) }
  for (const key of [
    'AGENT_BROWSER_PROFILE',
    'AGENT_BROWSER_EXECUTABLE_PATH',
    'AGENT_BROWSER_EXTENSIONS',
    'AGENT_BROWSER_ARGS',
  ]) delete env[key]
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(config.agent.idleTimeout)
  env.E2E_HARNESS_CDP_ENDPOINT = endpoint
  env.E2E_HARNESS_INSTANCE = scope.instance
  env.E2E_HARNESS_PROFILE = scope.profile
  if (config.agent.screenshotDir) env.AGENT_BROWSER_SCREENSHOT_DIR = config.agent.screenshotDir
  return env
}

function chromiumCommand(
  config: HarnessConfig,
  surface: HarnessConfig['agent'] | HarnessConfig['playwright'],
): string[] {
  if (surface.executablePath) return [surface.executablePath]
  if (config.shell && config.shell.command.length) return [...config.shell.command, config.shell.chromium]
  return [config.shell ? config.shell.chromium : 'chromium']
}

function agentScope(config: HarnessConfig, instance: string) {
  const scope = surfaceScope(config, 'agent', instance)
  const session = scope.instance === 'default'
    ? config.agent.session
    : `${config.agent.session}-${scope.instance}`
  return { ...scope, session, namespace: session || `e2e-${scope.instance}` }
}

function surfaceScope(config: HarnessConfig, mode: SurfaceMode, instance: string): SurfaceScope {
  const normalized = normalizeInstance(instance)
  const baseProfile = config[mode].profile
  return {
    instance: normalized,
    profile: normalized === 'default' ? baseProfile : path.join(baseProfile, normalized),
  }
}

function runtimeName(mode: SurfaceMode, instance: string): string {
  return `${mode}-${normalizeInstance(instance)}`
}

async function startDevProcesses(config: HarnessConfig, runtime: Runtime): Promise<void> {
  const readyUrls = []
  for (const [index, entry] of config.dev.entries()) {
    const urls = entry.readyUrls ?? []
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
  if (!config.userscript) throw new Error('userscript config is required')
  const deadline = Date.now() + config.userscript.confirmationTimeout
  while (Date.now() < deadline) {
    const tabs = readTabs(runAgent(config, ['tab', 'list', '--json'], { ...agentOptions, capture: true }))
    const confirmation = tabs.find((tab) =>
      /^chrome-extension:\/\//i.test(tab.url)
      && (/\/confirm(?:\/|[?#]|$)/i.test(tab.url) || !previousIds.has(tab.tabId))
    )
    if (confirmation) return confirmation
    await sleep(250)
  }
  throw new Error('Userscript manager confirmation tab did not appear')
}

export function readTabs(output: string): BrowserTab[] {
  const result = readAgentJson(output)
  const data = isRecord(result.data) ? result.data : undefined
  const tabs = data?.tabs
  if (!Array.isArray(tabs)) throw new Error('agent-browser returned no browser tabs')
  return tabs.flatMap((tab) =>
    isRecord(tab) && typeof tab.tabId === 'string' && typeof tab.url === 'string'
      ? [{ tabId: tab.tabId, url: tab.url }]
      : []
  )
}

function readAgentJson(output: string): Record<string, unknown> {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) return value
    } catch {
      // agent-browser may surround JSON with human-readable output.
    }
  }
  throw new Error('agent-browser returned invalid JSON')
}

function permissionExpression(name: string): string {
  return `() => {
    const deep = (root, selector) => {
      const matches = [...root.querySelectorAll(selector)]
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) matches.push(...deep(element.shadowRoot, selector))
      }
      return matches
    }
    const wanted = ${JSON.stringify(name)}.toLowerCase()
    const item = deep(document, 'extensions-item').find((candidate) => {
      const label = deep(candidate.shadowRoot ?? candidate, '#name')[0]?.textContent?.trim().toLowerCase() ?? ''
      return label.includes(wanted)
    })
    if (!item) return { found: false, enabled: false }
    const toggle = deep(item.shadowRoot ?? item, '#allow-user-scripts cr-toggle')[0]
    return { found: Boolean(toggle), enabled: Boolean(toggle?.checked), toggle }
  }`
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

function normalizeInstance(value: string | undefined): string {
  const instance = String(value || 'default')
  if (!/^[A-Za-z0-9._-]+$/.test(instance)) {
    throw new Error('instance must contain only letters, numbers, dot, underscore, or hyphen')
  }
  return instance
}

function managerName(manager: string | undefined): string | undefined {
  if (!manager) return undefined
  if (manager.toLowerCase() === 'scriptcat') return 'ScriptCat'
  if (manager.toLowerCase() === 'violentmonkey') return 'Violentmonkey'
  return manager
}

async function preparePlugins(config: HarnessConfig, cliPlugins: PluginConfig[]): Promise<PreparedPlugins> {
  const plugins = [...config.plugins, ...cliPlugins]
  const userscripts = plugins.filter((plugin): plugin is Extract<PluginConfig, { name: 'userscript' }> =>
    plugin.name === 'userscript'
  )
  const userscriptUrls = unique(userscripts.map((plugin) => plugin.url))
  const version = [...userscripts].reverse().find((plugin) => plugin.version)?.version
  const extensions: string[] = []

  if (userscriptUrls.length) extensions.push(await ensureScriptCat(config.root, version))
  if (plugins.some((plugin) => plugin.name === 'disable-csp')) {
    extensions.push(path.join(SKILL_ROOT, 'assets', 'disable-csp'))
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

async function ensureScriptCat(root: string, version?: string): Promise<string> {
  const release = await fetchScriptCatRelease(version)
  const cacheRoot = path.join(root, '.cache', 'e2e', 'scriptcat', release.tag_name)
  const marker = path.join(cacheRoot, '.extension-root')
  const cachedRoot = readTextFile(marker)
  if (cachedRoot && existsSync(path.join(cacheRoot, cachedRoot === '.' ? '' : cachedRoot, 'manifest.json'))) {
    return path.join(cacheRoot, cachedRoot === '.' ? '' : cachedRoot)
  }

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
    index > 0
    && value === '--config'
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
      instance: process.env.E2E_HARNESS_INSTANCE ?? 'default',
      port: undefined,
    }
  }

  const control = args.slice(0, separator)
  const passthrough = args.slice(separator + 1)
  let instance = process.env.E2E_HARNESS_INSTANCE ?? 'default'
  let port
  const plugins: PluginConfig[] = []
  for (let index = 0; index < control.length; index += 1) {
    const option = control[index]
    if (option === '--instance') {
      if (!control[index + 1]) throw new Error('--instance requires a value')
      instance = control[++index]
      continue
    }
    if (option === '--port') {
      if (!control[index + 1]) throw new Error('--port requires a value')
      port = normalizePort(control[++index])
      continue
    }
    if (option === '--plugin') {
      if (!control[index + 1]) throw new Error('--plugin requires a value')
      plugins.push(parsePluginOption(control[++index]))
      continue
    }
    throw new Error(`Unknown harness option: ${option}`)
  }
  return { args: passthrough, instance: normalizeInstance(instance), port, plugins }
}

export function parsePluginOption(value: string): PluginConfig {
  if (value === 'disable-csp') return { name: 'disable-csp' }
  const match = /^userscript(?:@([^=]+))?=(.+)$/.exec(value)
  if (!match) throw new Error(`Unknown plugin: ${value}`)
  const [, version, url] = match
  return pluginSchema.parse({ name: 'userscript', url, ...(version ? { version } : {}) })
}

async function main(argv = process.argv.slice(2)): Promise<void | string | number> {
  const { command, args, configFile } = parseCli(argv)
  if (!command || command === 'help' || command === '--help') {
    console.log('usage: node <e2e>/scripts/harness.ts <browser|playwright|start|stop|cookies|install-userscript|enable-user-scripts> [--config path] [--instance id --port n --plugin disable-csp --plugin userscript[@version]=url --] [args]')
    return
  }

  const configPath = configFile
    ? path.resolve(process.cwd(), configFile)
    : path.join(inferProjectRoot(), DEFAULT_CONFIG)
  const config = await loadHarnessConfig(path.dirname(configPath), configPath)
  if (command === 'start') return startHarness(config)
  if (command === 'stop') {
    stopManagedHarness(config, process.env.E2E_HARNESS_INSTANCE ?? 'default')
    return stopHarness(config)
  }
  if (command === 'browser') {
    const surface = parseSurfaceArgs(args)
    return runAgentCommand(config, surface.args, surface)
  }
  if (command === 'playwright') {
    const surface = parseSurfaceArgs(args)
    return runPlaywrightCommand(config, surface.args, surface)
  }
  if (command === 'cookies') return importCookies(config)
  if (command === 'install-userscript') return installUserscript(config)
  if (command === 'enable-user-scripts') return enableUserScripts(config)
  throw new Error(`Unknown E2E harness command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
