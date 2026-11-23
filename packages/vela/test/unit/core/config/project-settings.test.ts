import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { loadProjectSettings } from '../../../../src/driver/config/project-settings.ts'
import { loadConfig } from '../../../../src/driver/config/settings.ts'
import { mergeSettings } from '../../../../src/driver/config/settings-values.ts'
import type {
  ExecutionEnv,
  FileError,
} from '../../../../src/driver/execution/types.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function remote(files: Record<string, string>) {
  const reads: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  const environment = {
    id: 'test:remote',
    cwd: '/workspace/B',
    joinPath: async (parts: string[], signal?: AbortSignal) => {
      signals.push(signal)
      return { ok: true as const, value: posix.join(...parts) }
    },
    absolutePath: async (path: string, signal?: AbortSignal) => {
      signals.push(signal)
      return {
        ok: true as const,
        value: path.startsWith('~/')
          ? `/remote/home/${path.slice(2)}`
          : posix.resolve('/workspace/B', path),
      }
    },
    readTextFile: async (path: string, signal?: AbortSignal) => {
      reads.push(path)
      signals.push(signal)
      return path in files
        ? { ok: true as const, value: files[path]! }
        : {
            ok: false as const,
            error: Object.assign(new Error('missing'), {
              code: 'not_found',
            }) as FileError,
          }
    },
  } as ExecutionEnv
  return { environment, reads, signals }
}

test('project settings use the selected environment, config-relative resources and explicit interpolation', async () => {
  const { environment, reads, signals } = remote({
    '/workspace/B/.vela/settings.json': JSON.stringify({
      defaultModel: 'test/b',
      skills: ['../skills', '~/shared-skills'],
      prompts: ['./templates'],
      extensions: ['+builtin:memory', './extension.ts'],
      extensionConfig: { plugin: { value: '$TOKEN', literal: '$$TOKEN' } },
    }),
  })
  const signal = new AbortController().signal
  const result = await loadProjectSettings(environment, {
    cwd: '/workspace/B',
    trusted: true,
    env: { TOKEN: 'explicit' },
    signal,
  })
  expect(reads).toEqual(['/workspace/B/.vela/settings.json'])
  expect(signals.every((entry) => entry === signal)).toBe(true)
  expect(result.skillDirs).toEqual([
    '/workspace/B/skills',
    '/remote/home/shared-skills',
  ])
  expect(result.promptDirs).toEqual(['/workspace/B/.vela/templates'])
  expect(result.settings.extensions).toEqual([
    '+builtin:memory',
    '/workspace/B/.vela/extension.ts',
  ])
  expect(result.settings.extensionConfig).toEqual({
    plugin: { value: 'explicit', literal: '$TOKEN' },
  })
  expect(result.settings.defaultModel).toBe('test/b')
})

test('untrusted projects read nothing, missing config stays empty, local user directory is not loaded twice', async () => {
  const fake = remote({})
  expect(
    (
      await loadProjectSettings(fake.environment, {
        cwd: '/workspace/B',
        trusted: false,
      })
    ).settings,
  ).toEqual({})
  expect(fake.reads).toEqual([])
  expect(
    (
      await loadProjectSettings(fake.environment, {
        cwd: '/workspace/B',
        trusted: true,
      })
    ).files,
  ).toEqual([])
  fake.reads.length = 0
  const local = { ...fake.environment, id: 'node:local' }
  await loadProjectSettings(local, {
    cwd: '/home',
    agentDir: '/home/.vela',
    trusted: true,
  })
  expect(fake.reads).toEqual([])
  // An identical remote path is not the host user configuration.
  await loadProjectSettings(fake.environment, {
    cwd: '/home',
    agentDir: '/home/.vela',
    trusted: true,
  })
  expect(fake.reads).toEqual(['/home/.vela/settings.json'])
})

test('malformed settings and adapter errors fail visibly; cancellation is propagated', async () => {
  const fake = remote({ '/workspace/B/.vela/settings.json': '{' })
  await expect(
    loadProjectSettings(fake.environment, {
      cwd: '/workspace/B',
      trusted: true,
    }),
  ).rejects.toThrow('is not valid JSON')
  const denied = Object.assign(new Error('access denied'), {
    code: 'permission_denied',
  }) as FileError
  fake.environment.readTextFile = async () => ({ ok: false, error: denied })
  await expect(
    loadProjectSettings(fake.environment, {
      cwd: '/workspace/B',
      trusted: true,
    }),
  ).rejects.toBe(denied)
  const controller = new AbortController()
  controller.abort()
  await expect(
    loadProjectSettings(fake.environment, {
      cwd: '/workspace/B',
      trusted: true,
      signal: controller.signal,
    }),
  ).rejects.toThrow()
})

test('startup view stays merged while runtime provenance contains only user settings and host resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'vela-project-settings-'))
  roots.push(root)
  const agentDir = join(root, 'user')
  const cwd = join(root, 'A')
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data))
  }
  write(join(agentDir, 'settings.json'), {
    defaultModel: 'test/user',
    skills: ['user-skills'],
    prompts: ['user-prompts'],
    defaultTools: ['read'],
    limits: { maxRetries: 10 },
  })
  write(join(cwd, '.vela/settings.json'), {
    defaultModel: 'test/a',
    skills: ['a-skills'],
    prompts: ['a-prompts'],
    defaultTools: ['+bash'],
  })
  const config = loadConfig({ cwd, agentDir, trusted: true, homeDir: root })
  expect(config.settings.defaultModel).toBe('test/a')
  expect(config.settings.defaultTools).toEqual(['read', '+bash'])
  expect(config.sessionResources?.userSettings?.defaultModel).toBe('test/user')
  expect(config.sessionResources?.hostSkillDirs).not.toContain(
    join(cwd, '.vela/a-skills'),
  )
  expect(config.sessionResources?.hostPromptDirs).not.toContain(
    join(cwd, '.vela/a-prompts'),
  )
  expect(config.skillDirs.indexOf(join(agentDir, 'user-skills'))).toBeLessThan(
    config.skillDirs.indexOf(join(cwd, '.vela/a-skills')),
  )
  expect(config.promptDirs).toEqual([
    join(cwd, '.vela/prompts'),
    join(agentDir, 'user-prompts'),
    join(cwd, '.vela/a-prompts'),
    join(agentDir, 'prompts'),
  ])
  expect(
    mergeSettings(config.sessionResources!.userSettings!, {
      defaultModel: 'test/b',
      defaultTools: ['-read'],
      limits: { maxRetries: 3 },
    }),
  ).toMatchObject({
    defaultModel: 'test/b',
    defaultTools: ['read', '-read'],
    limits: { maxRetries: 3 },
  })
})
