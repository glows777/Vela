import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extensionConfigFromEnv,
  legacyDataHint,
  parseArgs,
} from '../../../src/cli/setup'
import { tempDir } from '../../support/vela'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('parseArgs reads pi-style flags and rejects unknown ones', () => {
  expect(
    parseArgs(['-p', 'hi', '-e', 'a.ts', '--extension', 'builtin:web', '--no-extensions', '--no-session', '--approve', '--continue']),
  ).toEqual({
    print: 'hi',
    continue: true,
    extensions: ['a.ts', 'builtin:web'],
    noExtensions: true,
    noSession: true,
    approve: true,
  })
  expect(parseArgs(['--no-approve']).approve).toBe(false)
  expect(() => parseArgs(['-p'])).toThrow('-p 需要一个参数')
  expect(() => parseArgs(['--wat'])).toThrow('未知参数 --wat')
})

test('settings.json extension config overrides the environment defaults key by key', () => {
  const config = extensionConfigFromEnv(
    { TAVILY_API_KEY: 'env-tavily', SERPER_API_KEY: 'env-serper', EMBEDDING_MODEL: 'm' },
    { web: { tavilyKey: 'file' }, rag: { embedding: { apiKey: 'k' } }, mine: { a: 1 } },
  )
  expect(config.web).toEqual({ tavilyKey: 'file', serperKey: 'env-serper' })
  expect(config.rag).toEqual({
    embedding: { baseUrl: undefined, model: 'm', apiKey: 'k' },
  })
  expect(config.mine).toEqual({ a: 1 })
})

test('legacy data in the working directory gets a copy-and-remove hint', () => {
  const dir = tempDir()
  dirs.push(dir)
  const dataDir = join(dir.path, 'home/projects/x')
  expect(legacyDataHint(dir.path, dataDir)).toBeUndefined()
  mkdirSync(join(dir.path, '.sessions'))
  writeFileSync(join(dir.path, 'knowledge.db'), '')
  const hint = legacyDataHint(dir.path, dataDir) ?? ''
  expect(hint).toContain('.sessions、knowledge.db')
  expect(hint).toContain(
    `mkdir -p "${join(dataDir, 'sessions')}" && cp -R .sessions/. "${join(dataDir, 'sessions')}/" && rm -r .sessions`,
  )
  expect(hint).toContain(`mv knowledge.db "${join(dataDir, 'rag/knowledge.db')}"`)
  expect(legacyDataHint(dir.path, dir.path)).toBeUndefined()
})
