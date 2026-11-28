import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { savedTrust, saveTrust, trustLocationKey } from '../../src/db/index.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import { createVela } from '../../src/driver/index.ts'
import { executionEnvOs } from '../../src/shared/execution.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('trusted_paths supports container env:<name>:<posixCwd> hierarchy without creating empty vela.db on read', () => {
  const dir = tempDir('vela-trust-db-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  mkdirSync(agentDir, { recursive: true })

  const containerLoc = { environment: 'dev', cwd: '/workspace/apps/api' }
  expect(trustLocationKey(containerLoc)).toBe('env:dev:/workspace/apps/api')
  expect(savedTrust(agentDir, containerLoc)).toBeUndefined()
  // Read-only lookup does not create vela.db when absent
  expect(existsSync(join(agentDir, 'vela.db'))).toBe(false)

  // Local path decision never collides with container posix path
  saveTrust(agentDir, dir.path, true)
  expect(
    savedTrust(agentDir, { environment: 'dev', cwd: dir.path }),
  ).toBeUndefined()

  // Ancestor trust + child denial for non-local environments
  saveTrust(agentDir, { environment: 'dev', cwd: '/workspace' }, true)
  expect(savedTrust(agentDir, containerLoc)).toBe(true)
  expect(
    savedTrust(agentDir, { environment: 'other', cwd: '/workspace/apps/api' }),
  ).toBeUndefined()

  saveTrust(agentDir, { environment: 'dev', cwd: '/workspace/apps' }, false)
  expect(savedTrust(agentDir, containerLoc)).toBe(false)
  expect(savedTrust(agentDir, { environment: 'dev', cwd: '/workspace' })).toBe(
    true,
  )

  // Environment names containing `:` or `/` never collide across environments
  expect(trustLocationKey({ environment: 'a:/x', cwd: '/y' })).not.toBe(
    trustLocationKey({ environment: 'a', cwd: '/x:/y' }),
  )
  saveTrust(agentDir, { environment: 'a:/x', cwd: '/y' }, true)
  expect(
    savedTrust(agentDir, { environment: 'a', cwd: '/x:/y' }),
  ).toBeUndefined()
})

test('savedTrust reads existing vela.db without requiring write permissions when WAL sidecars exist', () => {
  const dir = tempDir('vela-trust-ro-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  mkdirSync(agentDir, { recursive: true })
  saveTrust(agentDir, { environment: 'dev', cwd: '/workspace' }, true)

  const dbPath = join(agentDir, 'vela.db')
  chmodSync(dbPath, 0o444)
  chmodSync(agentDir, 0o555)
  try {
    expect(
      savedTrust(agentDir, { environment: 'dev', cwd: '/workspace/sub' }),
    ).toBe(true)
  } finally {
    chmodSync(agentDir, 0o700)
    chmodSync(dbPath, 0o600)
  }
})

test('untrusted container workspace skips workspace config/AGENTS/skills/prompts and omits <docs>; trusted loads them with real os', async () => {
  const dir = tempDir('vela-container-trust-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const containerRoot = join(dir.path, 'container-ws')
  const docsDir = join(dir.path, 'vela-docs')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(containerRoot, '.vela/skills/ws-skill'), { recursive: true })
  mkdirSync(join(containerRoot, '.vela/prompts'), { recursive: true })
  mkdirSync(docsDir, { recursive: true })

  writeFileSync(join(containerRoot, 'AGENTS.md'), 'CONTAINER_AGENTS_BODY')
  writeFileSync(
    join(containerRoot, '.vela/config.json'),
    JSON.stringify({ thinkingLevel: 'high' }),
  )
  writeFileSync(
    join(containerRoot, '.vela/skills/ws-skill/SKILL.md'),
    '---\nname: ws-skill\ndescription: Workspace skill\n---\nbody',
  )
  writeFileSync(
    join(containerRoot, '.vela/prompts/check.md'),
    'CONTAINER_PROMPT_TEMPLATE',
  )

  const createContainerEnv = (cwd: string) => {
    const local = createLocalExecutionEnv({ cwd: containerRoot })
    const baseAbsolutePath = local.absolutePath.bind(local)
    const baseJoinPath = local.joinPath.bind(local)
    return Object.assign(local, {
      id: 'docker:dev',
      cwd,
      [executionEnvOs]: 'linux',
      async absolutePath(p: string, s?: AbortSignal) {
        if (p.startsWith('~/.vela'))
          return {
            ok: true as const,
            value: join(containerRoot, '.vela-missing'),
          }
        const rel = p.startsWith(cwd)
          ? p.slice(cwd.length).replace(/^\/+/, '')
          : p
        return baseAbsolutePath(rel || '.', s)
      },
      async joinPath(parts: string[], s?: AbortSignal) {
        const mapped = parts.map((part) =>
          part === cwd ? containerRoot : part,
        )
        return baseJoinPath(mapped, s)
      },
    })
  }

  let trustState: 'none' | 'all' = 'none'
  const model = createFauxModel({
    responses: [fauxText('untrusted'), fauxText('trusted'), fauxText('local')],
  })
  const vela = createVela({
    cwd: dir.path,
    dataDir: join(dir.path, 'data'),
    model,
    docs: { docs: docsDir },
    env: ({ location }) =>
      location.environment === 'dev'
        ? createContainerEnv(location.cwd)
        : undefined,
    sessionResources: {
      agentDir,
      cwd: dir.path,
      useBuiltinLocal: true,
      workspaceSkills: 'none',
      workspaceModeAt: (_cwd, environment = 'local') =>
        environment === 'dev' ? trustState : 'none',
      userContextFiles: [
        { path: join(agentDir, 'AGENTS.md'), content: 'HOST_USER_CONTEXT' },
      ],
      hostSkillDirs: [],
      hostPromptDirs: [],
    },
  })

  try {
    // 1. Untrusted container session
    const untrusted = vela.session('c-untrusted', {
      location: { environment: 'dev', cwd: '/workspace' },
    })
    await untrusted.prompt('hi')
    const untrustedRes = await untrusted.resources()
    expect(untrustedRes.skills).toEqual([])
    expect(untrustedRes.promptTemplates).toEqual([])
    expect(untrustedRes.contextFiles.map((f) => f.content)).toEqual([
      'HOST_USER_CONTEXT',
    ])
    const untrustedSystem = model.calls[0]!.system
    expect(untrustedSystem).not.toContain('<docs>')
    expect(untrustedSystem).not.toContain('CONTAINER_AGENTS_BODY')
    expect(untrustedSystem).toContain('\nos: linux\n')
    expect(untrustedSystem).not.toContain('\nshell: ')
    expect(untrustedSystem).toMatch(/\nCurrent date: \d{4}-\d{2}-\d{2}\n/)

    // 2. Trusted container session
    trustState = 'all'
    const trusted = vela.session('c-trusted', {
      location: { environment: 'dev', cwd: '/workspace' },
    })
    await trusted.prompt('hi')
    const trustedRes = await trusted.resources()
    expect(trustedRes.skills.map((s) => s.name)).toEqual(['ws-skill'])
    expect(trustedRes.promptTemplates.map((p) => p.name)).toEqual(['check'])
    expect(trustedRes.contextFiles.map((f) => f.content)).toContain(
      'CONTAINER_AGENTS_BODY',
    )
    expect(trusted.thinkingLevel).toBe('high')
    const trustedSystem = model.calls[1]!.system
    expect(trustedSystem).not.toContain('<docs>')
    expect(trustedSystem).toContain('CONTAINER_AGENTS_BODY')
    expect(trustedSystem).toContain('\nos: linux\n')

    // 3. Local session includes <docs> and host OS
    const localSession = vela.session('local-s')
    await localSession.prompt('hi')
    const localSystem = model.calls[2]!.system
    expect(localSystem).toContain('<docs>')
    expect(localSystem).toContain(`\nos: ${process.platform}\n`)
    expect(localSystem).toMatch(/\nCurrent date: \d{4}-\d{2}-\d{2}\n/)
  } finally {
    await vela.dispose()
  }
})
