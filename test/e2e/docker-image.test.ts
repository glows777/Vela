// Opt in with an owner-provided local image containing node, bash, rg and fd. Never pulls.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempDir } from '@glows777/vela/testing'
import type { ExecutionEnv } from '@glows777/vela-core'
import { buildDockerAdapter } from '../../extensions/docker/build.ts'
import { runDocker } from '../../extensions/docker/container.ts'
import { prepareDocker } from '../../extensions/docker/lifecycle.ts'
import { checkDockerOperations } from '../support/docker-conformance.ts'

const image = process.env.VELA_TEST_DOCKER_IMAGE
const volumeImage = process.env.VELA_TEST_DOCKER_VOLUME_IMAGE
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

  test('the installed adapter starts credential mediation and offers only a guest placeholder', async () => {
    const options = config('credentials-on')
    const syntheticValue = 'host-fixture-value-not-for-the-guest'
    const env = await openDockerEnvironment({
      ...options,
      network: 'on',
      credentials: [
        {
          variable: 'GH_TOKEN',
          value: syntheticValue,
          origins: ['https://github.com'],
        },
      ],
    })
    adapters.push(env)
    let output = ''
    const script = [
      'const {GH_TOKEN,HTTPS_PROXY,SSL_CERT_FILE}=process.env',
      'const fs=require("node:fs"); const proxy=new URL(HTTPS_PROXY)',
      'const socket=require("node:net").connect(Number(proxy.port),proxy.hostname)',
      'socket.setTimeout(5000, () => socket.destroy(new Error("credential proxy connect timeout")))',
      'const ca=fs.readFileSync(SSL_CERT_FILE,"utf8")',
      'socket.once("connect", () => socket.write("CONNECT github.com:443 HTTP/1.1\\r\\nHost: github.com:443\\r\\n\\r\\n"))',
      'socket.once("data", (chunk) => { if (!chunk.toString().startsWith("HTTP/1.1 200 ")) throw Error("owner CONNECT failed"); const tls=require("node:tls").connect({socket,servername:"github.com",ca}); tls.once("secureConnect", () => { console.log(JSON.stringify([GH_TOKEN,HTTPS_PROXY,tls.authorized])); tls.destroy() }) })',
    ].join(';')
    const result = await env.exec(['node', '-e', script], {
      onOutput(text, _signal, { stream }) {
        if (stream === 'stdout') output += text
      },
    })
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } })
    expect(output).not.toContain(syntheticValue)
    const [token, proxy, hasCa] = JSON.parse(output)
    expect(token).toMatch(/^vela-credential-/)
    expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(hasCa).toBe(true)
  }, 240000)

  test('credential setup failure does not start an owned container', async () => {
    const name = 'credentials-setup-failed'
    const options = config(name)
    await expect(
      openDockerEnvironment({
        ...options,
        network: 'on',
        credentials: [
          {
            variable: 'GH_TOKEN',
            value: 'fixture',
            origins: ['not-an-origin'],
          },
        ],
      }),
    ).rejects.toThrow()
    expect(await lookup(owner(name))).toBe('')
  }, 240000)

  test('the host owner can edit a file created in the isolated workspace', async () => {
    const name = 'ownership'
    const env = await open(name)
    const file = join(
      dir.path,
      'environments',
      owner(name),
      'workspace',
      'note',
    )
    const sentinel = join(dir.path, 'owner-only')
    await writeFile(sentinel, 'private fixture')
    expect(await env.exists(sentinel)).toEqual({ ok: true, value: false })
    expect(await env.exists('/var/run/docker.sock')).toEqual({
      ok: true,
      value: false,
    })
    expect((await env.writeFile('note', 'guest')).ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('guest')
    expect((await stat(file)).uid).toBe(process.getuid!())
    await writeFile(file, 'host')
    expect(await env.readTextFile('note')).toEqual({ ok: true, value: 'host' })
    expect((await env.remove('note', {})).ok).toBe(true)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 240000)

  test('a failed Docker client call identifies the attempted local socket', async () => {
    const absent = owner('absent-container')
    await expect(
      runDocker(['inspect', '--type', 'container', absent]),
    ).rejects.toThrow(
      /unix:\/\/\/var\/run\/docker\.sock.*No such (?:object|container)/is,
    )
  })

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

  test.skipIf(!volumeImage)(
    'rejecting an image volume removes only the new container and its anonymous volume',
    async () => {
      const name = 'extra-volume'
      const options = { ...config(name), image: volumeImage! }
      const rejection = {
        name: 'Error',
        message:
          'Docker container ownership or configuration differs; explicit owner restart required',
      }
      let volume = ''
      const findVolume = () =>
        runDocker(['volume', 'ls', '-q', '--filter', `name=^${volume}$`])
      await expect(
        prepareDocker(options, async (args) => {
          const result = await runDocker(args)
          if (args[0] === 'inspect') {
            const [container] = JSON.parse(result)
            const mount = container.Mounts.find(
              (m: { Destination: string }) =>
                m.Destination === '/vela-test-volume',
            )
            expect(mount.Type).toBe('volume')
            volume = mount.Name
            expect(volume).toMatch(/^[a-f0-9]{64}$/)
            // A second opener sees a pre-existing container. Its rejection must leave both resources alone.
            await expect(openDockerEnvironment(options)).rejects.toMatchObject(
              rejection,
            )
            expect(await lookup(owner(name))).toBe(container.Id)
            expect(await findVolume()).toBe(volume)
          }
          return result
        }),
      ).rejects.toMatchObject(rejection)
      expect(volume).toMatch(/^[a-f0-9]{64}$/)
      expect({
        container: await lookup(owner(name)),
        volume: await findVolume(),
      }).toEqual({ container: '', volume: '' })
    },
    240000,
  )
})
