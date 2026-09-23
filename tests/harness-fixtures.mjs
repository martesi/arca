import path from 'node:path'
import { createServer } from 'node:net'

const fixturesDir = path.join(import.meta.dir, 'fixtures')

function makeFakeAgent(root) {
  return { command: path.join(fixturesDir, 'fake-agent.mjs'), log: path.join(root, 'agent.jsonl') }
}

function makeFakeChromium() {
  return path.join(fixturesDir, 'fake-chromium.mjs')
}

function makeFakeShell() {
  return path.join(fixturesDir, 'fake-shell.mjs')
}

async function withDriver(driver, action) {
  const previous = process.env.E2E_HARNESS_DRIVER
  process.env.E2E_HARNESS_DRIVER = driver.command
  try {
    return await action()
  } finally {
    if (previous === undefined) delete process.env.E2E_HARNESS_DRIVER
    else process.env.E2E_HARNESS_DRIVER = previous
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function readCalls(file) {
  return (await Bun.file(file).text()).trim().split('\n').filter(Boolean).map(JSON.parse)
}

async function exists(file) {
  return Bun.file(file).exists()
}

export { exists, freePort, makeFakeAgent, makeFakeChromium, makeFakeShell, readCalls, withDriver }
