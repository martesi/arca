#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
if (args[0] !== 'chromium') throw new Error('expected chromium executable')

const profile = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
const root = profile ? path.resolve(profile, '../../../..') : process.cwd()
appendFileSync(path.join(root, 'shell.jsonl'), JSON.stringify(args) + '\n')

const chromium = path.join(import.meta.dir, 'fake-chromium.mjs')
const child = Bun.spawn([chromium, ...args.slice(1)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
process.exit(await child.exited)
