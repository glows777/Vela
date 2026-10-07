import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInteractiveLogger } from '../../../src/cli/logger.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-logger-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('interactive logger: info / warn / error go to the attached sink, debug goes to the debug log', () => {
  const debugLog = join(root, 'nested', 'debug.log')
  const { logger, attach } = createInteractiveLogger({ debugLog })
  const seen: string[] = []
  attach((level, message) => seen.push(`${level}:${message}`))

  logger.info('a')
  logger.warn('b')
  logger.error('c')
  logger.debug('d')

  expect(seen).toEqual(['info:a', 'warning:b', 'error:c'])
  expect(readFileSync(debugLog, 'utf8')).toMatch(/Z d\n$/)
})

test('interactive logger without VELA_DEBUG drops debug messages', () => {
  const { logger, attach } = createInteractiveLogger({})
  const seen: string[] = []
  attach((_level, message) => seen.push(message))
  logger.debug('hidden')
  expect(seen).toEqual([])
})
