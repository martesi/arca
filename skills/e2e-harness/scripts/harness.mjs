#!/usr/bin/env bun

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { loadLocalCookies } from '../assets/browser/cookie-loader.mjs'
import {
  createRuntime,
  ensureXvfb,
  isReachable,
  spawnOwned,
  stopOwnedProcess,
  waitForUrls,
} from '../assets/browser/runtime.mjs'

const DEFAULT_CONFIG = 'e2e/harness.config.mjs'
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

export async function loadHarnessConfig(root = process.cwd(), configFile = DEFAULT_CONFIG) {
  const file = path.resolve(root, configFile)
  if (!existsSync(file)) throw new Error(`E2E harness config not found: ${file}`)
  const module = await import(pathToFileURL(file).href)
  return normalizeConfig(module.default ?? module, root)
}

export function normalizeConfig(input, root = process.cwd()) {
  const agent = input.agent ?? {}
  const userscript = input.userscript ?? false
  return {
    root,
    display: input.display === false ? false : {
      value: input.display?.value ?? process.env.DISPLAY ?? ':99',
      timeout: input.display?.timeout ?? 5000,
    },
    dev: Array.isArray(input.dev) ? input.dev : input.dev ? [input.dev] : [],
    agent: {
      command: agent.command ?? 'agent-browser',
      session: agent.session ?? path.basename(root),
      profile: resolveProjectPath(root, agent.profile ?? '.browser-state/agent'),
      executablePath: agent.executablePath,
      extensions: (agent.extensions ?? []).filter(Boolean).map((value) => resolveProjectPath(root, value)),
      args: agent.args ?? [],
      env: agent.env ?? {},
      screenshotDir: agent.screenshotDir ? resolveProjectPath(root, agent.screenshotDir) : undefined,
      headed: agent.headed ?? true,
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

export async function importCookies(config) {
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
    runAgent(config, args)
  }
  return cookies.length
}

export async function installUserscript(config) {
  const installUrl = config.userscript?.installUrl
  if (!installUrl) throw new Error('userscript.installUrl is required')

  const before = new Set(readTabs(runAgent(config, ['tab', 'list', '--json'], { capture: true })).map((tab) => tab.tabId))
  runAgent(config, ['open', installUrl])

  const confirmation = await waitForConfirmationTab(config, before)
  runAgent(config, ['tab', confirmation.tabId])
  runAgent(config, ['wait', '--fn', INSTALL_READY])
  runAgent(config, ['eval', INSTALL_CLICK])
  runAgent(config, ['wait', '--fn', INSTALL_DONE])
}

export async function enableUserScripts(config) {
  const name = config.userscript?.managerName
  if (!name) throw new Error('userscript.manager or userscript.managerName is required')

  runAgent(config, ['open', 'chrome://extensions/'])
  const expression = permissionExpression(name)
  runAgent(config, ['wait', '--fn', `() => (${expression})().found`])
  runAgent(config, ['eval', `() => { const result = (${expression})(); if (!result.enabled) result.toggle.click(); return result.enabled ? 'enabled' : 'enabled-now' }`])
  runAgent(config, ['wait', '--fn', `() => (${expression})().enabled`])
}

export function runAgent(config, args, { capture = false, allowFailure = false } = {}) {
  const fullArgs = [...(config.agent.session ? ['--session', config.agent.session] : []), ...args]
  const result = spawnSync(config.agent.command, fullArgs, {
    cwd: config.root,
    env: buildAgentEnv(config),
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (!allowFailure && result.status !== 0) {
    const detail = capture ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(`${config.agent.command} failed (${result.status})${detail ? `: ${detail}` : ''}`)
  }
  return capture ? String(result.stdout ?? '') : ''
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

async function waitForConfirmationTab(config, previousIds) {
  const deadline = Date.now() + config.userscript.confirmationTimeout
  while (Date.now() < deadline) {
    const tabs = readTabs(runAgent(config, ['tab', 'list', '--json'], { capture: true }))
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

function managerName(manager) {
  if (!manager) return undefined
  if (manager.toLowerCase() === 'scriptcat') return 'ScriptCat'
  if (manager.toLowerCase() === 'violentmonkey') return 'Violentmonkey'
  return manager
}

function parseCli(argv) {
  const args = [...argv]
  let configFile = process.env.E2E_HARNESS_CONFIG ?? DEFAULT_CONFIG
  const configIndex = args.indexOf('--config')
  if (configIndex >= 0) {
    if (!args[configIndex + 1]) throw new Error('--config requires a path')
    configFile = args[configIndex + 1]
    args.splice(configIndex, 2)
  }
  if (args[1] === '--') args.splice(1, 1)
  return { command: args[0], args: args.slice(1), configFile }
}

async function main(argv = process.argv.slice(2)) {
  const { command, args, configFile } = parseCli(argv)
  if (!command || command === 'help' || command === '--help') {
    console.log('usage: bun <e2e-harness>/scripts/harness.mjs <start|stop|browser|cookies|install-userscript|enable-user-scripts> [--config path] [args]')
    return
  }

  const config = await loadHarnessConfig(process.cwd(), configFile)
  if (command === 'start') return startHarness(config)
  if (command === 'stop') return stopHarness(config)
  if (command === 'browser') return runAgent(config, args)
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
