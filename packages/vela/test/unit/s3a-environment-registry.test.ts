import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tempDir } from '../../../../test/support/vela.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import {
  dockerClientPath,
  dockerContainerId,
  resolveDockerHost,
} from '../../src/runtime/docker/container.ts'
import { EnvironmentRegistry } from '../../src/runtime/index.ts'
import type { ExecutionEnv } from '../../src/shared/execution.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('resolveDockerHost and dockerClientPath honor DOCKER_HOST and macOS Homebrew PATH', () => {
  expect(resolveDockerHost({})).toBe('unix:///var/run/docker.sock')
  expect(resolveDockerHost({ DOCKER_HOST: '  ' })).toBe(
    'unix:///var/run/docker.sock',
  )
  expect(resolveDockerHost({ DOCKER_HOST: 'unix:///custom/docker.sock' })).toBe(
    'unix:///custom/docker.sock',
  )
  expect(dockerClientPath('darwin')).toBe(
    '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  )
  expect(dockerClientPath('linux')).toBe('/usr/local/bin:/usr/bin:/bin')
})

test('EnvironmentRegistry validates definitions, reports OS metadata, and re-probes dead containers', async () => {
  const dir = tempDir('vela-env-reg-')
  dirs.push(dir)

  expect(
    () => new EnvironmentRegistry({ dataDir: dir.path, environments: [] }),
  ).toThrow('Owner environments must be an object')

  let openedCount = 0
  const cleanedIds: string[] = []
  const aliveIds = new Set<string>()

  const registry = new EnvironmentRegistry({
    dataDir: dir.path,
    hostEnv: { TEST_TOKEN: 'secret-value' },
    environments: {
      dev: {
        image: 'vela-base:local',
        network: 'on',
        credentials: {
          GH_TOKEN: {
            value: '$TEST_TOKEN',
            origins: ['https://github.com'],
          },
        },
      },
      broken: {
        image: 123,
      },
    },
    openDocker: async (options, cwd = '/workspace') => {
      expect(options.credentials).toEqual([
        {
          variable: 'GH_TOKEN',
          value: 'secret-value',
          origins: ['https://github.com'],
        },
      ])
      const id = `container-${++openedCount}`
      aliveIds.add(id)
      const base = createLocalExecutionEnv({ cwd: dir.path })
      const env: ExecutionEnv & { [dockerContainerId]?: string } = {
        ...base,
        id: `docker:${options.name}`,
        cwd,
        [dockerContainerId]: id,
        async cleanup() {
          cleanedIds.push(id)
          await base.cleanup()
        },
      }
      return env
    },
    probeAlive: async (id) => aliveIds.has(id),
  })

  expect(registry.has('local')).toBe(true)
  expect(registry.has('dev')).toBe(true)
  expect(registry.has('missing')).toBe(false)
  expect(registry.osFor('local')).toBe(process.platform)
  expect(registry.osFor('dev')).toBe('linux')

  // Local location returns undefined (caller uses session-scoped local env)
  expect(
    await registry.resolve({
      sessionId: 's1',
      location: { environment: 'local', cwd: dir.path },
    }),
  ).toBeUndefined()

  // Invalid definition fails on resolve
  await expect(
    registry.resolve({
      sessionId: 's1',
      location: { environment: 'broken', cwd: '/workspace' },
    }),
  ).rejects.toThrow(
    'Invalid Docker configuration for owner environment "broken"',
  )

  // First resolve opens container-1; second reuses cached container-1
  const first = await registry.resolve({
    sessionId: 's1',
    location: { environment: 'dev', cwd: '/workspace' },
  })
  const second = await registry.resolve({
    sessionId: 's2',
    location: { environment: 'dev', cwd: '/workspace' },
  })
  expect(first).toBeDefined()
  expect(second).toBe(first)
  expect(openedCount).toBe(1)

  // Simulate container dying -> probeAlive returns false -> evicted, cleaned up, re-opened
  aliveIds.delete('container-1')
  const reopened = await registry.resolve({
    sessionId: 's1',
    location: { environment: 'dev', cwd: '/workspace' },
  })
  expect(reopened).toBeDefined()
  expect(reopened).not.toBe(first)
  expect(openedCount).toBe(2)
  expect(cleanedIds).toEqual(['container-1'])

  await registry.dispose()
  expect(cleanedIds).toEqual(['container-1', 'container-2'])
  await expect(
    registry.resolve({
      sessionId: 's1',
      location: { environment: 'dev', cwd: join('/workspace', 'sub') },
    }),
  ).rejects.toThrow('EnvironmentRegistry has been disposed')
})
