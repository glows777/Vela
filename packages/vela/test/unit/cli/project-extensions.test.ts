import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '@glows777/vela-core/testing'
import {
  cliHostExtensionConfig,
  cliProjectExtensions,
} from '../../../src/cli/project-extensions.ts'
import { loadCliExtensions, parseArgs } from '../../../src/cli/setup.ts'
import { loadConfig } from '../../../src/config/index.ts'

const dirs: ReturnType<typeof tempDir>[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})
function fixture() {
  const dir = tempDir()
  dirs.push(dir)
  const agentDir = join(dir.path, 'user'),
    a = join(dir.path, 'A'),
    b = join(dir.path, 'B')
  for (const root of [agentDir, join(a, '.vela'), join(b, '.vela')])
    mkdirSync(root, { recursive: true })
  const write = (root: string, file: string, value: unknown) =>
    writeFileSync(join(root, file), JSON.stringify(value))
  write(agentDir, 'mcp.json', {
    mcpServers: { shared: { command: 'user-server' } },
  })
  write(join(a, '.vela'), 'mcp.json', {
    mcpServers: { project: { command: 'a-server' } },
  })
  write(join(b, '.vela'), 'mcp.json', {
    mcpServers: {
      project: { command: 'b-server' },
      shared: { enabled: false },
    },
  })
  write(agentDir, 'settings.json', {
    extensionConfig: { custom: { marker: 'user' } },
  })
  write(join(a, '.vela'), 'settings.json', {
    extensionConfig: { custom: { marker: 'A' } },
  })
  const config = loadConfig({
    cwd: a,
    agentDir,
    trusted: true,
    builtins: ['mcp', 'memory'],
    env: {},
  })
  const input = {
    cwd: b,
    environmentId: 'node:local',
    trusted: true,
    settings: {},
    projectSettings: {},
    entries: [],
  }
  return { config, input, a, b, agentDir, write }
}

test('MCP snapshot follows B, merges user overrides and changes key without mutating old snapshot', async () => {
  const t = fixture(),
    load = cliProjectExtensions(t.config, parseArgs([]))
  const first = await load(t.input)
  expect(first.extensionConfig.mcp!.mcpServers).toEqual({
    shared: { command: 'user-server', enabled: false },
    project: { command: 'b-server' },
  })
  expect((await first.load()).map((factory) => factory.name)).toEqual([
    'mcp',
    'memory',
  ])
  t.write(join(t.b, '.vela'), 'mcp.json', {
    mcpServers: { project: { command: 'new-b-server' } },
  })
  const second = await load(t.input)
  expect(second.key).not.toBe(first.key)
  expect(JSON.stringify(first.extensionConfig)).not.toContain('new-b-server')
})

test('denied B reads user MCP only; no-extensions skips all project work', async () => {
  const t = fixture()
  const denied = await cliProjectExtensions(
    t.config,
    parseArgs([]),
  )({ ...t.input, trusted: false })
  expect(denied.extensionConfig.mcp!.mcpServers).toEqual({
    shared: { command: 'user-server' },
  })
  const off = await cliProjectExtensions(
    t.config,
    parseArgs(['--no-extensions']),
  )({ ...t.input, environmentId: 'remote' })
  expect(await off.load()).toEqual([])
})

test('host factories exclude config-driven session builtins; explicit MCP remains host-owned', async () => {
  const t = fixture(),
    errors: string[] = []
  expect(
    await loadCliExtensions(
      t.config,
      parseArgs([]),
      (e) => errors.push(e),
      true,
    ),
  ).toEqual([])
  const args = parseArgs(['-e', 'builtin:mcp'])
  const host = await loadCliExtensions(
    t.config,
    args,
    (e) => errors.push(e),
    true,
  )
  expect(host.map((factory) => factory.name)).toEqual(['mcp'])
  const scope = await cliProjectExtensions(t.config, args)(t.input)
  expect((await scope.load()).map((factory) => factory.name)).toEqual([
    'memory',
  ])
  expect(cliHostExtensionConfig(t.config, args).custom).toEqual({
    marker: 'user',
  })
  expect(errors).toEqual([])
})

test('project imports stay lazy and non-local configuration never imports host code', async () => {
  const t = fixture()
  const input = {
    ...t.input,
    entries: [{ name: 'missing', path: join(t.b, 'missing.ts') }],
  }
  const snapshot = await cliProjectExtensions(t.config, parseArgs([]))(input)
  await expect(snapshot.load()).rejects.toThrow()
  await expect(
    cliProjectExtensions(
      t.config,
      parseArgs([]),
    )({ ...input, environmentId: 'remote' }),
  ).rejects.toThrow('Skipped project extensions and MCP')
})

test('project overrides of host user singletons are diagnosed without changing host config', async () => {
  const t = fixture()
  t.config.sessionResources!.hostExtensions = [
    { name: 'custom', path: '/user/custom.ts' },
  ]
  const diagnostics: string[] = []
  await cliProjectExtensions(t.config, parseArgs([]), (message) =>
    diagnostics.push(message),
  )({
    ...t.input,
    projectSettings: { extensionConfig: { custom: { marker: 'B' } } },
    settings: { extensionConfig: { custom: { marker: 'B' } } },
  })
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]).toContain(
    'project configuration for host extension "custom" is ignored',
  )
  expect(cliHostExtensionConfig(t.config, parseArgs([])).custom).toEqual({
    marker: 'user',
  })
})

test('host listener activation is frozen from startup project selection, including plus and minus overrides', async () => {
  const t = fixture()
  const errors: string[] = []
  t.write(join(t.a, '.vela'), 'settings.json', {
    extensions: ['-builtin:lark'],
  })
  const disabled = loadConfig({
    cwd: t.a,
    agentDir: t.agentDir,
    trusted: true,
    builtins: ['lark'],
  })
  expect(
    await loadCliExtensions(
      disabled,
      parseArgs([]),
      (e) => errors.push(e),
      true,
    ),
  ).toEqual([])
  t.write(t.agentDir, 'settings.json', { extensions: ['-builtin:lark'] })
  t.write(join(t.a, '.vela'), 'settings.json', {
    extensions: ['+builtin:lark'],
  })
  const enabled = loadConfig({
    cwd: t.a,
    agentDir: t.agentDir,
    trusted: true,
    builtins: ['lark'],
  })
  expect(
    (
      await loadCliExtensions(
        enabled,
        parseArgs([]),
        (e) => errors.push(e),
        true,
      )
    ).map((factory) => factory.name),
  ).toEqual(['lark'])
  expect(errors).toEqual([])
})
