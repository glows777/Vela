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
} from '../../../src/config'
import { tempDir } from '../../support/vela'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/** 一个临时的用户级目录和项目目录 */
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
      limits: { maxTurns: 5, bashTimeoutMs: 1000 },
      extensions: ['ext/a.ts'],
      extensionConfig: { web: { tavilyKey: 'user', serperKey: 's' } },
    }),
    'home/ext/a.ts': 'export default () => {}',
    'project/.vela/settings.json': json({
      limits: { maxTurns: 9 },
      extensions: ['../b.ts'],
      extensionConfig: { web: { tavilyKey: 'project' } },
    }),
    'project/b.ts': 'export default () => {}',
  })
  const config = loadConfig({ cwd, agentDir, trusted: true })
  expect(config.settings.limits).toEqual({ maxTurns: 9, bashTimeoutMs: 1000 })
  expect(config.extensionConfig.web).toEqual({
    tavilyKey: 'project',
    serperKey: 's',
  })
  // 路径相对所在的 settings 文件
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
    'project/.vela/settings.json': json({ limits: { maxTurns: 1 } }),
    'project/.vela/extensions/evil.ts': 'export default () => {}',
  })
  expect(projectTrustRequired(cwd)).toBe(true)
  const config = loadConfig({ cwd, agentDir })
  expect(config.settings).toEqual({})
  expect(config.extensions.map((e) => e.name)).toEqual(['mine'])
  const trusted = loadConfig({ cwd, agentDir, trusted: true })
  expect(trusted.extensions.map((e) => e.name)).toEqual(['mine', 'evil'])
  expect(trusted.settings.limits).toEqual({ maxTurns: 1 })
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
    'home/settings.json': json({ extensions: ['-builtin:web', '-builtin:rag'] }),
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
    `${join(broken.agentDir, 'settings.json')} 不是合法的 JSON`,
  )
  const badList = setup({ 'home/settings.json': json({ extensions: 'a.ts' }) })
  expect(() => loadConfig(badList)).toThrow('extensions 应该是字符串数组')
  const missing = setup({ 'home/settings.json': json({ extensions: ['nope.ts'] }) })
  expect(() => loadConfig(missing)).toThrow('扩展路径不存在')
  const unknown = setup({
    'home/settings.json': json({ extensions: ['-builtin:nope'] }),
  })
  expect(() => loadConfig({ ...unknown, builtins: ['memory'] })).toThrow(
    '未知的内置扩展 builtin:nope',
  )
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
  expect(projectDataDir('/h/.vela', '/home/liam/code/x')).toBe(
    '/h/.vela/projects/--home-liam-code-x--',
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
  expect(loadConfig({ cwd, agentDir }).skillDirs).toEqual([
    join(cwd, '.skills'),
    join(agentDir, 'skills'),
    join(agentDir, 'shared'),
    join(cwd, '.vela/skills'),
  ])
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
  expect(config.skillDirs).toEqual([join(home, '.skills'), join(agentDir, 'skills')])
})
