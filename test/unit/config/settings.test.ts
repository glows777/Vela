import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  interpolate,
  loadConfig,
  projectDataDir,
  projectTrustRequired,
  savedTrust,
  saveTrust,
} from '../../../src/config/index.ts'
import { tempDir } from '../../support/vela.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/** A temporary user-level directory and project directory */
function setup(files: Record<string, string> = {}) {
  const root = tempDir('vela-config-')
  dirs.push(root)
  const agentDir = join(root.path, 'home')
  const cwd = join(root.path, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const full = join(root.path, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return { agentDir, cwd, root: root.path }
}

const json = (value: unknown) => JSON.stringify(value)

test('project settings override user settings: objects merge deeply, resource lists concatenate', () => {
  const { agentDir, cwd } = setup({
    'home/settings.json': json({
      limits: { maxRetries: 5, bashTimeoutMs: 1000 },
      extensions: ['ext/a.ts'],
      extensionConfig: { web: { tavilyKey: 'user', serperKey: 's' } },
    }),
    'home/ext/a.ts': 'export default () => {}',
    'project/.vela/settings.json': json({
      limits: { maxRetries: 9 },
      extensions: ['../b.ts'],
      extensionConfig: { web: { tavilyKey: 'project' } },
    }),
    'project/b.ts': 'export default () => {}',
  })
  const config = loadConfig({ cwd, agentDir, trusted: true })
  expect(config.settings.limits).toEqual({ maxRetries: 9, bashTimeoutMs: 1000 })
  expect(config.extensionConfig.web).toEqual({
    tavilyKey: 'project',
    serperKey: 's',
  })
  // Paths are relative to the settings file they appear in
  expect(config.extensions).toEqual([
    { name: 'a', path: join(agentDir, 'ext/a.ts') },
    { name: 'b', path: join(cwd, 'b.ts') },
  ])
  expect(config.files).toEqual([
    join(agentDir, 'settings.json'),
    join(cwd, '.vela/settings.json'),
  ])
})

test('an untrusted project only gets the user settings and user extensions', () => {
  const { agentDir, cwd } = setup({
    'home/extensions/mine.ts': 'export default () => {}',
    'project/.vela/settings.json': json({ limits: { maxRetries: 1 } }),
    'project/.vela/extensions/evil.ts': 'export default () => {}',
  })
  expect(projectTrustRequired(cwd)).toBe(true)
  const config = loadConfig({ cwd, agentDir })
  expect(config.settings).toEqual({})
  expect(config.extensions.map((e) => e.name)).toEqual(['mine'])
  const trusted = loadConfig({ cwd, agentDir, trusted: true })
  expect(trusted.extensions.map((e) => e.name)).toEqual(['mine', 'evil'])
  expect(trusted.settings.limits).toEqual({ maxRetries: 1 })
})

test('extension directories: files, folders with index.ts, and a folder that is itself an extension', () => {
  const { agentDir, cwd } = setup({
    'home/extensions/b.ts': '',
    'home/extensions/a/index.ts': '',
    'home/extensions/types.d.ts': '',
    'home/extensions/notes.md': '',
    'home/extensions/empty/readme.md': '',
    'home/settings.json': json({ extensions: ['pkg'] }),
    'home/pkg/index.ts': '',
    'home/pkg/helper.ts': '',
  })
  const config = loadConfig({ cwd, agentDir })
  expect(config.extensions).toEqual([
    { name: 'a', path: join(agentDir, 'extensions/a/index.ts') },
    { name: 'b', path: join(agentDir, 'extensions/b.ts') },
    { name: 'pkg', path: join(agentDir, 'pkg/index.ts') },
  ])
})

test('built-in extensions load by default; -builtin: turns one off and a project +builtin: turns it back on', () => {
  const { agentDir, cwd } = setup({
    'home/settings.json': json({
      extensions: ['-builtin:web', '-builtin:rag'],
    }),
    'project/.vela/settings.json': json({ extensions: ['+builtin:web'] }),
  })
  const builtins = ['memory', 'rag', 'web']
  expect(
    loadConfig({ cwd, agentDir, builtins }).extensions.map((e) => e.name),
  ).toEqual(['memory'])
  expect(
    loadConfig({ cwd, agentDir, builtins, trusted: true }).extensions.map(
      (e) => e.name,
    ),
  ).toEqual(['memory', 'web'])
})

test('mistakes in settings are reported with the file name', () => {
  const broken = setup({ 'home/settings.json': '{ nope' })
  expect(() => loadConfig(broken)).toThrow(
    `${join(broken.agentDir, 'settings.json')} is not valid JSON`,
  )
  const badList = setup({ 'home/settings.json': json({ extensions: 'a.ts' }) })
  expect(() => loadConfig(badList)).toThrow(
    'extensions must be an array of strings',
  )
  const missing = setup({
    'home/settings.json': json({ extensions: ['nope.ts'] }),
  })
  expect(() => loadConfig(missing)).toThrow('Extension path does not exist')
  const unknown = setup({
    'home/settings.json': json({ extensions: ['-builtin:nope'] }),
  })
  expect(() => loadConfig({ ...unknown, builtins: ['memory'] })).toThrow(
    'Unknown built-in extension builtin:nope',
  )
  const badModel = setup({
    'home/settings.json': json({ defaultModel: 'gpt' }),
  })
  expect(() => loadConfig(badModel)).toThrow(
    'defaultModel must be "provider/id"',
  )
  const badThinking = setup({
    'home/settings.json': json({ defaultThinkingLevel: 'huge' }),
  })
  expect(() => loadConfig(badThinking)).toThrow(
    'defaultThinkingLevel must be one of',
  )
  const badModels = setup({
    'home/models.json': json({ providers: { x: { api: 'grpc' } } }),
  })
  expect(() => loadConfig(badModels)).toThrow('providers.x.api must be one of')
})

test('extension config strings interpolate $VAR and ${VAR}; $$ is a literal dollar', () => {
  const { agentDir, cwd } = setup({
    'home/settings.json': json({
      extensionConfig: {
        feishu: { appSecret: '$SECRET', owners: ['${OWNER}', 'x'] },
        price: { text: 'costs $$5, $MISSING!' },
      },
    }),
  })
  const config = loadConfig({
    cwd,
    agentDir,
    env: { SECRET: 's3', OWNER: 'ou_1' },
  })
  expect(config.extensionConfig.feishu).toEqual({
    appSecret: 's3',
    owners: ['ou_1', 'x'],
  })
  expect(config.extensionConfig.price).toEqual({ text: 'costs $5, !' })
  expect(interpolate('${A}-$A', { A: '1' })).toBe('1-1')
})

test('the data directory defaults to <agentDir>/projects/<encoded cwd>; settings.dataDir is relative to cwd', () => {
  const { agentDir, cwd } = setup()
  expect(loadConfig({ cwd, agentDir }).dataDir).toBe(
    projectDataDir(agentDir, cwd),
  )
  expect(projectDataDir('/h/.vela', '/home/liam/code/x')).toMatch(
    /^\/h\/\.vela\/projects\/--home-liam-code-x--[0-9a-f]{8}$/,
  )
  // Two paths whose hyphens and separators encode the same must not share a data directory
  expect(projectDataDir('/h', '/work/a-b/c')).not.toBe(
    projectDataDir('/h', '/work/a/b-c'),
  )
  const custom = setup({
    'home/settings.json': json({ dataDir: 'data' }),
  })
  expect(loadConfig(custom).dataDir).toBe(join(custom.cwd, 'data'))
})

test('skill directories: legacy .skills, user, settings, then project', () => {
  const { agentDir, cwd } = setup({
    'home/settings.json': json({ skills: ['shared'] }),
  })
  expect(loadConfig({ cwd, agentDir, trusted: true }).skillDirs).toEqual([
    join(cwd, '.skills'),
    join(agentDir, 'skills'),
    join(agentDir, 'shared'),
    join(cwd, '.vela/skills'),
  ])
})

test('project skills (.skills, .vela/skills) need trust, like project settings and extensions', () => {
  for (const dir of [
    'project/.skills/deploy/SKILL.md',
    'project/.vela/skills/deploy/SKILL.md',
  ]) {
    const { agentDir, cwd } = setup({
      'home/settings.json': json({ skills: ['shared'] }),
      [dir]: 'Run the deploy',
    })
    expect(projectTrustRequired(cwd, agentDir)).toBe(true)
    expect(loadConfig({ cwd, agentDir }).skillDirs).toEqual([
      join(agentDir, 'skills'),
      join(agentDir, 'shared'),
    ])
  }
  const { agentDir, cwd } = setup()
  expect(projectTrustRequired(cwd, agentDir)).toBe(false)
})

test('trust decisions are saved per directory and apply to subdirectories', () => {
  const { agentDir, root } = setup()
  const project = join(root, 'project')
  expect(savedTrust(agentDir, join(project, 'sub'))).toBeUndefined()
  saveTrust(agentDir, project, true)
  expect(savedTrust(agentDir, join(project, 'sub'))).toBe(true)
  saveTrust(agentDir, join(project, 'sub'), false)
  expect(savedTrust(agentDir, join(project, 'sub', 'deeper'))).toBe(false)
  expect(savedTrust(agentDir, project)).toBe(true)
})

test('a broken trust.json fails loudly instead of being overwritten', () => {
  const { agentDir, root } = setup()
  const file = join(agentDir, 'trust.json')
  writeFileSync(file, '{ "/a": true,')
  expect(() => savedTrust(agentDir, root)).toThrow(`${file} is not valid JSON`)
  expect(() => saveTrust(agentDir, root, true)).toThrow(
    `${file} is not valid JSON`,
  )
  writeFileSync(file, '[]')
  expect(() => savedTrust(agentDir, root)).toThrow('must be an object')
})

test('running in the home directory reads ~/.vela once, as user settings, without asking for trust', () => {
  const { root } = setup({
    'home/.vela/settings.json': json({ extensions: ['x.ts'] }),
    'home/.vela/x.ts': '',
    'home/.vela/extensions/y.ts': '',
  })
  const home = join(root, 'home')
  const agentDir = join(home, '.vela')
  expect(projectTrustRequired(home, agentDir)).toBe(false)
  const config = loadConfig({ cwd: home, agentDir, trusted: true })
  expect(config.files).toEqual([join(agentDir, 'settings.json')])
  expect(config.extensions.map((e) => e.name)).toEqual(['y', 'x'])
  expect(config.skillDirs).toEqual([
    join(home, '.skills'),
    join(agentDir, 'skills'),
  ])
})
