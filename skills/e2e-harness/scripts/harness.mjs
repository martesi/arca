#!/usr/bin/env bun

import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loadLocalCookies } from '../assets/browser/cookie-loader.mjs'
import {
  beginIdleWindow,
  ensureCdpBrowser,
  scheduleIdleStop,
  stopCdpBrowser,
} from '../assets/browser/cdp-runtime.mjs'
import {
  createRuntime,
  ensureXvfb,
  isReachable,
  spawnOwned,
  stopOwnedProcess,
  waitForUrls,
} from '../assets/browser/runtime.mjs'

const DEFAULT_CONFIG = 'e2e.toml'
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IDLE_TIMEOUT = 5 * 60_000
const DEFAULT_CDP_TIMEOUT = 10_000
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

export async function loadHarnessConfig(root = inferProjectRoot(), configFile = DEFAULT_CONFIG, env = process.env) {
  const file = path.isAbsolute(configFile) ? configFile : path.resolve(root, configFile)
  if (!existsSync(file)) throw new Error(`E2E harness config not found: ${file}`)
  return normalizeConfig(Bun.TOML.parse(readFileSync(file, 'utf8')), root, env)
}

export function inferProjectRoot(skillRoot = SKILL_ROOT) {
  const root = path.resolve(skillRoot, '../..')
  return path.basename(root) === '.agents' ? path.dirname(root) : root
}

export function normalizeConfig(input, root = process.cwd(), env = process.env) {
  const agent = input.agent ?? {}
  const playwright = input.playwright ?? {}
  const userscript = input.userscript ?? false
  const agentExtensions = agent.extensions ?? commaList(env.AGENT_BROWSER_EXTENSIONS)
  return {
    root,
    shell: input.shell ? {
      command: normalizeCommand(input.shell.command),
      chromium: input.shell.chromium ?? 'chromium',
    } : false,
    display: input.display === false ? false : {
      value: input.display?.value ?? env.DISPLAY ?? ':99',
      timeout: input.display?.timeout ?? 5000,
    },
    dev: Array.isArray(input.dev) ? input.dev : input.dev ? [input.dev] : [],
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
      command: normalizeCommand(playwright.command ?? ['bunx', 'playwright']),
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
    cookies: input.cookies === false ? false : {
      file: input.cookies?.file,
      required: input.cookies?.required ?? false,
    },
    userscript: userscript === false ? false : {
      installUrl: userscript.installUrl,
      installOnStart: userscript.installOnStart ?? Boolean(userscript.installUrl),
      enableUserScripts: userscript.enableUserScripts ?? Boolean(userscript.manager),
      manager: userscript.manager,
      managerName: userscript.managerName ?? managerName(userscript.manager),
      confirmationTimeout: userscript.confirmationTimeout ?? 30_000,
    },
    targetUrl: input.targetUrl,
  }
}

export function buildAgentEnv(config, base = process.env) {
  const env = { ...base, ...stringEnv(config.agent.env) }
  env.AGENT_BROWSER_PROFILE = config.agent.profile
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(config.agent.idleTimeout)
  if (config.agent.executablePath) env.AGENT_BROWSER_EXECUTABLE_PATH = config.agent.executablePath
  if (config.agent.extensions.length) env.AGENT_BROWSER_EXTENSIONS = config.agent.extensions.join(',')
  if (config.agent.args.length) env.AGENT_BROWSER_ARGS = config.agent.args.join(' ')
  if (config.agent.screenshotDir) env.AGENT_BROWSER_SCREENSHOT_DIR = config.agent.screenshotDir
  return env
}

export async function startHarness(config) {
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

  if (config.userscript?.enableUserScripts && config.userscript.managerName) {
    await enableUserScripts(config)
  }
  if (config.cookies) await importCookies(config)
  if (config.userscript?.installOnStart && config.userscript.installUrl) {
    await installUserscript(config)
  }
  if (config.targetUrl) runAgent(config, ['open', config.targetUrl])
}

export function stopHarness(config) {
  const runtime = createRuntime(config.root, 'agent')
  runAgent(config, ['close'], { allowFailure: true })
  config.dev.forEach((_, index) => stopOwnedProcess(runtime.path(`dev-${index}.pid`)))
  stopOwnedProcess(runtime.path('xvfb.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
}

export async function importCookies(config, agentOptions = {}) {
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

export async function installUserscript(config, agentOptions = {}) {
  const installUrl = config.userscript?.installUrl
  if (!installUrl) throw new Error('userscript.installUrl is required')

  const before = new Set(readTabs(runAgent(config, ['tab', 'list', '--json'], { ...agentOptions, capture: true })).map((tab) => tab.tabId))
  runAgent(config, ['open', installUrl], agentOptions)

  const confirmation = await waitForConfirmationTab(config, before, agentOptions)
  runAgent(config, ['tab', confirmation.tabId], agentOptions)
  runAgent(config, ['wait', '--fn', INSTALL_READY], agentOptions)
  runAgent(config, ['eval', INSTALL_CLICK], agentOptions)
  runAgent(config, ['wait', '--fn', INSTALL_DONE], agentOptions)
}

export async function enableUserScripts(config, agentOptions = {}) {
  const name = config.userscript?.managerName
  if (!name) throw new Error('userscript.manager or userscript.managerName is required')

  runAgent(config, ['open', 'chrome://extensions/'], agentOptions)
  const expression = permissionExpression(name)
  runAgent(config, ['wait', '--fn', `() => (${expression})().found`], agentOptions)
  runAgent(config, ['eval', `() => { const result = (${expression})(); if (!result.enabled) result.toggle.click(); return result.enabled ? 'enabled' : 'enabled-now' }`], agentOptions)
  runAgent(config, ['wait', '--fn', `() => (${expression})().enabled`], agentOptions)
}

export function runAgent(config, args, {
  capture = false,
  allowFailure = false,
  endpoint,
  instance = 'default',
} = {}) {
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

export async function runAgentCommand(config, args, { instance = 'default', port } = {}) {
  const browser = await ensureManagedBrowser(config, 'agent', instance, port)
  const token = beginIdleWindow(browser.runtime)
  const agentOptions = { endpoint: browser.endpoint, instance }

  try {
    if (browser.started) await bootstrapAttachedAgent(config, agentOptions)
    return runAgent(config, args, agentOptions)
  } finally {
    scheduleIdleStop(browser.runtime, token, config.agent.idleTimeout)
  }
}

export async function runPlaywrightCommand(config, args, { instance = 'default', port } = {}) {
  const browser = await ensureManagedBrowser(config, 'playwright', instance, port)
  const token = beginIdleWindow(browser.runtime)
  const command = config.playwright.command

  try {
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

export function stopManagedHarness(config, instance = 'default') {
  for (const mode of ['agent', 'playwright']) {
    stopCdpBrowser(createRuntime(config.root, runtimeName(mode, instance)))
  }

  const runtime = createRuntime(config.root, 'e2e-harness')
  config.dev.forEach((_, index) => stopOwnedProcess(runtime.path(`dev-${index}.pid`)))
  stopOwnedProcess(runtime.path('xvfb.pid'))
  rmSync(runtime.dir, { recursive: true, force: true })
}

async function ensureManagedBrowser(config, mode, instance, port) {
  const surface = config[mode]
  const scope = surfaceScope(config, mode, instance)
  await ensureSharedRuntime(config, surface.headed)
  return ensureCdpBrowser({
    root: config.root,
    name: runtimeName(mode, scope.instance),
    profile: scope.profile,
    command: chromiumCommand(config, surface),
    args: surface.args,
    extensions: surface.extensions,
    headed: surface.headed,
    port: port === undefined ? surface.port : normalizePort(port),
    timeout: DEFAULT_CDP_TIMEOUT,
  })
}

async function ensureSharedRuntime(config, needsDisplay) {
  const runtime = createRuntime(config.root, 'e2e-harness')
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

async function bootstrapAttachedAgent(config, agentOptions) {
  runAgent(config, ['open', 'about:blank'], agentOptions)
  if (config.userscript?.enableUserScripts && config.userscript.managerName) {
    await enableUserScripts(config, agentOptions)
  }
  if (config.cookies) await importCookies(config, agentOptions)
  if (config.userscript?.installOnStart && config.userscript.installUrl) {
    await installUserscript(config, agentOptions)
  }
  if (config.targetUrl) runAgent(config, ['open', config.targetUrl], agentOptions)
}

function buildPlaywrightEnv(config, browser, instance, base = process.env) {
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

function buildAttachedAgentEnv(config, scope, endpoint, base = process.env) {
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

function chromiumCommand(config, surface) {
  if (surface.executablePath) return [surface.executablePath]
  if (config.shell?.command.length) return [...config.shell.command, config.shell.chromium]
  return [config.shell?.chromium ?? 'chromium']
}

function agentScope(config, instance) {
  const scope = surfaceScope(config, 'agent', instance)
  const session = scope.instance === 'default'
    ? config.agent.session
    : `${config.agent.session}-${scope.instance}`
  return { ...scope, session, namespace: session || `e2e-${scope.instance}` }
}

function surfaceScope(config, mode, instance) {
  const normalized = normalizeInstance(instance)
  const baseProfile = config[mode].profile
  return {
    instance: normalized,
    profile: normalized === 'default' ? baseProfile : path.join(baseProfile, normalized),
  }
}

function runtimeName(mode, instance) {
  return `${mode}-${normalizeInstance(instance)}`
}

async function startDevProcesses(config, runtime) {
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

async function waitForConfirmationTab(config, previousIds, agentOptions = {}) {
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

export function readTabs(output) {
  const result = readAgentJson(output)
  const tabs = result.data?.tabs
  if (!Array.isArray(tabs)) throw new Error('agent-browser returned no browser tabs')
  return tabs.filter((tab) => tab && typeof tab.tabId === 'string' && typeof tab.url === 'string')
}

function readAgentJson(output) {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') return value
    } catch {
      // agent-browser may surround JSON with human-readable output.
    }
  }
  throw new Error('agent-browser returned invalid JSON')
}

function permissionExpression(name) {
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

function resolveProjectPath(root, value) {
  if (!value || path.isAbsolute(value)) return value
  return path.resolve(root, value)
}

function stringEnv(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  )
}

function commaList(value) {
  if (!value) return []
  return String(value).split(',').map((item) => item.trim()).filter(Boolean)
}

function normalizeCommand(value) {
  const command = Array.isArray(value) ? value : value ? [value] : []
  if (command.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('command entries must be non-empty strings')
  }
  return command
}

function normalizePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid CDP port: ${value}`)
  }
  return port
}

function normalizeTimeout(value) {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error(`invalid idle timeout: ${value}`)
  }
  return timeout
}

function normalizeInstance(value) {
  const instance = String(value || 'default')
  if (!/^[A-Za-z0-9._-]+$/.test(instance)) {
    throw new Error('instance must contain only letters, numbers, dot, underscore, or hyphen')
  }
  return instance
}

function managerName(manager) {
  if (!manager) return undefined
  if (manager.toLowerCase() === 'scriptcat') return 'ScriptCat'
  if (manager.toLowerCase() === 'violentmonkey') return 'Violentmonkey'
  return manager
}

function parseCli(argv) {
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

function parseSurfaceArgs(args) {
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
    throw new Error(`Unknown harness option: ${option}`)
  }
  return { args: passthrough, instance: normalizeInstance(instance), port }
}

async function main(argv = process.argv.slice(2)) {
  const { command, args, configFile } = parseCli(argv)
  if (!command || command === 'help' || command === '--help') {
    console.log('usage: bun <e2e-harness>/scripts/harness.mjs <browser|playwright|start|stop|cookies|install-userscript|enable-user-scripts> [--config path] [--instance id --port n --] [args]')
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

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
