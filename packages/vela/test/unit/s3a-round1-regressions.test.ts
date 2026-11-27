import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDockerGuest } from '../../../../scripts/build-docker-guest.ts'
import {
  cliProjectExtensions,
  cliWorkspaceModeAt,
} from '../../../../test/support/legacy-cli-helpers.ts'
import { tempDir } from '../../../../test/support/vela.ts'
import { parseArgs } from '../../src/cli/setup.ts'
import { saveTrust } from '../../src/db/index.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import { loadConfig } from '../../src/driver/index.ts'
import { ProjectConfig } from '../../src/driver/session/project-config.ts'
import { loadWorkspaceInventory } from '../../src/driver/session/workspace.ts'
import { mcpConfig } from '../../src/mcp/config.ts'
import { McpPool } from '../../src/mcp/pool.ts'
import { dockerOperations } from '../../src/runtime/docker/operations.ts'
import { silentLogger } from '../../src/shared/logger.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('cliWorkspaceModeAt scopes --approve to startup local cwd only', () => {
  const dir = tempDir('vela-approve-scope-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const projectA = join(dir.path, 'project-a')
  const projectB = join(dir.path, 'project-b')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectA, { recursive: true })
  mkdirSync(projectB, { recursive: true })
  saveTrust(agentDir, projectB, false)
  saveTrust(agentDir, { environment: 'dev', cwd: '/workspace' }, false)

  expect(
    cliWorkspaceModeAt({
      agentDir,
      startupCwd: projectA,
      approve: true,
      location: projectA,
    }),
  ).toBe('all')
  expect(
    cliWorkspaceModeAt({
      agentDir,
      startupCwd: projectA,
      approve: true,
      location: projectB,
    }),
  ).toBe('none')
  expect(
    cliWorkspaceModeAt({
      agentDir,
      startupCwd: projectA,
      approve: true,
      location: '/workspace',
      environment: 'dev',
    }),
  ).toBe('none')
})

test('trusted non-local ProjectConfig does not interpolate host env secrets', async () => {
  const dir = tempDir('vela-remote-secret-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const remoteRoot = join(dir.path, 'container-ws')
  mkdirSync(join(agentDir), { recursive: true })
  mkdirSync(join(remoteRoot, '.vela'), { recursive: true })
  writeFileSync(
    join(remoteRoot, '.vela/config.json'),
    JSON.stringify({ web: { tavilyKey: '$HOST_SECRET' } }),
  )

  const config = loadConfig({
    cwd: dir.path,
    agentDir,
    env: { HOST_SECRET: 'host-top-secret' },
  })
  const projectConfig = new ProjectConfig(
    {
      ...config.sessionResources!,
      workspaceModeAt: () => 'all',
    },
    join(dir.path, 'data'),
    silentLogger,
  )
  const baseEnv = createLocalExecutionEnv({ cwd: remoteRoot })
  const nonLocalEnv = Object.assign(
    Object.create(Object.getPrototypeOf(baseEnv)),
    baseEnv,
    { id: 'docker:dev' },
  ) as typeof baseEnv
  try {
    const resolved = await projectConfig.get('s1', nonLocalEnv, 'dev')
    expect(
      (resolved.web as { tavilyKey?: string } | undefined)?.tavilyKey,
    ).toBe('')
  } finally {
    await baseEnv.cleanup()
  }
})

test('cliProjectExtensions reuses the shared host McpPool across loads', async () => {
  const dir = tempDir('vela-cli-mcp-pool-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const projDir = join(dir.path, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(projDir, '.vela'), { recursive: true })
  writeFileSync(
    join(projDir, '.vela/config.json'),
    JSON.stringify({
      mcpServers: { docs: { command: 'node', args: ['-e', ''] } },
    }),
  )
  const config = loadConfig({
    cwd: projDir,
    agentDir,
    extensionConfigs: [mcpConfig],
  })
  const pool = new McpPool({ idleTtlMs: 60_000 })
  const originalAcquire = pool.acquire.bind(pool)
  let acquireCount = 0
  pool.acquire = (opts) => {
    acquireCount++
    return originalAcquire(opts)
  }
  const loader = cliProjectExtensions(
    {
      ...config,
      mcp: { servers: {}, sources: {}, errors: [] },
      sessionResources: {
        ...config.sessionResources!,
        extensionBuiltins: { names: ['mcp'], defaultOff: [] },
      },
    },
    parseArgs([]),
    () => {},
    pool,
  )
  const scope1 = await loader({
    cwd: projDir,
    environmentId: 'node:local',
    trusted: true,
    settings: { mcpServers: { docs: { command: 'node', args: ['-e', ''] } } },
    projectSettings: {},
    entries: [],
  })
  const scope2 = await loader({
    cwd: projDir,
    environmentId: 'node:local',
    trusted: true,
    settings: {
      model: 'other/model',
      mcpServers: { docs: { command: 'node', args: ['-e', ''] } },
    },
    projectSettings: {},
    entries: [],
  })
  const exts1 = await scope1.load()
  const exts2 = await scope2.load()
  const noopApi = {
    cwd: projDir,
    dataDir: dir.path,
    config: scope1.extensionConfig.mcp ?? {},
    logger: silentLogger,
    registerTool: () => '',
    unregisterTool: () => false,
    onShutdown: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    registerChannel: () => {},
    on: () => () => {},
  }
  await exts1[0]!(noopApi)
  await exts2[0]!(noopApi)
  expect(acquireCount).toBe(2)
  expect(pool.size).toBe(1)
  await pool.dispose()
})

test('trusted non-local workspace discovers explicitly declared settings.skills and settings.prompts in both batched and fallback loaders', async () => {
  const dir = tempDir('vela-remote-inventory-')
  dirs.push(dir)
  const guestDir = join(dir.path, 'guest-bin')
  const resultRoot = join(dir.path, 'results')
  mkdirSync(guestDir, { recursive: true })
  await buildDockerGuest(guestDir)
  const guest = readFileSync(join(guestDir, 'guest.cjs'), 'utf8')

  const wsRoot = join(dir.path, 'workspace')
  const extraSkills = join(wsRoot, 'custom-skills/my-skill')
  const extraPrompts = join(wsRoot, 'custom-prompts')
  mkdirSync(extraSkills, { recursive: true })
  mkdirSync(extraPrompts, { recursive: true })
  writeFileSync(
    join(extraSkills, 'SKILL.md'),
    '---\nname: declared-skill\ndescription: Custom skill\n---\nBody\n',
  )
  writeFileSync(
    join(extraPrompts, 'custom.md'),
    '---\ndescription: Custom prompt\n---\nPrompt body\n',
  )

  const batchedEnv = dockerOperations('remote-batch', wsRoot, (op, cwd) =>
    spawn('node', ['-e', guest, '--', op, cwd, resultRoot], {
      cwd: wsRoot,
      env: { PATH: process.env.PATH, HOME: dir.path },
      stdio: 'pipe',
    }),
  )
  const fallbackBase = createLocalExecutionEnv({ cwd: wsRoot })
  const fallbackEnv = Object.assign(
    Object.create(Object.getPrototypeOf(fallbackBase)),
    fallbackBase,
    { id: 'docker:fallback' },
  ) as typeof fallbackBase

  const commonArgs = {
    host: { skills: [], promptTemplates: [], contextFiles: [] },
    pinned: false,
    contextEnabled: false,
    explicitSkills: false,
    explicitTemplates: false,
    logger: silentLogger,
  }
  const declared = {
    skills: [join(wsRoot, 'custom-skills')],
    prompts: [extraPrompts],
  }
  try {
    const viaBatch = await loadWorkspaceInventory(
      batchedEnv,
      new AbortController().signal,
      declared,
      'all',
      commonArgs,
    )
    expect(viaBatch.skills.map((s) => s.name)).toContain('declared-skill')
    expect(viaBatch.promptTemplates.map((p) => p.name)).toContain('custom')

    const viaFallback = await loadWorkspaceInventory(
      fallbackEnv,
      new AbortController().signal,
      declared,
      'all',
      commonArgs,
    )
    expect(viaFallback.skills.map((s) => s.name)).toContain('declared-skill')
    expect(viaFallback.promptTemplates.map((p) => p.name)).toContain('custom')
  } finally {
    await batchedEnv.cleanup()
    await fallbackBase.cleanup()
  }
})
