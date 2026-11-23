import { expect, test } from 'bun:test'
import { ExtensionRunner } from '../../../../src/driver/extensions/runner.ts'
import type { ExtensionAPI } from '../../../../src/driver/extensions/types.ts'
import { ToolRegistry } from '../../../../src/driver/tools/registry.ts'
import { createVela } from '../../../../src/driver/vela.ts'
import { ModelRegistry } from '../../../../src/providers/models/index.ts'
import { silentLogger } from '../../../../src/shared/logger.ts'

test('project runner composes host/project/core order, session cwd and own disposal', async () => {
  const vela = createVela({ cwd: '/tmp' })
  const session = vela.session('scoped', { cwd: '/tmp/project-b' })
  const seen: string[] = []
  const warnings: string[] = []
  const models = new ModelRegistry()
  const deps = {
    cwd: '/tmp/host',
    dataDir: '/tmp',
    extensionConfig: {},
    logger: { ...silentLogger, warn: (text: string) => warnings.push(text) },
    registry: new ToolRegistry(),
    models,
  }
  let hostApi: ExtensionAPI | undefined
  const host = new ExtensionRunner(
    deps,
    [
      function host(api) {
        hostApi = api
        expect(api.cwd).toBe('/tmp/host')
        api.on('session_start', (_, ctx) => {
          seen.push(`host:${ctx.cwd}`)
        })
        api.registerCommand('host', {
          handler: (_, ctx) => {
            seen.push(`command:${ctx.cwd}`)
          },
        })
        api.onShutdown(() => {
          seen.push('host-shutdown')
        })
      },
    ],
    [
      function audit(api) {
        api.on('session_start', () => {
          seen.push('audit')
        })
      },
    ],
  )
  const project = new ExtensionRunner(
    {
      ...deps,
      cwd: '/tmp/project-b',
      parent: host,
      registry: new ToolRegistry(undefined, undefined, deps.registry),
    },
    [
      function project(api) {
        expect(api.cwd).toBe('/tmp/project-b')
        api.on('session_start', (_, ctx) => {
          seen.push(`project:${ctx.cwd}`)
        })
        api.registerProvider('blocked', {
          createModel: () => {
            throw new Error('must not resolve')
          },
        })
        api.registerCommand('project', { handler: () => {} })
        api.onShutdown(() => {
          seen.push('project-shutdown')
        })
      },
    ],
  )
  try {
    await project.ready
    await project.sessionStart(session)
    expect(seen).toEqual([
      'host:/tmp/project-b',
      'project:/tmp/project-b',
      'audit',
    ])
    expect(project.hasHandlers('session_start')).toBe(true)
    expect(project.commands().map((c) => c.name)).toEqual(['host', 'project'])
    expect(host.commands().map((c) => c.name)).toEqual(['host'])
    hostApi!.registerCommand('late', { handler: () => {} })
    expect(project.commands().map((c) => c.name)).toContain('late')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('host-only')
    expect(
      project.loaded().find((e) => e.name === 'project')?.providers,
    ).toEqual([])
    await project.runCommand(session, '/host', new AbortController().signal)
    expect(seen.at(-1)).toBe('command:/tmp/project-b')
    await project.shutdown()
    expect(seen.at(-1)).toBe('project-shutdown')
    expect(seen).not.toContain('host-shutdown')
    await host.shutdown()
    expect(seen.at(-1)).toBe('host-shutdown')
  } finally {
    await vela.dispose()
  }
})

test('project settled waits for another factory after readiness rejects', async () => {
  const deps = {
    cwd: '/tmp',
    dataDir: '/tmp',
    extensionConfig: {},
    logger: silentLogger,
    registry: new ToolRegistry(),
    models: new ModelRegistry(),
  }
  const host = new ExtensionRunner(deps, [])
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  let cleaned = false
  const project = new ExtensionRunner({ ...deps, parent: host }, [
    async function slow(api) {
      await waiting
      api.onShutdown(() => {
        cleaned = true
      })
    },
    async function broken() {
      throw new Error('broken factory')
    },
  ])
  await expect(project.ready).rejects.toThrow('broken factory')
  let settled = false
  void project.settled.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish()
  await project.settled
  await project.shutdown()
  expect(cleaned).toBe(true)
})
