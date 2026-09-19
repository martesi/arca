import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export async function loadLocalCookies(root = process.cwd()) {
  const files = await readdir(root)
  const selected = files.includes('cookies.json')
    ? ['cookies.json']
    : files.filter((file) => /^cookies.*\.txt$/i.test(file)).sort()

  return (await Promise.all(selected.map((file) => readCookieFile(path.join(root, file))))).flat()
}

export function parseJsonCookies(source) {
  const parsed = JSON.parse(source)
  const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies
  if (!Array.isArray(cookies)) {
    throw new Error('cookies.json must contain an array or a { cookies: [] } object')
  }

  return cookies
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? '/',
      expires: Math.floor(cookie.expirationDate ?? cookie.expires ?? -1),
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: normalizeSameSite(cookie.sameSite),
    }))
    .filter((cookie) => cookie.name && cookie.domain)
}

export function parseNetscapeCookies(source) {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const httpOnly = line.startsWith('#HttpOnly_')
    if ((!httpOnly && line.startsWith('#')) || !line.trim()) return []

    const fields = (httpOnly ? line.slice('#HttpOnly_'.length) : line).split('\t')
    if (fields.length < 7) {
      throw new Error(`invalid Netscape cookie at line ${index + 1}`)
    }

    const [domain, , cookiePath, secure, expires, name, ...value] = fields
    if (!domain || !name) throw new Error(`invalid Netscape cookie at line ${index + 1}`)

    return [{
      name,
      value: value.join('\t'),
      domain,
      path: cookiePath || '/',
      expires: Number(expires) || -1,
      httpOnly,
      secure: secure.toUpperCase() === 'TRUE',
    }]
  })
}

async function readCookieFile(file) {
  const source = await readFile(file, 'utf8')
  return file.endsWith('.json') ? parseJsonCookies(source) : parseNetscapeCookies(source)
}

function normalizeSameSite(value) {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'none' || normalized === 'no_restriction') return 'None'
  return undefined
}
