import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import { savedTrust, saveTrust } from '../../../src/config/index.ts'
import { projectDataDir } from '../../../src/driver/config/paths.ts'
import { loadConfig, projectTrustRequired } from '../../../src/load-config.ts'
import { interpolate } from '../../../src/shared/interpolate.ts'

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
  return {
    agentDir,
    cwd,
    root: root.path,
    homeDir: join(root.path, 'userhome'),
  }
}

const json = (value: unknown) => JSON.stringify(value)

test('channel receiver config reuses config interpolation and ignores project webhooks override', () => {
  const options = setup({
    'home/config.json': json({
      webhooks: {
        port: 8787,
        github: {
          secret: '$WEBHOOK_FIXTURE_SECRET',
          repositories: ['owner/repo'],
        },
      },
    }),
    'project/.vela/config.json': json({
      webhooks: { port: 9999 },
    }),
  })
  expect(
    loadConfig({ ...options, env: { WEBHOOK_FIXTURE_SECRET: 'fixture' } })
      .extensionConfig.channel,
  ).toEqual({
    eventReceiver: {
      port: 8787,
      github: { secret: 'fixture', repositories: ['owner/repo'] },
    },
  })
  expect(
    loadConfig({
      ...options,
      trusted: true,
      env: { WEBHOOK_FIXTURE_SECRET: 'fixture' },
    }).extensionConfig.channel?.eventReceiver,
  ).toMatchObject({ port: 8787 })
})

test('event default target stays in top-level config and validates an explicit existing-chat address', () => {
  const target = { channel: 'lark', chatId: 'oc_group' }
  expect(
    loadConfig(
      setup({ 'home/config.json': json({ eventDefaultTarget: target }) }),
    ).settings.eventDefaultTarget,
  ).toEqual(target)
  expect(
    loadConfig(
      setup({
        'home/config.json': json({
          eventDefaultTarget: { channel: ' lark ', chatId: ' oc_group ' },
        }),
      }),
    ).settings.eventDefaultTarget,
  ).toEqual(target)
  for (const eventDefaultTarget of [
    'oc_group',
    { channel: 'lark' },
    { ...target, sessionId: 'other' },
  ]) {
    expect(() =>
      loadConfig(setup({ 'home/config.json': json({ eventDefaultTarget }) })),
    ).toThrow(/eventDefaultTarget/)
  }
})

test('project settings override user settings: objects merge deeply, resource lists concatenate', () => {
  const { agentDir, cwd } = setup({
    'home/config.json': json({
      limits: { maxRetries: 5, retryBaseMs: 1000 },
      extensions: ['ext/a.ts'],
      web: { tavilyKey: 'user', serperKey: 's' },
    }),
    'home/ext/a.ts': 'export default () => {}',
    'project/.vela/config.json': json({
      limits: { maxRetries: 9 },
      extensions: ['../b.ts'],
      web: { tavilyKey: 'project' },
    }),
    'project/b.ts': 'export default () => {}',
  })
  const config = loadConfig({ cwd, agentDir, trusted: true })
  expect(config.settings.limits).toEqual({ maxRetries: 9, retryBaseMs: 1000 })
  expect(config.extensionConfig.web).toEqual({
    tavilyKey: 'project',
    serperKey: 's',
  })
  // Paths are relative to the config file they appear in
  expect(config.extensions).toEqual([
    { name: 'a', path: join(agentDir, 'ext/a.ts') },
    { name: 'b', path: join(cwd, 'b.ts') },
  ])
  expect(config.files).toEqual([
    join(agentDir, 'config.json'),
    join(cwd, '.vela/config.json'),
  ])
})

test('tools: project plain names replace the user list, +name / -name entries append to it', () => {
  const appended = setup({
    'home/config.json': json({ tools: ['read', 'bash'] }),
    'project/.vela/config.json': json({ tools: ['-bash', '+grep'] }),
  })
  expect(loadConfig({ ...appended, trusted: true }).settings.tools).toEqual([
    'read',
    'bash',
    '-bash',
    '+grep',
  ])
  const replaced = setup({
    'home/config.json': json({ tools: ['+grep'] }),
    'project/.vela/config.json': json({ tools: ['read'] }),
  })
  expect(loadConfig({ ...replaced, trusted: true }).settings.tools).toEqual([
    'read',
  ])
  // An empty project list turns the user's tools off; it does not append nothing
  const emptied = setup({
    'home/config.json': json({ tools: ['read'] }),
    'project/.vela/config.json': json({ tools: [] }),
  })
  expect(loadConfig({ ...emptied, trusted: true }).settings.tools).toEqual([])
  const bad = setup({ 'home/config.json': json({ tools: '+grep' }) })
  expect(() => loadConfig(bad)).toThrow('tools must be an array of strings')
  const pattern = setup({
    'home/config.json': json({ tools: ['-ba*'] }),
  })
  expect(() => loadConfig(pattern)).toThrow(
    '+name and -name entries take exact tool names, not patterns: -ba*',
  )
})

test('an untrusted project only gets the user settings and user extensions', () => {
  const { agentDir, cwd } = setup({
    'home/extensions/mine.ts': 'export default () => {}',
    'project/.vela/config.json': json({ limits: { maxRetries: 1 } }),
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
    'home/config.json': json({ extensions: ['pkg'] }),
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
    'home/config.json': json({
      extensions: ['-builtin:web', '-builtin:rag'],
    }),
    'project/.vela/config.json': json({ extensions: ['+builtin:web'] }),
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

test('defaultOffBuiltins stays off until +builtin: enables it', () => {
  const builtins = ['memory', 'optional']
  const off = setup({})
  expect(
    loadConfig({
      cwd: off.cwd,
      agentDir: off.agentDir,
      builtins,
      defaultOffBuiltins: ['optional'],
    }).extensions.map((e) => e.name),
  ).toEqual(['memory'])

  const on = setup({
    'home/config.json': json({ extensions: ['+builtin:optional'] }),
  })
  expect(
    loadConfig({
      cwd: on.cwd,
      agentDir: on.agentDir,
      builtins,
      defaultOffBuiltins: ['optional'],
    }).extensions.map((e) => e.name),
  ).toEqual(['memory', 'optional'])
})

test('mistakes in config.json are reported with the file name and strict schema rejects unknown or nested built-in keys', () => {
  const broken = setup({ 'home/config.json': '{ nope' })
  expect(() => loadConfig(broken)).toThrow(
    `${join(broken.agentDir, 'config.json')} is not valid JSON`,
  )
  const badList = setup({ 'home/config.json': json({ extensions: 'a.ts' }) })
  expect(() => loadConfig(badList)).toThrow(
    'extensions must be an array of strings',
  )
  const missing = setup({
    'home/config.json': json({ extensions: ['nope.ts'] }),
  })
  expect(() => loadConfig(missing)).toThrow('Extension path does not exist')
  const unknown = setup({
    'home/config.json': json({ extensions: ['-builtin:nope'] }),
  })
  expect(() => loadConfig({ ...unknown, builtins: ['memory'] })).toThrow(
    'Unknown built-in extension builtin:nope',
  )
  const badModel = setup({
    'home/config.json': json({ model: 'gpt' }),
  })
  expect(() => loadConfig(badModel)).toThrow('model must be "provider/id"')
  const badThinking = setup({
    'home/config.json': json({ thinkingLevel: 'huge' }),
  })
  expect(() => loadConfig(badThinking)).toThrow('thinkingLevel must be one of')
  const badModels = setup({
    'home/config.json': json({ providers: { x: { api: 'grpc' } } }),
  })
  expect(() => loadConfig(badModels)).toThrow('providers.x.api must be one of')
  for (const key of [
    'unknownTopLevel',
    'bashForegroundTimeoutSeconds',
    'bashForegroundTimeoutMaxSeconds',
  ]) {
    const unknownKey = setup({
      'home/config.json': json({ [key]: 123 }),
    })
    expect(() => loadConfig(unknownKey)).toThrow(`unknown key "${key}"`)
  }
  for (const reserved of ['lark', 'web', 'mcp', 'memory', 'channel', 'local']) {
    const nestedBuiltin = setup({
      'home/config.json': json({ extensionConfig: { [reserved]: {} } }),
    })
    expect(() => loadConfig(nestedBuiltin)).toThrow(
      `extensionConfig.${reserved} is a built-in section; move it to top-level`,
    )
  }
  for (const reservedNoSection of ['background', 'todo']) {
    const nestedNoSection = setup({
      'home/config.json': json({
        extensionConfig: { [reservedNoSection]: {} },
      }),
    })
    expect(() => loadConfig(nestedNoSection)).toThrow(
      `extensionConfig.${reservedNoSection} is a built-in extension with no config section; remove it from extensionConfig`,
    )
  }
})

// biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} names the interpolation syntax under test
test('config section strings interpolate $VAR and ${VAR}; $$ is a literal dollar', () => {
  const { agentDir, cwd } = setup({
    'home/config.json': json({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${OWNER} is interpolation syntax in this fixture
      lark: { appSecret: '$SECRET', owners: ['${OWNER}', 'x'] },
      extensionConfig: {
        price: { text: 'costs $$5, $MISSING!' },
      },
    }),
  })
  const config = loadConfig({
    cwd,
    agentDir,
    env: { SECRET: 's3', OWNER: 'ou_1' },
  })
  expect(config.extensionConfig.lark).toEqual({
    appSecret: 's3',
    owners: ['ou_1', 'x'],
  })
  expect(config.extensionConfig.price).toEqual({ text: 'costs $5, !' })
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${A} is interpolation syntax in the input under test
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
    'home/config.json': json({ dataDir: 'data' }),
  })
  expect(loadConfig(custom).dataDir).toBe(join(custom.cwd, 'data'))
})

test('skill directories, first wins: project (.vela/skills, .agents/skills up the tree, .skills), settings, user', () => {
  const { agentDir, cwd, homeDir, root } = setup({
    'home/config.json': json({
      skills: ['shared'],
      prompts: ['more-prompts'],
    }),
  })
  const config = loadConfig({ cwd, agentDir, homeDir, trusted: true })
  // .agents/skills is searched in cwd and each parent (to the git root, here the filesystem root)
  const agentsDirs = config.skillDirs.filter((dir) =>
    dir.endsWith(join('.agents', 'skills')),
  )
  expect(agentsDirs.slice(0, 2)).toEqual([
    join(cwd, '.agents/skills'),
    join(root, '.agents/skills'),
  ])
  expect(
    config.skillDirs.filter(
      (dir) => !agentsDirs.includes(dir) || dir.startsWith(homeDir),
    ),
  ).toEqual([
    join(cwd, '.vela/skills'),
    join(cwd, '.skills'),
    join(agentDir, 'shared'),
    join(agentDir, 'skills'),
    join(homeDir, '.agents/skills'),
  ])
  expect(config.promptDirs).toEqual([
    join(cwd, '.vela/prompts'),
    join(agentDir, 'more-prompts'),
    join(agentDir, 'prompts'),
  ])
})

test('.agents/skills stops at the git repository root', () => {
  const { agentDir, cwd, homeDir } = setup({
    'project/.git/HEAD': '',
    'project/sub/x': '',
  })
  const config = loadConfig({
    cwd: join(cwd, 'sub'),
    agentDir,
    homeDir,
    trusted: true,
  })
  expect(
    config.skillDirs.filter((dir) => dir.endsWith(join('.agents', 'skills'))),
  ).toEqual([
    join(cwd, 'sub/.agents/skills'),
    join(cwd, '.agents/skills'),
    join(homeDir, '.agents/skills'),
  ])
})

test('project skills and prompts need trust, like project settings and extensions', () => {
  for (const dir of [
    'project/.skills/deploy/SKILL.md',
    'project/.vela/skills/deploy/SKILL.md',
    'project/.agents/skills/deploy/SKILL.md',
    'project/.vela/prompts/fix.md',
    'project/.vela/APPEND_SYSTEM.md',
  ]) {
    const { agentDir, cwd, homeDir } = setup({
      'home/config.json': json({ skills: ['shared'] }),
      [dir]: 'Run the deploy',
    })
    expect(projectTrustRequired(cwd, agentDir, homeDir)).toBe(true)
    const config = loadConfig({ cwd, agentDir, homeDir })
    expect(config.skillDirs).toEqual([
      join(agentDir, 'shared'),
      join(agentDir, 'skills'),
      join(homeDir, '.agents/skills'),
    ])
    expect(config.promptDirs).toEqual([join(agentDir, 'prompts')])
    expect(config.appendSystemPrompt).toBeUndefined()
  }
  const { agentDir, cwd, homeDir } = setup({ 'project/AGENTS.md': 'Use bun' })
  // AGENTS.md doesn't need trust (like pi) and loads untrusted
  expect(projectTrustRequired(cwd, agentDir, homeDir)).toBe(false)
  expect(loadConfig({ cwd, agentDir, homeDir }).contextFiles.at(-1)).toEqual({
    path: join(cwd, 'AGENTS.md'),
    content: 'Use bun',
  })
})

test("~/.agents/skills is the user's, so it never asks for trust when running from home", () => {
  const { root } = setup({ 'userhome/.agents/skills/x/SKILL.md': '' })
  const homeDir = join(root, 'userhome')
  expect(projectTrustRequired(homeDir, join(root, 'home'), homeDir)).toBe(false)
})

test('APPEND_SYSTEM.md: the trusted project file wins over the user one', () => {
  const { agentDir, cwd, homeDir } = setup({
    'home/APPEND_SYSTEM.md': 'user addendum',
    'project/.vela/APPEND_SYSTEM.md': 'project addendum',
  })
  expect(
    loadConfig({ cwd, agentDir, homeDir, trusted: true }).appendSystemPrompt,
  ).toBe('project addendum')
  expect(loadConfig({ cwd, agentDir, homeDir }).appendSystemPrompt).toBe(
    'user addendum',
  )
})

test('the user AGENTS.md comes first in contextFiles', () => {
  const { agentDir, cwd, homeDir } = setup({
    'home/AGENTS.md': 'user',
    'project/CLAUDE.md': 'project',
  })
  const files = loadConfig({ cwd, agentDir, homeDir }).contextFiles
  expect(files[0]!.content).toBe('user')
  expect(files.at(-1)!.content).toBe('project')
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
    'home/.vela/config.json': json({ extensions: ['x.ts'] }),
    'home/.vela/x.ts': '',
    'home/.vela/extensions/y.ts': '',
  })
  const home = join(root, 'home')
  const agentDir = join(home, '.vela')
  expect(projectTrustRequired(home, agentDir)).toBe(false)
  const config = loadConfig({
    cwd: home,
    agentDir,
    homeDir: home,
    trusted: true,
  })
  expect(config.files).toEqual([join(agentDir, 'config.json')])
  expect(config.extensions.map((e) => e.name)).toEqual(['y', 'x'])
  expect(config.skillDirs).toEqual([
    join(home, '.skills'),
    join(agentDir, 'skills'),
    join(home, '.agents/skills'),
  ])
})

test('compatibility config only supplies explicitly passed environment to MCP', () => {
  const options = setup({
    'home/config.json': JSON.stringify({
      mcpServers: { local: { command: '$VELA_MCP_CONFIG_FIXTURE' } },
    }),
  })
  const previous = process.env.VELA_MCP_CONFIG_FIXTURE
  process.env.VELA_MCP_CONFIG_FIXTURE = 'fixture-command'
  try {
    const config = loadConfig(options)
    expect(config.mcp.errors).toHaveLength(1)
    expect(config.mcp.errors[0]).toContain('VELA_MCP_CONFIG_FIXTURE')
    expect(config.mcp.servers.local).toBeUndefined()
    const explicit = loadConfig({
      ...options,
      env: { VELA_MCP_CONFIG_FIXTURE: 'fixture-command' },
    })
    expect(explicit.mcp.errors).toEqual([])
    expect(explicit.mcp.servers.local).toMatchObject({
      command: 'fixture-command',
    })
  } finally {
    if (previous === undefined) delete process.env.VELA_MCP_CONFIG_FIXTURE
    else process.env.VELA_MCP_CONFIG_FIXTURE = previous
  }
})

test('user extension settings preserve provenance and strip privileged keys from project config', () => {
  const options = setup({
    'home/config.json': json({
      local: { enabled: true, token: '$LOCAL_TOKEN', port: 8788 },
      web: { tavilyKey: '$LOCAL_TOKEN', serperKey: 'user' },
    }),
    'project/.vela/config.json': json({
      local: { enabled: false, token: 'project-secret', port: 9999 },
      web: { tavilyKey: 'project-key' },
    }),
  })
  const config = loadConfig({
    ...options,
    trusted: true,
    env: { LOCAL_TOKEN: 'user-secret' },
  })
  expect(config.userExtensionConfig.local).toEqual({
    enabled: true,
    token: 'user-secret',
    port: 8788,
  })
  // Host-owned `local` in project config is stripped, while non-privileged `web` merges.
  expect(config.extensionConfig.local).toEqual({
    enabled: true,
    token: 'user-secret',
    port: 8788,
  })
  expect(config.userExtensionConfig.web).toEqual({
    tavilyKey: 'user-secret',
    serperKey: 'user',
  })
  expect(config.extensionConfig.web).toEqual({
    tavilyKey: 'project-key',
    serperKey: 'user',
  })
})
