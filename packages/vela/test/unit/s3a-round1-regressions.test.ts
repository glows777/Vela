import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDockerGuest } from '../../../../scripts/build-docker-guest.ts'
import { tempDir } from '../../../../test/support/vela.ts'
import { saveTrust } from '../../src/db/index.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import { loadConfig } from '../../src/driver/index.ts'
import { ProjectConfig } from '../../src/driver/session/project-config.ts'
import { loadWorkspaceInventory } from '../../src/driver/session/workspace.ts'
import { createRuntime } from '../../src/index.ts'
import { dockerOperations } from '../../src/runtime/docker/operations.ts'
import { createEnvironmentRegistryForTest } from '../../src/runtime/environments.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/index.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('createRuntime approveLocation scopes --approve to startup local cwd only', async () => {
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

  const envRegistry = createEnvironmentRegistryForTest({
    dataDir: agentDir,
    environments: { dev: { image: 'alpine', network: 'on' } },
    openDocker: async () =>
      Object.assign(createLocalExecutionEnv({ cwd: projectA }), {
        canonicalPath: async (target: string) => ({
          ok: true as const,
          value: target,
        }),
      }),
  })
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
    environments: envRegistry,
    mcp: false,
  })
  try {
    await runtime.ready()
    const sA = await runtime.sessions.create({
      location: { environment: 'local', cwd: projectA },
    })
    const sB = await runtime.sessions.create({
      location: { environment: 'local', cwd: projectB },
    })
    const sRemote = await runtime.sessions.create({
      location: { environment: 'dev', cwd: '/workspace' },
    })
    await runtime.sessions.configure(sA.id, {
      approve: true,
      approveLocation: projectA,
    })
    await runtime.sessions.configure(sB.id, {
      approve: true,
      approveLocation: projectA,
    })
    await runtime.sessions.configure(sRemote.id, {
      approve: true,
      approveLocation: projectA,
    })
    expect((await runtime.sessions.inspect(sA.id)).resources.trusted).toBe(true)
    expect((await runtime.sessions.inspect(sB.id)).resources.trusted).toBe(
      false,
    )
    expect((await runtime.sessions.inspect(sRemote.id)).resources.trusted).toBe(
      false,
    )
  } finally {
    await runtime.dispose()
  }
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

test('createRuntime reuses the shared host McpPool across session loads', async () => {
  const dir = tempDir('vela-cli-mcp-pool-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const projDir = join(dir.path, 'project')
  const pidFile = join(projDir, 'server.pid')
  const server = new URL(
    '../../../../test/fixtures/mcp-echo-server.ts',
    import.meta.url,
  ).pathname
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(projDir, '.vela'), { recursive: true })
  writeFileSync(
    join(projDir, '.vela/config.json'),
    JSON.stringify({
      mcpServers: {
        docs: {
          command: process.execPath,
          args: [server],
          env: { PID_FILE: pidFile },
          exposure: 'direct',
        },
      },
    }),
  )
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({
      responses: [fauxText('first'), fauxText('second')],
    }),
    hostEnv: {},
  })
  try {
    await runtime.ready()
    await runtime.trust.approve(projDir, true)
    const s1 = await runtime.sessions.create({
      location: { environment: 'local', cwd: projDir },
    })
    const s2 = await runtime.sessions.create({
      location: { environment: 'local', cwd: projDir },
    })
    await runtime.prompt(s1.id, { text: 'first' })
    await runtime.waitForIdle(s1.id)
    const pid1 = readFileSync(pidFile, 'utf8').trim()
    expect(Number(pid1)).toBeGreaterThan(0)
    await runtime.prompt(s2.id, { text: 'second' })
    await runtime.waitForIdle(s2.id)
    const pid2 = readFileSync(pidFile, 'utf8').trim()
    expect(pid2).toBe(pid1)
  } finally {
    await runtime.dispose()
  }
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
