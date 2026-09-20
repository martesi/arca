#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

const DEFAULT_CONFIG = 'e2e.toml'
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IDLE_TIMEOUT = 5 * 60_000
const DEFAULT_CDP_TIMEOUT = 10_000
const PLAYWRIGHT_CLI = path.join(SKILL_ROOT, 'node_modules', '.bin', 'playwright-cli')
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
      command: agent.command ?? PLAYWRIGHT_CLI,
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
  profile?: string
  sensitive?: boolean
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
  await runAgentCommand(config, ['snapshot'])
}

export async function stopHarness(config: HarnessConfig): Promise<void> {
  await stopManagedHarness(config)
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

export async function enableUserScripts(config: HarnessConfig, agentOptions: AgentOptions = {}): Promise<boolean> {
  const name = config.userscript && config.userscript.managerName
  if (!name) throw new Error('userscript.manager or userscript.managerName is required')

  return enableUserScriptsNamed(config, name, agentOptions)
}

async function enableUserScriptsNamed(
  config: HarnessConfig,
  name: string,
  agentOptions: AgentOptions = {},
): Promise<boolean> {

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
    return { changed, active: true }
  })`, '--raw'], { ...agentOptions, capture: true })
  const result: unknown = JSON.parse(output.trim())
  return isRecord(result) && result.changed === true
}

export function runAgent(config: HarnessConfig, args: string[], {
  capture = false,
  allowFailure = false,
  endpoint,
  instance = 'default',
  profile,
  sensitive = false,
}: AgentOptions = {}): string {
  const scope = agentScope(config, instance)
  const fullArgs = [
    ...(scope.session ? [`-s=${scope.session}`] : []),
    ...args,
  ]
  const captureOutput = capture || sensitive
  const result = spawnSync(config.agent.command, fullArgs, {
    cwd: config.root,
    env: endpoint ? buildAttachedAgentEnv(config, scope, endpoint, profile) : buildAgentEnv(config),
    encoding: captureOutput ? 'utf8' : undefined,
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (!allowFailure && result.status !== 0) {
    const detail = capture && !sensitive ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(`playwright-cli failed (${result.status})${detail ? `: ${detail}` : ''}`)
  }
  return capture ? String(result.stdout ?? '') : ''
}

function ensurePlaywrightSession(config: HarnessConfig, endpoint: string, instance: string, profile?: string): void {
  const scope = agentScope(config, instance)
  const probe = spawnSync(config.agent.command, [`-s=${scope.session}`, 'tab-list', '--json'], {
    cwd: config.root,
    env: buildAttachedAgentEnv(config, scope, endpoint, profile),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (probe.status === 0) return

  const result = spawnSync(config.agent.command, [
    'attach',
    '--cdp',
    endpoint,
    '--session',
    scope.session,
    '--idle-timeout',
    String(config.agent.idleTimeout),
  ], {
    cwd: config.root,
    env: buildAttachedAgentEnv(config, scope, endpoint, profile),
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
  { instance = 'default', port, plugins = [] }: SurfaceOptions = {},
): Promise<string> {
  let managed = await ensureManagedBrowser(config, 'agent', instance, port, plugins)
  managed = await ensureUserScriptsAccess(config, 'agent', instance, port, plugins, managed)
  const { browser, preparedPlugins } = managed
  const token = beginIdleWindow(browser.runtime)
  const agentOptions = { endpoint: browser.endpoint, instance, profile: browser.profile }

  try {
    ensurePlaywrightSession(config, browser.endpoint, instance, browser.profile)
    if (browser.started) {
      await bootstrapPlugins(config, preparedPlugins, agentOptions)
      await bootstrapAttachedAgent(config, agentOptions)
    }
    return runAgent(config, args, agentOptions)
  } finally {
    scheduleIdleStop(browser.runtime, token, config.agent.idleTimeout)
  }
}

async function runAgentAction<T>(
  config: HarnessConfig,
  action: (options: AgentOptions) => Promise<T>,
): Promise<T> {
  const instance = process.env.E2E_HARNESS_INSTANCE ?? 'default'
  const { browser } = await ensureManagedBrowser(config, 'agent', instance)
  const token = beginIdleWindow(browser.runtime)
  const agentOptions = { endpoint: browser.endpoint, instance, profile: browser.profile }
  try {
    ensurePlaywrightSession(config, browser.endpoint, instance, browser.profile)
    return await action(agentOptions)
  } finally {
    scheduleIdleStop(browser.runtime, token, config.agent.idleTimeout)
  }
}

export async function runPlaywrightCommand(
  config: HarnessConfig,
  args: string[],
  { instance = 'default', port, plugins = [] }: SurfaceOptions = {},
): Promise<void> {
  let managed = await ensureManagedBrowser(config, 'playwright', instance, port, plugins)
  managed = await ensureUserScriptsAccess(config, 'playwright', instance, port, plugins, managed)
  const { browser, preparedPlugins } = managed
  const token = beginIdleWindow(browser.runtime)
  const command = config.playwright.command

  try {
    const needsBootstrap = preparedPlugins.userscriptUrls.length > 0
    if (browser.started && needsBootstrap) {
      const bootstrapInstance = `playwright-${normalizeInstance(instance)}`
      const agentOptions = { endpoint: browser.endpoint, instance: bootstrapInstance, profile: browser.profile }
      ensurePlaywrightSession(config, browser.endpoint, bootstrapInstance, browser.profile)
      try {
        await bootstrapPlugins(config, preparedPlugins, agentOptions)
      } finally {
        runAgent(config, ['detach'], { ...agentOptions, allowFailure: true })
      }
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

export async function stopManagedHarness(config: HarnessConfig, instance = 'default'): Promise<void> {
  runAgent(config, ['detach'], { allowFailure: true, instance })
  const modes: SurfaceMode[] = ['agent', 'playwright']
  for (const mode of modes) {
    await stopCdpBrowserAndWait(createRuntime(config.root, runtimeName(mode, instance)))
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
  const configuredExtensions = preparedPlugins.userscriptUrls.length
    ? surface.extensions.filter((extension) => !isScriptCatExtension(extension))
    : surface.extensions
  const extensions = unique([...configuredExtensions, ...preparedPlugins.extensions])
  const headed = surface.headed || preparedPlugins.userscriptUrls.length > 0
  const runtime = createRuntime(config.root, runtimeName(mode, scope.instance))
  const browserKey = JSON.stringify({ extensions, plugins: preparedPlugins.key })
  const keyFile = runtime.path('browser-key')
  if (existsSync(runtime.path('browser.pid')) && readTextFile(keyFile) !== browserKey) {
    await stopCdpBrowserAndWait(runtime)
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
  runAgent(config, ['goto', 'about:blank'], agentOptions)
  for (const url of plugins.userscriptUrls) {
    await installUserscriptUrl(config, url, agentOptions)
  }
}

async function ensureUserScriptsAccess(
  config: HarnessConfig,
  mode: SurfaceMode,
  instance: string,
  port: number | undefined,
  cliPlugins: PluginConfig[],
  managed: { browser: CdpBrowser; preparedPlugins: PreparedPlugins },
): Promise<{ browser: CdpBrowser; preparedPlugins: PreparedPlugins }> {
  if (!managed.browser.started) return managed
  const managers = unique([
    ...(managed.preparedPlugins.userscriptUrls.length ? ['ScriptCat'] : []),
    ...(config.userscript && config.userscript.enableUserScripts && config.userscript.managerName
      ? [config.userscript.managerName]
      : []),
  ])
  if (!managers.length) return managed

  const setupInstance = `setup-${mode}-${normalizeInstance(instance)}`
  const agentOptions = {
    endpoint: managed.browser.endpoint,
    instance: setupInstance,
    profile: managed.browser.profile,
  }
  ensurePlaywrightSession(config, managed.browser.endpoint, setupInstance, managed.browser.profile)
  let changed = false
  try {
    for (const manager of managers) {
      changed = await enableUserScriptsNamed(config, manager, agentOptions) || changed
    }
  } finally {
    runAgent(config, ['detach'], { ...agentOptions, allowFailure: true })
  }
  if (!changed) return managed

  await stopCdpBrowserAndWait(managed.browser.runtime)
  return ensureManagedBrowser(config, mode, instance, port, cliPlugins)
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
  profile = scope.profile,
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
  env.E2E_HARNESS_PROFILE = profile
  env.PLAYWRIGHT_MCP_OUTPUT_DIR ??= path.join(config.root, '.cache', 'e2e', 'playwright-cli', scope.instance)
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
  return { ...scope, session }
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

  if (userscriptUrls.length) extensions.push(await ensureScriptCat(config.root, version))
  if (plugins.some((plugin) => plugin.name === 'disable-csp')) {
    extensions.push(ensureDisableCsp(config.root))
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

function ensureDisableCsp(root: string): string {
  const source = path.join(SKILL_ROOT, 'assets', 'disable-csp')
  const files = ['manifest.json', 'rules.json']
  const hash = createHash('sha256')
  for (const file of files) hash.update(readFileSync(path.join(source, file)))
  const target = path.join(root, '.cache', 'e2e', 'extensions', 'disable-csp', hash.digest('hex').slice(0, 16))
  if (existsSync(path.join(target, 'manifest.json'))) return target

  mkdirSync(target, { recursive: true })
  for (const file of files) writeFileSync(path.join(target, file), readFileSync(path.join(source, file)))
  return target
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

async function main(argv = process.argv.slice(2)): Promise<void | string | number | boolean> {
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
    return stopManagedHarness(config, process.env.E2E_HARNESS_INSTANCE ?? 'default')
  }
  if (command === 'browser') {
    const surface = parseSurfaceArgs(args)
    return runAgentCommand(config, surface.args, surface)
  }
  if (command === 'playwright') {
    const surface = parseSurfaceArgs(args)
    return runPlaywrightCommand(config, surface.args, surface)
  }
  if (command === 'cookies') return runAgentAction(config, (options) => importCookies(config, options))
  if (command === 'install-userscript') return runAgentAction(config, (options) => installUserscript(config, options))
  if (command === 'enable-user-scripts') return runAgentAction(config, (options) => enableUserScripts(config, options))
  throw new Error(`Unknown E2E harness command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
