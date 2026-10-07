import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  const sessions = `'${join(dataDir, 'sessions')}'`
  expect(hint).toContain(
    `mkdir -p ${sessions} && cp -R '${join(dir.path, '.sessions')}'/. ${sessions}/ && rm -r '${join(dir.path, '.sessions')}'`,
  )
  expect(hint).toContain(
    `mv '${join(dir.path, 'knowledge.db')}'* '${join(dataDir, 'rag')}'/`,
  )
  // dataDir 就是项目目录时也要搬（新布局的子目录不带点）
  expect(legacyDataHint(dir.path, dir.path)).toContain('.sessions')
})

test('the migration commands keep old data, win over startup files and can run twice', () => {
  const dir = tempDir()
  dirs.push(dir)
  // 路径里有空格和单引号也要能用
  const cwd = join(dir.path, "my 'proj'")
  const dataDir = join(dir.path, 'home/projects/x')
  mkdirSync(join(cwd, '.sessions/default/tool-results'), { recursive: true })
  writeFileSync(join(cwd, '.sessions/default.jsonl'), 'old session')
  writeFileSync(join(cwd, '.sessions/default/tool-results/a.txt'), 'output')
  mkdirSync(join(cwd, '.memory'))
  writeFileSync(join(cwd, '.memory/MEMORY.md'), '# Memory Index\n- old')
  writeFileSync(join(cwd, 'knowledge.db'), 'db')
  writeFileSync(join(cwd, 'knowledge.db-journal'), 'journal')
  // 这次启动已经在新目录建了空的记忆索引和知识库
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  writeFileSync(join(dataDir, 'memory/MEMORY.md'), '# Memory Index\n')
  mkdirSync(join(dataDir, 'rag'))
  writeFileSync(join(dataDir, 'rag/knowledge.db'), '')

  const commands = (legacyDataHint(cwd, dataDir) ?? '')
    .split('\n')
    .filter((line) => line.startsWith('  '))
  expect(commands).toHaveLength(3)
  const run = () =>
    commands.map(
      (command) => Bun.spawnSync(['sh', '-c', command], { cwd: dir.path }).exitCode,
    )
  expect(run()).toEqual([0, 0, 0])
  const read = (path: string) => readFileSync(join(dataDir, path), 'utf-8')
  expect(read('sessions/default.jsonl')).toBe('old session')
  expect(read('sessions/default/tool-results/a.txt')).toBe('output')
  expect(read('memory/MEMORY.md')).toBe('# Memory Index\n- old')
  expect(read('rag/knowledge.db')).toBe('db')
  expect(read('rag/knowledge.db-journal')).toBe('journal')
  expect(legacyDataHint(cwd, dataDir)).toBeUndefined()
  // 再执行一次：旧数据已经不在，命令失败，新目录不变
  expect(run().every((code) => code !== 0)).toBe(true)
  expect(read('sessions/default.jsonl')).toBe('old session')
  expect(read('rag/knowledge.db')).toBe('db')
})
