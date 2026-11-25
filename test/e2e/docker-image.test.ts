// Opt in with an owner-provided local image containing node, bash, rg and fd. Never pulls.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, globalAgent } from 'node:https'
import { join } from 'node:path'
import { tempDir } from '@glows777/vela/testing'
import type { ExecutionEnv } from '../../packages/vela/src/driver/index.ts'
import { openDockerEnvironment } from '../../packages/vela/src/runtime/docker/adapter.ts'
import {
  createDockerRunner,
  runDocker,
} from '../../packages/vela/src/runtime/docker/container.ts'
import { createCredentialIdentity } from '../../packages/vela/src/runtime/docker/credential-identity.ts'
import { prepareDocker } from '../../packages/vela/src/runtime/docker/lifecycle.ts'
import { buildDockerGuest } from '../../scripts/build-docker-guest.ts'
import { checkDockerOperations } from '../support/docker-conformance.ts'

const image = process.env.VELA_TEST_DOCKER_IMAGE
const volumeImage = process.env.VELA_TEST_DOCKER_VOLUME_IMAGE
describe.skipIf(!image)('prepared Docker image', () => {
  let dir: ReturnType<typeof tempDir>
  const dockerHost = process.env.DOCKER_HOST
  const docker = createDockerRunner(dockerHost)
  const owners = new Set<string>()
  const adapters: ExecutionEnv[] = []

  beforeAll(async () => {
    dir = tempDir('vela-image-')
    await buildDockerGuest(dir.path)
  })
  function owner(name: string) {
    return createHash('sha256')
      .update(JSON.stringify([dir.path, name]))
      .digest('hex')
  }
  function lookup(key: string) {
    return docker([
      'ps',
      '-aq',
      '--no-trunc',
      '--filter',
      `label=org.vela.environment=${key}`,
    ])
  }
  function config(name: string) {
    owners.add(owner(name))
    return {
      dataDir: dir.path,
      name,
      image: image!,
      network: 'off' as const,
      guestPath: join(dir.path, 'guest.cjs'),
      ...(dockerHost ? { dockerHost } : {}),
      hostEnv: process.env,
    }
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
        if (/^[a-f0-9]{64}$/.test(id)) await docker(['rm', '-fv', id])
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

  async function assertRestrictedDenial(env: ExecutionEnv) {
    let output = ''
    const script = [
      'const net = require("node:net")',
      'const proxy = new URL(process.env.HTTPS_PROXY)',
      'const socket = net.connect(Number(proxy.port), proxy.hostname)',
      'socket.setTimeout(5000, () => socket.destroy(new Error("fixture proxy timeout")))',
      'socket.on("connect", () => socket.write("CONNECT denied.test:443 HTTP/1.1\\r\\nHost: denied.test:443\\r\\n\\r\\n"))',
      'socket.once("data", (data) => { console.log(data.toString().split("\\r\\n")[0]); socket.destroy() })',
      'console.log(Object.keys(require("node:os").networkInterfaces()).sort().join(","))',
    ].join(';')
    const result = await env.exec(['node', '-e', script], {
      onOutput(text, _signal, { stream }) {
        if (stream === 'stdout') output += text
      },
    })
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } })
    expect(output.trim().split('\n')).toEqual(['lo', 'HTTP/1.1 403 Forbidden'])
  }

  test.skipIf(process.platform !== 'linux')(
    'the installed restricted adapter mediates allowed HTTPS, denies unlisted destinations and survives reopen',
    async () => {
      const name = 'restricted-egress'
      const hostname = 'allowed.test'
      const value = 'synthetic-owner-token'
      const identity = await createCredentialIdentity([hostname])
      const received: Array<string | undefined> = []
      const fixture = createServer(identity, (req, res) => {
        received.push(req.headers.authorization)
        res.end('synthetic HTTPS response')
      })
      await new Promise<void>((resolve, reject) => {
        fixture.once('error', reject)
        fixture.listen(0, '127.0.0.1', resolve)
      })
      const address = fixture.address()
      if (!address || typeof address !== 'object')
        throw Error('No fixture port')
      const connect = globalAgent.createConnection
      globalAgent.createConnection = function (options, callback) {
        // Only the test origin is redirected to the disposable upstream; retain normal TLS verification.
        return connect.call(
          this,
          options.host === hostname
            ? {
                ...options,
                host: '127.0.0.1',
                port: address.port,
                ca: identity.ca,
                servername: hostname,
              }
            : options,
          callback,
        )
      }
      const options = {
        ...config(name),
        network: 'restricted' as const,
        allow: [hostname.toUpperCase(), hostname],
        credentials: [
          { variable: 'GH_TOKEN', value, origins: [`https://${hostname}`] },
        ],
      }
      const verify = async (env: ExecutionEnv) => {
        await assertRestrictedDenial(env)
        let output = ''
        const result = await env.exec(
          `curl --silent --show-error --fail --noproxy '' --max-time 5 --header "Authorization: Bearer $GH_TOKEN" https://${hostname}/`,
          {
            onOutput(text, _signal, { stream }) {
              if (stream === 'stdout') output += text
            },
          },
        )
        expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } })
        expect(output).toBe('synthetic HTTPS response')
      }
      try {
        const env = await openDockerEnvironment(options)
        let id: string
        let source: string
        try {
          id = await lookup(owner(name))
          expect(id).toMatch(/^[a-f0-9]{64}$/)
          const mounts = JSON.parse(
            await docker(['inspect', '--format', '{{json .Mounts}}', id]),
          ) as {
            Type: string
            Destination: string
            Source: string
            RW: boolean
          }[]
          const mount = mounts.find(
            (item) => item.Destination === '/vela-egress',
          )
          expect(mount).toMatchObject({ Type: 'bind', RW: false })
          if (!mount) throw Error('Missing restricted proxy mount')
          source = mount.Source
          expect(
            (await readdir(source)).filter((file) => file.endsWith('.sock')),
          ).toHaveLength(1)
          await verify(env)
          expect(
            (await env.writeFile('note', 'fixture before reopen')).ok,
          ).toBe(true)
        } finally {
          await env.cleanup()
        }
        expect(
          (await readdir(source)).filter((file) => file.endsWith('.sock')),
        ).toEqual([])
        const reopened = await openDockerEnvironment({
          ...options,
          allow: [hostname],
        })
        try {
          expect(await lookup(owner(name))).toBe(id)
          expect(await reopened.readTextFile('note')).toEqual({
            ok: true,
            value: 'fixture before reopen',
          })
          await verify(reopened)
          expect(received).toEqual([`Bearer ${value}`, `Bearer ${value}`])
        } finally {
          await reopened.cleanup()
        }
      } finally {
        globalAgent.createConnection = connect
        fixture.closeAllConnections()
        await new Promise<void>((resolve) => fixture.close(() => resolve()))
      }
    },
    240000,
  )

  test.skipIf(process.platform !== 'linux')(
    'restricted mode refuses an existing off container without changing it',
    async () => {
      const name = 'restricted-with-off-container'
      const existing = await open(name)
      expect((await existing.writeFile('note', 'off fixture')).ok).toBe(true)
      const id = await lookup(owner(name))
      expect(id).toMatch(/^[a-f0-9]{64}$/)
      await docker(['stop', '--timeout', '1', id])
      await expect(
        openDockerEnvironment({
          ...config(name),
          network: 'restricted',
          allow: ['allowed.test'],
        }),
      ).rejects.toThrow(/explicit owner restart required/)
      expect(await lookup(owner(name))).toBe(id)
      expect(
        await docker(['inspect', '--format', '{{.State.Running}}', id]),
      ).toBe('false')
      expect(
        await readFile(
          join(dir.path, 'environments', owner(name), 'workspace', 'note'),
          'utf8',
        ),
      ).toBe('off fixture')
    },
    240000,
  )

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
      if (!running) await docker(['stop', '--timeout', '1', id])
      await expect(open('reopen-failure')).rejects.toThrow(
        /EEXIST:.*mkdir '\/tmp\/vela-home'/,
      )
      expect(
        await docker(['inspect', '--format', '{{.State.Running}}', id]),
      ).toBe(String(running))
    }
  }, 240000)

  test('failed preflight removes a newly created owned container', async () => {
    const name = 'create-failure'
    const file = join(dir.path, 'home-conflict')
    await Bun.write(file, 'fixture')
    await expect(
      prepareDocker(config(name), async (args) => {
        const result = await docker(args)
        // Seed the fresh container's filesystem before first start, keeping the same offline image.
        if (args[0] === 'create')
          await docker(['cp', file, `${result}:/tmp/vela-home`])
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
        docker(['volume', 'ls', '-q', '--filter', `name=^${volume}$`])
      await expect(
        prepareDocker(options, async (args) => {
          const result = await docker(args)
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
