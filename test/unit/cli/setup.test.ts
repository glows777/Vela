import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_EXTENSIONS,
  extensionConfigFromEnv,
  HELP,
  legacyDataHint,
  loadCliExtensions,
  packageVersion,
  parseArgs,
  resolveTrust,
} from '../../../src/cli/setup.ts'
import { loadConfig } from '../../../src/config/index.ts'
import { createFauxModel, fauxText } from '../../../src/testing/faux.ts'
import { createVela } from '../../../src/vela.ts'
import { tempDir } from '../../support/vela.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('parseArgs reads pi-style flags and rejects unknown ones', () => {
  expect(
    parseArgs([
      '-p',
      'hi',
      '-e',
      'a.ts',
      '--extension',
      'builtin:web',
      '--no-extensions',
      '--no-session',
      '--approve',
      '--continue',
    ]),
  ).toEqual({
    print: true,
    messages: ['hi'],
    continue: true,
    resume: false,
    extensions: ['a.ts', 'builtin:web'],
    noExtensions: true,
    noSession: true,
    approve: true,
    appendSystemPrompt: [],
    noContextFiles: false,
  })
  expect(
    parseArgs([
      '--append-system-prompt',
      'a',
      '--append-system-prompt',
      'b.md',
      '-nc',
    ]),
  ).toMatchObject({
    appendSystemPrompt: ['a', 'b.md'],
    noContextFiles: true,
  })
  expect(parseArgs(['--no-approve']).approve).toBe(false)
  expect(parseArgs(['--mode', 'json', 'one', 'two'])).toMatchObject({
    mode: 'json',
    messages: ['one', 'two'],
  })
  expect(parseArgs(['-r']).resume).toBe(true)
  expect(parseArgs(['--session', 'abc']).session).toBe('abc')
  expect(() => parseArgs(['--mode', 'xml'])).toThrow(
    '--mode must be text, json or rpc',
  )
  expect(() => parseArgs(['-c', '--session', 'x'])).toThrow(
    'Use only one of -c, -r and --session',
  )
  expect(() => parseArgs(['--model'])).toThrow('--model requires a value')
  expect(() => parseArgs(['--wat'])).toThrow('Unknown option --wat')
  // A bad session id is a usage error at parse time, not a stack trace from deep inside session startup
  expect(() => parseArgs(['--session', '.bad'])).toThrow(
    'Invalid session id ".bad"',
  )
})

test('the untrusted-project notice names the real trust.json under VELA_DIR', async () => {
  const home = tempDir()
  const project = tempDir()
  dirs.push(home, project)
  mkdirSync(join(project.path, '.vela'), { recursive: true })
  writeFileSync(join(project.path, '.vela', 'settings.json'), '{}')
  const result = await resolveTrust({
    cwd: project.path,
    agentDir: home.path,
    interactive: false,
  })
  expect(result.trusted).toBe(false)
  expect(result.warning).toContain(
    `edit ${join(home.path, 'trust.json')} to change this`,
  )
  expect(result.warning).not.toContain('~/.vela')
})

test('project skills alone make the project ask for trust; untrusted, the notice names skills', async () => {
  const home = tempDir()
  const project = tempDir()
  dirs.push(home, project)
  mkdirSync(join(project.path, '.skills', 'deploy'), { recursive: true })
  writeFileSync(join(project.path, '.skills', 'deploy', 'SKILL.md'), 'Deploy')
  const result = await resolveTrust({
    cwd: project.path,
    agentDir: home.path,
    interactive: false,
  })
  expect(result.trusted).toBe(false)
  expect(result.warning).toContain(
    'Did not load config, extensions, skills and prompts',
  )
})

test('--help / -h and --version / -v are parsed', () => {
  expect(parseArgs(['--help']).help).toBe(true)
  expect(parseArgs(['-h']).help).toBe(true)
  expect(parseArgs(['--version']).version).toBe(true)
  expect(parseArgs(['-v']).version).toBe(true)
  expect(parseArgs([]).help).toBeUndefined()
  expect(parseArgs([]).version).toBeUndefined()
})

test('USAGE lists every flag, the modes and examples', () => {
  for (const flag of [
    '--print',
    '-p',
    '--mode',
    '--continue',
    '-c',
    '--resume',
    '-r',
    '--session',
    '--extension',
    '-e',
    '--no-extensions',
    '--no-session',
    '--approve',
    '--no-approve',
    '--model',
    '--thinking',
    '--help',
    '-h',
    '--version',
    '-v',
  ])
    expect(HELP).toContain(flag)
  expect(HELP).toContain('Examples:')
  expect(HELP).toContain('rpc')
})

test('packageVersion() is the package.json version', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'),
  )
  expect(packageVersion()).toBe(pkg.version)
})

test('settings.json extension config overrides the environment defaults key by key', () => {
  const config = extensionConfigFromEnv(
    {
      TAVILY_API_KEY: 'env-tavily',
      SERPER_API_KEY: 'env-serper',
      EMBEDDING_MODEL: 'm',
    },
    {
      web: { tavilyKey: 'file' },
      rag: { embedding: { apiKey: 'k' } },
      mine: { a: 1 },
    },
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
  expect(hint).toContain('.sessions, knowledge.db')
  const sessions = `'${join(dataDir, 'sessions')}'`
  expect(hint).toContain(
    `mkdir -p ${sessions} && cp -R '${join(dir.path, '.sessions')}'/. ${sessions}/ && rm -r '${join(dir.path, '.sessions')}'`,
  )
  expect(hint).toContain(
    `mv '${join(dir.path, 'knowledge.db')}'* '${join(dataDir, 'rag')}'/`,
  )
  // Still move when dataDir is the project directory (the new layout's subdirectories have no leading dot)
  expect(legacyDataHint(dir.path, dir.path)).toContain('.sessions')
})

test('the migration commands keep old data, win over startup files and can run twice', () => {
  const dir = tempDir()
  dirs.push(dir)
  // Must work with spaces and single quotes in the path
  const cwd = join(dir.path, "my 'proj'")
  const dataDir = join(dir.path, 'home/projects/x')
  mkdirSync(join(cwd, '.sessions/default/tool-results'), { recursive: true })
  writeFileSync(join(cwd, '.sessions/default.jsonl'), 'old session')
  writeFileSync(join(cwd, '.sessions/default/tool-results/a.txt'), 'output')
  mkdirSync(join(cwd, '.memory'))
  writeFileSync(join(cwd, '.memory/MEMORY.md'), '# Memory Index\n- old')
  writeFileSync(join(cwd, 'knowledge.db'), 'db')
  writeFileSync(join(cwd, 'knowledge.db-journal'), 'journal')
  // This startup already created an empty memory index and knowledge base in the new directory
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
      (command) =>
        Bun.spawnSync(['sh', '-c', command], { cwd: dir.path }).exitCode,
    )
  expect(run()).toEqual([0, 0, 0])
  const read = (path: string) => readFileSync(join(dataDir, path), 'utf-8')
  expect(read('sessions/default.jsonl')).toBe('old session')
  expect(read('sessions/default/tool-results/a.txt')).toBe('output')
  expect(read('memory/MEMORY.md')).toBe('# Memory Index\n- old')
  expect(read('rag/knowledge.db')).toBe('db')
  expect(read('rag/knowledge.db-journal')).toBe('journal')
  expect(legacyDataHint(cwd, dataDir)).toBeUndefined()
  // Run again: the old data is gone, the commands fail and the new directory is unchanged
  expect(run().every((code) => code !== 0)).toBe(true)
  expect(read('sessions/default.jsonl')).toBe('old session')
  expect(read('rag/knowledge.db')).toBe('db')
})

test('an extension that throws or rejects while loading is reported and skipped, not fatal', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const file = (name: string, body: string) => {
    const path = join(dir.path, name)
    writeFileSync(path, body)
    return path
  }
  const sync = file(
    'boom.ts',
    "export default () => { throw new Error('sync boom') }",
  )
  const async = file(
    'later.ts',
    "export default async () => { throw new Error('async boom') }",
  )
  const good = file(
    'good.ts',
    "export default (vela) => { vela.registerCommand('hi', { description: 'hi', handler: async () => {} }) }",
  )
  const errors: string[] = []
  const config = loadConfig({ cwd: dir.path, agentDir: join(dir.path, 'home') })
  const extensions = await loadCliExtensions(
    config,
    parseArgs(['-e', sync, '-e', async, '-e', good]),
    (message) => errors.push(message),
  )
  expect(extensions.map((extension) => extension.name)).toEqual([
    'boom',
    'later',
    'good',
  ])
  const vela = createVela({
    model: createFauxModel({ responses: [fauxText('ok')] }),
    extensions,
  })
  try {
    await vela.ready()
    await vela.session().prompt('hello')
    expect(errors).toEqual([
      `[extensions] Failed to load ${sync}: sync boom`,
      `[extensions] Failed to load ${async}: async boom`,
    ])
  } finally {
    await vela.dispose()
  }
})

test('the removed supabase built-in is unknown, so an old -builtin:supabase fails loudly', () => {
  expect(Object.keys(BUILTIN_EXTENSIONS)).toEqual([
    'memory',
    'rag',
    'web',
    'feishu',
  ])
  expect(extensionConfigFromEnv({ SUPABASE_URL: 'u' }, {})).not.toHaveProperty(
    'supabase',
  )
  const dir = tempDir()
  dirs.push(dir)
  mkdirSync(join(dir.path, 'home'), { recursive: true })
  writeFileSync(
    join(dir.path, 'home/settings.json'),
    JSON.stringify({ extensions: ['-builtin:supabase'] }),
  )
  expect(() =>
    loadConfig({
      cwd: dir.path,
      agentDir: join(dir.path, 'home'),
      builtins: Object.keys(BUILTIN_EXTENSIONS),
    }),
  ).toThrow('Unknown built-in extension builtin:supabase')
})
