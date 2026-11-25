import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import {
  BUILTIN_EXTENSIONS,
  extensionConfigFromEnv,
  formatModelList,
  HELP,
  loadCliExtensions,
  packageVersion,
  parseArgs,
  resolveTrust,
  selectTools,
} from '../../../src/cli/setup.ts'
import { loadConfig } from '../../../src/load-config.ts'
import { createFauxModel, fauxText } from '../../../src/testing/core/index.ts'
import { createVela } from '../../../src/vela.ts'

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
    serve: false,
    print: true,
    messages: ['hi'],
    continue: true,
    resume: false,
    extensions: ['a.ts', 'builtin:web'],
    noExtensions: true,
    noSession: true,
    approve: true,
    appendSystemPrompt: [],
    systemPrompt: [],
    noContextFiles: false,
    noTools: false,
    excludeTools: [],
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
  expect(
    parseArgs(['--system-prompt', 'a', '--system-prompt', 'system.md']),
  ).toMatchObject({ systemPrompt: ['a', 'system.md'] })
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
    'Use only one of -c, -r, --session and --fork',
  )
  expect(() => parseArgs(['--model'])).toThrow('--model requires a value')
  expect(() => parseArgs(['--wat'])).toThrow('Unknown option --wat')
  // A bad session id is a usage error at parse time, not a stack trace from deep inside session startup
  expect(() => parseArgs(['--session', '.bad'])).toThrow(
    'Invalid session id ".bad"',
  )
  // `serve` is a subcommand only as the first argument; later it stays a prompt
  expect(parseArgs(['serve', '--model', 'mock'])).toMatchObject({
    serve: true,
    model: 'mock',
    messages: [],
  })
  expect(parseArgs(['mock', 'serve'])).toMatchObject({
    serve: false,
    messages: ['mock', 'serve'],
  })
  for (const args of [
    ['serve', '-p'],
    ['serve', '--mode', 'json'],
    ['serve', '--export', 'x'],
    ['serve', '--list-models'],
    ['serve', '-c'],
    ['serve', '--fork', 'x'],
    ['serve', '--tools', 'read'],
    ['serve', 'hi'],
  ])
    expect(() => parseArgs(args)).toThrow('vela serve runs channels only')
})

test('the untrusted-project notice names the real vela.db under VELA_DIR', async () => {
  const home = tempDir()
  const project = tempDir()
  dirs.push(home, project)
  mkdirSync(join(project.path, '.vela'), { recursive: true })
  writeFileSync(join(project.path, '.vela', 'config.json'), '{}')
  const result = await resolveTrust({
    cwd: project.path,
    agentDir: home.path,
    interactive: false,
  })
  expect(result.trusted).toBe(false)
  expect(result.warning).toContain(
    `update trusted_paths in ${join(home.path, 'vela.db')} to change this`,
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

test('USAGE lists every flag, the modes, examples and built-in provider keys', () => {
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
  for (const key of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
  ])
    expect(HELP).toContain(key)
  expect(HELP).toContain(
    'providers: built-in anthropic / openai / openrouter / deepseek',
  )
})

test('packageVersion() is the package.json version', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../../../package.json'), 'utf8'),
  )
  expect(packageVersion()).toBe(pkg.version)
})

test('config.json extension config overrides the environment defaults key by key', () => {
  const config = extensionConfigFromEnv(
    {
      TAVILY_API_KEY: 'env-tavily',
      SERPER_API_KEY: 'env-serper',
    },
    {
      web: { tavilyKey: 'file' },
      mine: { a: 1 },
    },
  )
  expect(config.web).toEqual({ tavilyKey: 'file', serperKey: 'env-serper' })
  expect(config.mine).toEqual({ a: 1 })
})

test('legacy -builtin:rag opt-out is accepted while positive builtin:rag fails loudly', () => {
  const dir = tempDir()
  dirs.push(dir)
  writeFileSync(
    join(dir.path, 'config.json'),
    JSON.stringify({ extensions: ['-builtin:rag'] }),
  )
  const ok = loadConfig({
    cwd: dir.path,
    agentDir: dir.path,
    builtins: Object.keys(BUILTIN_EXTENSIONS),
  })
  expect(ok.extensions.map((e) => e.name)).not.toContain('rag')

  writeFileSync(
    join(dir.path, 'config.json'),
    JSON.stringify({ extensions: ['builtin:rag'] }),
  )
  expect(() =>
    loadConfig({
      cwd: dir.path,
      agentDir: dir.path,
      builtins: Object.keys(BUILTIN_EXTENSIONS),
    }),
  ).toThrow('Unknown built-in extension builtin:rag')
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

test('the removed supabase built-in is unknown, so an old -builtin:supabase fails loudly', async () => {
  expect(Object.keys(BUILTIN_EXTENSIONS)).toEqual([
    'background',
    'memory',
    'web',
    'lark',
    'mcp',
    'todo',
  ])
  for (const [name, factory] of Object.entries(BUILTIN_EXTENSIONS))
    expect(factory({}).name).toBe(name)
  const bundled = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/cli/main.ts')],
    target: 'bun',
  })
  expect(bundled.success).toBe(true)
  const text = await bundled.outputs[0]!.text()
  for (const name of [...Object.keys(BUILTIN_EXTENSIONS), 'local'])
    expect(text).toContain(
      `Object.defineProperty(extension, "name", { value: "${name}" })`,
    )
  expect(extensionConfigFromEnv({ SUPABASE_URL: 'u' }, {})).not.toHaveProperty(
    'supabase',
  )
  const dir = tempDir()
  dirs.push(dir)
  mkdirSync(join(dir.path, 'home'), { recursive: true })
  writeFileSync(
    join(dir.path, 'home/config.json'),
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

test('parseArgs reads --fork and --export, and --fork excludes -c / -r / --session', () => {
  expect(parseArgs(['--fork', 'work'])).toMatchObject({ fork: 'work' })
  expect(parseArgs(['--export', 'work', 'out.html'])).toMatchObject({
    export: 'work',
    messages: ['out.html'],
  })
  expect(() => parseArgs(['--fork', 'a', '-c'])).toThrow(
    'Use only one of -c, -r, --session and --fork',
  )
  expect(() => parseArgs(['--fork', '../x'])).toThrow('Invalid session id')
})

test('--tools / --no-tools / --exclude-tools pick tools by name or * pattern (like pi)', () => {
  const args = parseArgs([
    '-t',
    'read, grep',
    '--tools',
    'ed*',
    '-xt',
    'grep',
    '--list-models',
    'son',
  ])
  expect(args).toMatchObject({
    tools: ['read', 'grep', 'ed*'],
    excludeTools: ['grep'],
    listModels: 'son',
    messages: [],
  })
  expect(parseArgs(['--list-models', '-p']).listModels).toBe(true)
  expect(parseArgs(['-nt']).noTools).toBe(true)

  const all = ['read', 'write', 'edit', 'bash', 'grep', 'web_search']
  expect(selectTools(all, args)).toEqual({
    selection: ['read', 'edit'],
  })
  expect(
    selectTools(all, { noTools: false, excludeTools: ['bash', 'web_*'] }),
  ).toEqual({ modifiers: ['-bash', '-web_search'] })
  expect(selectTools(all, { noTools: true, excludeTools: [] })).toEqual({
    selection: [],
  })
  expect(selectTools(all, { noTools: false, excludeTools: [] })).toBeUndefined()
  // A typo fails loudly instead of leaving a tool on or off
  expect(() =>
    selectTools(all, {
      tools: ['missing_tool'],
      noTools: false,
      excludeTools: ['nope*'],
    }),
  ).toThrow('Unknown tools: missing_tool, nope*. Available: read')
})

test('a tools list that names the removed background_start fails at startup', () => {
  const all = ['bash', 'background_output', 'background_stop']
  expect(() =>
    selectTools(all, {
      tools: ['+background_start'],
      noTools: false,
      excludeTools: [],
    }),
  ).toThrow('Unknown tool: background_start')
})

test('+name / -name adjust the default set and defaultTools applies like pi', () => {
  const all = ['read', 'write', 'edit', 'bash', 'grep']
  const settings = ['+grep']
  expect(
    selectTools(all, { noTools: false, excludeTools: [] }, settings),
  ).toEqual({ modifiers: ['+grep'] })
  expect(
    selectTools(
      all,
      { tools: ['-bash'], noTools: false, excludeTools: [] },
      settings,
    ),
  ).toEqual({ modifiers: ['+grep', '-bash'] })
  expect(
    selectTools(all, {
      tools: ['+grep'],
      noTools: false,
      excludeTools: ['wr*'],
    }),
  ).toEqual({ modifiers: ['+grep', '-write'] })
  // A plain --tools list replaces the setting; modifiers adjust a plain setting
  expect(
    selectTools(
      all,
      { tools: ['read'], noTools: false, excludeTools: [] },
      settings,
    ),
  ).toEqual({ selection: ['read'] })
  expect(
    selectTools(all, { tools: ['+grep'], noTools: false, excludeTools: [] }, [
      'read',
      'bash',
    ]),
  ).toEqual({ selection: ['read', 'bash', 'grep'] })
  // defaultTools may use * patterns; the session gets the tools they match
  expect(
    selectTools(all, { noTools: false, excludeTools: [] }, ['re*']),
  ).toEqual({ selection: ['read'] })
  expect(
    selectTools(all, { tools: ['+bash'], noTools: false, excludeTools: [] }, [
      'ed*',
    ]),
  ).toEqual({ selection: ['edit', 'bash'] })
  // A project-level -name removes a tool the user selected with a pattern (the layers are
  // merged into one list before this, so the modifier comes after the pattern it must remove)
  expect(
    selectTools(all, { noTools: false, excludeTools: [] }, ['re*', '-read']),
  ).toEqual({ selection: [] })
  expect(
    selectTools(all, { noTools: false, excludeTools: [] }, ['*', '-bash']),
  ).toEqual({
    selection: ['read', 'write', 'edit', 'grep'],
  })
  expect(() =>
    selectTools(all, { noTools: false, excludeTools: [] }, ['nope']),
  ).toThrow('Unknown tool: nope')
  expect(() =>
    selectTools(all, {
      tools: ['+grep', 'read'],
      noTools: false,
      excludeTools: [],
    }),
  ).toThrow('tool names cannot be mixed')
  expect(() =>
    selectTools(all, {
      tools: ['+re*'],
      noTools: false,
      excludeTools: [],
    }),
  ).toThrow('exact tool names, not patterns')
})

test('--list-models prints the configured models sorted, with a fuzzy search (like pi)', () => {
  const models = [
    {
      provider: 'openai',
      id: 'gpt-x',
      ref: 'openai/gpt-x',
      contextWindow: 400_000,
      reasoning: true,
    },
    {
      provider: 'anthropic',
      id: 'sonnet',
      ref: 'anthropic/sonnet',
      contextWindow: 1_000_000,
      reasoning: false,
    },
    { provider: 'anthropic', id: 'haiku', ref: 'anthropic/haiku' },
  ]
  expect(formatModelList(models)).toBe(
    [
      'provider   model   context  thinking',
      'anthropic  haiku   -        -',
      'anthropic  sonnet  1M       no',
      'openai     gpt-x   400K     yes',
      '',
    ].join('\n'),
  )
  expect(formatModelList(models, 'sonn')).toContain('sonnet')
  expect(formatModelList(models, 'sonn')).not.toContain('haiku')
  expect(formatModelList(models, 'openai/gpt-x')).toContain('gpt-x')
  expect(formatModelList(models, 'openai/gpt-x')).not.toContain('sonnet')
  expect(
    formatModelList(
      [...models, { provider: 'openai', id: 'gpt-4o', ref: 'openai/gpt-4o' }],
      '4gpt',
    ),
  ).toContain('gpt-4o')
  expect(formatModelList(models, 'zzz')).toBe('No models matching "zzz"\n')
  expect(formatModelList([])).toContain(
    'No models available: sign in with /login',
  )
  expect(formatModelList([])).toContain('DEEPSEEK_API_KEY')
})
