import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export async function loadLocalCookies(
  root = process.cwd(),
  { file }: { file?: string } = {},
): Promise<BrowserCookie[]> {
  const files = await readdir(root)
  const selected = file
    ? files.includes(file) ? [file] : []
    : files.includes('cookies.json')
      ? ['cookies.json']
      : files.filter((name) => /^cookies.*\.txt$/i.test(name)).sort()

  return (await Promise.all(selected.map((name) => readCookieFile(path.join(root, name))))).flat()
}

export function parseJsonCookies(source: string): BrowserCookie[] {
  const parsed: unknown = JSON.parse(source)
  const cookies = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.cookies)
      ? parsed.cookies
      : undefined

  if (!cookies) {
    throw new Error('cookies.json must contain an array or a { cookies: [] } object')
  }

  return cookies.flatMap((value) => {
    if (!isRecord(value) || typeof value.name !== 'string' || typeof value.domain !== 'string') {
      return []
    }

    return [{
      name: value.name,
      value: typeof value.value === 'string' ? value.value : '',
      domain: value.domain,
      path: typeof value.path === 'string' ? value.path : '/',
      expires: Math.floor(numberValue(value.expirationDate ?? value.expires, -1)),
      httpOnly: Boolean(value.httpOnly),
      secure: Boolean(value.secure),
      sameSite: normalizeSameSite(value.sameSite),
    }]
  })
}

export function parseNetscapeCookies(source: string): BrowserCookie[] {
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

async function readCookieFile(file: string): Promise<BrowserCookie[]> {
  const source = await readFile(file, 'utf8')
  return file.endsWith('.json') ? parseJsonCookies(source) : parseNetscapeCookies(source)
}

function normalizeSameSite(value: unknown): BrowserCookie['sameSite'] {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'none' || normalized === 'no_restriction') return 'None'
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
