// Opt in with an owner-provided local image containing node, bash, rg and fd. Never pulls.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tempDir } from '@glows777/vela/testing'
import type { ExecutionEnv } from '@glows777/vela-core'
import { buildDockerAdapter } from '../../extensions/docker/build.ts'
import { runDocker } from '../../extensions/docker/container.ts'
import { prepareDocker } from '../../extensions/docker/lifecycle.ts'
import { checkDockerOperations } from '../support/docker-conformance.ts'

const image = process.env.VELA_TEST_DOCKER_IMAGE
describe.skipIf(!image)('prepared Docker image', () => {
  let dir: ReturnType<typeof tempDir>
  let openDockerEnvironment: typeof import('../../extensions/docker/adapter.ts').openDockerEnvironment
  const owners = new Set<string>()
  const adapters: ExecutionEnv[] = []

  beforeAll(async () => {
    dir = tempDir('vela-image-')
    await buildDockerAdapter(dir.path)
    const adapter = await import(join(dir.path, 'adapter.mjs'))
    openDockerEnvironment = adapter.openDockerEnvironment
  })
  function owner(name: string) {
    return createHash('sha256')
      .update(JSON.stringify([dir.path, name]))
      .digest('hex')
  }
  function lookup(key: string) {
    return runDocker([
      'ps',
      '-aq',
      '--no-trunc',
      '--filter',
      `label=org.vela.environment=${key}`,
    ])
  }
  function config(name: string) {
    owners.add(owner(name))
    return { dataDir: dir.path, name, image: image!, network: 'off' as const }
  }
  async function open(name: string) {
    const env = await openDockerEnvironment(config(name))
    adapters.push(env)
    return env
  }
  afterAll(async () => {
    try {
      await Promise.all(adapters.map((env) => env.cleanup()))
    } finally {
      for (const key of owners) {
        const id = await lookup(key)
        if (/^[a-f0-9]{64}$/.test(id)) await runDocker(['rm', '-fv', id])
      }
      dir.cleanup()
    }
  }, 240000)

  test('runs the built adapter, survives reopen and isolates environments', async () => {
    const a = await open('alpha')
    await checkDockerOperations(a)
    const reopened = await open('alpha')
    expect(await reopened.readTextFile('page')).toEqual({
      ok: true,
      value: 'replaced',
    })
    const b = await open('beta')
    expect(b.id).not.toBe(a.id)
    expect(await b.exists('page')).toEqual({ ok: true, value: false })
  }, 240000)

  test('a callback error after command exit returns the readable spill file', async () => {
    const env = await open('callback')
    // An incomplete UTF-8 character is delivered to the observer only on decoder flush at exit.
    const result = await env.exec(['printf', 'transcript\\342'], {
      spill: { afterBytes: 1, afterLines: 1 },
      onOutput(text) {
        if (text.includes('\uFFFD')) throw Error('observer failed')
      },
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'callback_error', message: 'observer failed' },
    })
    if (result.ok) throw Error('Expected callback_error')
    const path = result.error.spillPath
    expect(path).toMatch(/^\/tmp\/vela-results\//)
    expect(await env.readBinaryFile(path!)).toEqual({
      ok: true,
      value: Uint8Array.from([...Buffer.from('transcript'), 0xe2]),
    })
    expect((await env.remove(path!, {})).ok).toBe(true)
    expect(await env.exists(path!)).toEqual({ ok: true, value: false })
  }, 240000)

  test('failed preflight preserves an existing container and its prior running state', async () => {
    const env = await open('reopen-failure')
    expect(
      (await env.renameFile('/tmp/vela-home', '/tmp/previous-home')).ok,
    ).toBe(true)
    expect((await env.writeFile('/tmp/vela-home', 'fixture')).ok).toBe(true)
    const id = await lookup(owner('reopen-failure'))
    expect(id).toMatch(/^[a-f0-9]{64}$/)
    for (const running of [true, false]) {
      if (!running) await runDocker(['stop', '--timeout', '1', id])
      await expect(open('reopen-failure')).rejects.toThrow(
        /EEXIST:.*mkdir '\/tmp\/vela-home'/,
      )
      expect(
        await runDocker(['inspect', '--format', '{{.State.Running}}', id]),
      ).toBe(String(running))
    }
  }, 240000)

  test('failed preflight removes a newly created owned container', async () => {
    const name = 'create-failure'
    const file = join(dir.path, 'home-conflict')
    await Bun.write(file, 'fixture')
    await expect(
      prepareDocker(config(name), async (args) => {
        const result = await runDocker(args)
        // Seed the fresh container's filesystem before first start, keeping the same offline image.
        if (args[0] === 'create')
          await runDocker(['cp', file, `${result}:/tmp/vela-home`])
        return result
      }),
    ).rejects.toThrow(/EEXIST:.*mkdir '\/tmp\/vela-home'/)
    expect(await lookup(owner(name))).toBe('')
  }, 240000)
})
