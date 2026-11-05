import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { usageLedgerPath } from '../../../src/usage/ledger.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-usage-ledger-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rows = '{"ts":1,"model":"m"}\n{"ts":2,"model":"m"}\n'

test('carries today.jsonl over to requests.jsonl', () => {
  const dataDir = join(dir, 'carry')
  mkdirAndWrite(join(dataDir, 'usage', 'today.jsonl'), rows)

  expect(usageLedgerPath(dataDir)).toBe(
    join(dataDir, 'usage', 'requests.jsonl'),
  )
  expect(readFileSync(join(dataDir, 'usage', 'requests.jsonl'), 'utf8')).toBe(
    rows,
  )
  expect(existsSync(join(dataDir, 'usage', 'today.jsonl'))).toBe(false)
})

test('a second call keeps the ledger as it is', () => {
  const dataDir = join(dir, 'idempotent')
  mkdirAndWrite(join(dataDir, 'usage', 'today.jsonl'), rows)
  usageLedgerPath(dataDir)

  expect(usageLedgerPath(dataDir)).toBe(
    join(dataDir, 'usage', 'requests.jsonl'),
  )
  expect(readFileSync(join(dataDir, 'usage', 'requests.jsonl'), 'utf8')).toBe(
    rows,
  )
})

test('an existing requests.jsonl wins and today.jsonl is left alone', () => {
  const dataDir = join(dir, 'both')
  mkdirAndWrite(join(dataDir, 'usage', 'requests.jsonl'), '{"ts":3}\n')
  mkdirAndWrite(join(dataDir, 'usage', 'today.jsonl'), rows)

  expect(usageLedgerPath(dataDir)).toBe(
    join(dataDir, 'usage', 'requests.jsonl'),
  )
  expect(readFileSync(join(dataDir, 'usage', 'requests.jsonl'), 'utf8')).toBe(
    '{"ts":3}\n',
  )
  expect(readFileSync(join(dataDir, 'usage', 'today.jsonl'), 'utf8')).toBe(rows)
})

test('a missing usage directory still yields the path', () => {
  const dataDir = join(dir, 'fresh')

  expect(usageLedgerPath(dataDir)).toBe(
    join(dataDir, 'usage', 'requests.jsonl'),
  )
  expect(existsSync(join(dataDir, 'usage'))).toBe(false)
})

function mkdirAndWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
