import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import {
  createServer as createHttpsServer,
  request as requestHttps,
} from 'node:https'
import { join } from 'node:path'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { buildDockerAdapter } from '../../extensions/docker/build.ts'
import { createCredentialIdentity } from '../../extensions/docker/credential-identity.ts'
import { openCredentialProxy } from '../../extensions/docker/credential-proxy.ts'
import { openGuestHttpsRouter } from '../../extensions/docker/guest-https-router.ts'
import { prepareDocker } from '../../extensions/docker/lifecycle.ts'
import { dockerOperations } from '../../extensions/docker/operations.ts'
import {
  createVela,
  type ExecutionEnv,
  type Result,
} from '../../packages/vela/src/driver/index.ts'

describe.skipIf(process.platform === 'win32')('Docker adapter', () => {
  const ownerTest = test.skipIf(
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
      !process.getuid?.() ||
      !process.getgid?.(),
  )
  let dir: ReturnType<typeof tempDir>
  const operations: string[] = []
  let resultRoot: string
  let env: ExecutionEnv
  function value<T>(r: Result<T, Error>): T {
    if (!r.ok) throw r.error
    return r.value
  }

  beforeAll(async () => {
    dir = tempDir()
    resultRoot = join(dir.path, 'results')
    await buildDockerAdapter(dir.path)
    const guest = readFileSync(join(dir.path, 'guest.cjs'), 'utf8')
    // Exercise the identical per-operation guest offline. Docker lifecycle is tested separately.
    env = dockerOperations('offline-guest', dir.path, (op, cwd) => {
      operations.push(op)
      return spawn('node', ['-e', guest, '--', op, cwd, resultRoot], {
        cwd: dir.path,
        env: { PATH: process.env.PATH, HOME: dir.path },
        stdio: 'pipe',
      })
    })
  })
  afterAll(async () => {
    await env?.cleanup()
    dir.cleanup()
  })

  test('the installed adapter rejects invalid restricted owner policy before touching Docker', async () => {
    const { openDockerEnvironment } = (await import(
      join(dir.path, 'adapter.mjs')
    )) as typeof import('../../extensions/docker/adapter.ts')
    const defaults = {
      dataDir: join(dir.path, 'unused-owner'),
      name: 'test',
      image: 'node:22-bookworm',
    }
    const network = 'restricted' as const
    for (const mode of ['on', 'off'] as const)
      await expect(
        openDockerEnvironment({
          ...defaults,
          network: mode,
          allow: ['one.test'],
        }),
      ).rejects.toThrow(/allow.*only valid.*restricted/)
    await expect(
      openDockerEnvironment({ ...defaults, network, allow: [] }),
    ).rejects.toThrow(/non-empty allow/)
    for (const host of ['127.0.0.1', '*.test', 'one.test:443', 'one.test/path'])
      await expect(
        openDockerEnvironment({ ...defaults, network, allow: [host] }),
      ).rejects.toThrow(/exact DNS hosts/)
    await expect(
      openDockerEnvironment({
        ...defaults,
        network,
        allow: ['one.test'],
        credentials: [
          {
            variable: 'FIXTURE_TOKEN',
            value: 'synthetic-value',
            origins: ['https://two.test'],
          },
        ],
      }),
    ).rejects.toThrow(/origins.*restricted allow list/)
    if (process.platform !== 'linux')
      await expect(
        openDockerEnvironment({ ...defaults, network, allow: ['one.test'] }),
      ).rejects.toThrow(/Linux host/)
    expect(existsSync(defaults.dataDir)).toBe(false)
  })

  test.skipIf(process.platform !== 'linux')(
    'the restricted HTTPS route is scoped and fails closed without Docker',
    async () => {
      const hosts = ['one.test', 'two.test']
      const identity = await createCredentialIdentity(hosts)
      const upstreamIdentity = await createCredentialIdentity(['localhost'])
      const seen: (string | undefined)[] = []
      const upstream = createHttpsServer(upstreamIdentity, (req, res) => {
        seen.push(req.headers.authorization)
        res.end('fixture')
      })
      const { port } = await new Promise<{ port: number }>(
        (resolve, reject) => {
          upstream.once('error', reject)
          upstream.listen(0, '127.0.0.1', () => {
            const address = upstream.address()
            if (!address || typeof address === 'string')
              reject(Error('No fixture port'))
            else resolve(address)
          })
        },
      )
      const socket = join(dir.path, 'review-proxy.sock')
      try {
        const proxy = await openCredentialProxy({
          socketPath: socket,
          allowedHosts: hosts,
          identity,
          credentials: [
            {
              placeholder: 'synthetic-placeholder',
              value: 'synthetic-secret',
              origins: ['https://one.test'],
            },
          ],
          upstreamRequest: (options, callback) =>
            requestHttps(
              {
                ...options,
                hostname: '127.0.0.1',
                port,
                ca: upstreamIdentity.ca,
                servername: 'localhost',
              },
              callback,
            ),
        })
        try {
          const guest = await openGuestHttpsRouter({ socket }, [])
          const trust = join(dir.path, 'restricted-fixture-ca.pem')
          try {
            await writeFile(trust, identity.ca)
            async function curl(host: string, headers?: string) {
              const result = spawn(
                'curl',
                [
                  '--silent',
                  '--show-error',
                  '--noproxy',
                  '',
                  '--max-time',
                  '3',
                  '--proxy',
                  guest.url,
                  '--cacert',
                  trust,
                  '--write-out',
                  '%{http_connect}',
                  ...(headers ? ['--header', headers] : []),
                  `https://${host}/`,
                ],
                { stdio: ['ignore', 'pipe', 'ignore'] },
              )
              let body = ''
              result.stdout!.setEncoding('utf8')
              result.stdout!.on('data', (chunk) => {
                body += chunk
              })
              await new Promise<void>((resolve, reject) => {
                result.once('error', reject)
                result.once('close', () => resolve())
              })
              return body
            }
            expect(
              await curl(
                'one.test',
                'Authorization: Bearer synthetic-placeholder',
              ),
            ).toBe('fixture200')
            expect(await curl('two.test')).toBe('fixture200')
            expect(await curl('denied.test')).toBe('403')
            expect(await curl('one.test:8443')).toBe('403')
            expect(seen).toEqual(['Bearer synthetic-secret', undefined])
            await proxy.close()
            expect(await curl('one.test')).toBe('502')
            expect(seen).toHaveLength(2)
          } finally {
            await guest.close()
          }
        } finally {
          await proxy.close()
        }
      } finally {
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    },
  )

  test('guest exec receives its placeholder and public CA for one operation', async () => {
    const guest = readFileSync(join(dir.path, 'guest.cjs'), 'utf8')
    const fixture = {
      publicCa: 'synthetic public CA marker',
      proxyUrl: 'http://host.docker.internal:19443',
      origins: ['https://github.com'],
      placeholders: { GH_TOKEN: 'vela-synthetic-placeholder' },
      githubGit: true,
    }
    const isolated = dockerOperations('credential-guest', dir.path, (op, cwd) =>
      spawn(
        'node',
        ['-e', guest, '--', op, cwd, resultRoot, JSON.stringify(fixture)],
        {
          cwd: dir.path,
          env: { PATH: process.env.PATH, HOME: dir.path },
          stdio: 'pipe',
        },
      ),
    )
    try {
      let output = ''
      await writeFile(
        join(dir.path, 'git-trust.pem'),
        'synthetic Git CA marker',
      )
      const script =
        'const e=process.env; const read=(p)=>require("node:fs").readFileSync(p,"utf8"); console.log(JSON.stringify([e.GH_TOKEN,e.HTTPS_PROXY,e.SSL_CERT_FILE,read(e.SSL_CERT_FILE),e.GIT_SSL_CAINFO,read(e.GIT_SSL_CAINFO)]))'
      const result = value(
        await isolated.exec([process.execPath, '-e', script], {
          env: { GIT_SSL_CAINFO: 'git-trust.pem' },
          onOutput(text, _signal, { stream }) {
            if (stream === 'stdout') output += text
          },
        }),
      )
      expect(result.exitCode).toBe(0)
      const [token, proxy, file, ca, gitFile, gitCa] = JSON.parse(output)
      expect(token).toBe(fixture.placeholders.GH_TOKEN)
      expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
      expect(ca).toContain('-----BEGIN CERTIFICATE-----')
      expect(ca).toContain(fixture.publicCa)
      expect(file).toContain('vela-credential-ca-')
      expect(gitFile).not.toBe(file)
      expect(gitCa).toContain(fixture.publicCa)
      expect(gitCa).toContain('synthetic Git CA marker')
      expect(ca).not.toContain('synthetic Git CA marker')
      for (let n = 0; n < 50 && existsSync(file); n++) await Bun.sleep(10)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(gitFile)).toBe(false)
    } finally {
      await isolated.cleanup()
    }
  })

  test('installed guest preserves ordinary TLS and mediates only configured synthetic credentials', async () => {
    const guest = readFileSync(join(dir.path, 'guest.cjs'), 'utf8')
    const mediation = await createCredentialIdentity([
      'github.com',
      'other.example',
    ])
    const ordinary = await createCredentialIdentity(['localhost'])
    const seen: Array<string | undefined> = []
    const ordinarySeen: Array<string | undefined> = []
    const upstream = createHttpsServer(ordinary, (incoming, outgoing) => {
      seen.push(incoming.headers.authorization)
      outgoing.end('mediated')
    })
    const normal = createHttpsServer(ordinary, (incoming, outgoing) => {
      ordinarySeen.push(incoming.headers.authorization)
      outgoing.end('ordinary')
    })
    const listen = (server: typeof upstream | typeof normal) =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          const info = server.address()
          if (info && typeof info === 'object') resolve(info.port)
        }),
      )
    const upPort = await listen(upstream)
    const normalPort = await listen(normal)
    const trustFile = join(dir.path, 'ordinary-ca.pem')
    const beta = 'synthetic-other-placeholder'
    const alpha = 'synthetic-github-placeholder'
    const secret = 'synthetic-github-value'
    await writeFile(trustFile, ordinary.ca)
    const proxy = await openCredentialProxy({
      listenHost: '127.0.0.1',
      identity: mediation,
      credentials: [
        { origins: ['https://github.com'], placeholder: alpha, value: secret },
        {
          origins: ['https://other.example'],
          placeholder: beta,
          value: 'synthetic-other-value',
        },
      ],
      upstreamRequest: (options, callback) =>
        requestHttps(
          {
            ...options,
            hostname: '127.0.0.1',
            port: upPort,
            ca: ordinary.ca,
            servername: 'localhost',
          },
          callback,
        ),
    })
    const fixture = {
      publicCa: mediation.ca,
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      origins: ['https://github.com', 'https://other.example'],
      placeholders: { GH_TOKEN: alpha },
      githubGit: true,
    }
    const isolated = dockerOperations(
      'credential-routing',
      dir.path,
      (op, cwd) =>
        spawn(
          'node',
          ['-e', guest, '--', op, cwd, resultRoot, JSON.stringify(fixture)],
          {
            cwd: dir.path,
            env: {
              PATH: process.env.PATH,
              HOME: dir.path,
              SSL_CERT_FILE: trustFile,
            },
            stdio: 'pipe',
          },
        ),
    )
    try {
      const fetch = async (
        url: string,
        authorization?: string,
        direct = false,
      ) => {
        let output = ''
        const result = value(
          await isolated.exec(
            [
              'curl',
              '--silent',
              '--show-error',
              '--fail',
              '--noproxy',
              direct ? '*' : '',
              '--max-time',
              '4',
              ...(authorization
                ? ['--header', `Authorization: ${authorization}`]
                : []),
              url,
            ],
            {
              onOutput(text) {
                output += text
              },
            },
          ),
        )
        expect(output).toBe(url.includes('localhost') ? 'ordinary' : 'mediated')
        expect(result.exitCode).toBe(0)
      }
      await fetch(`https://localhost:${normalPort}/`)
      await fetch(`https://localhost:${normalPort}/`, `Bearer ${alpha}`)
      await fetch(`https://localhost:${normalPort}/`, undefined, true)
      let helperOutput = ''
      const helper = value(
        await isolated.exec(
          "printf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill",
          {
            onOutput(text, _signal, { stream }) {
              if (stream === 'stdout') helperOutput += text
            },
          },
        ),
      )
      expect(helper.exitCode).toBe(0)
      expect(helperOutput).toContain('username=x-access-token\n')
      expect(helperOutput).toContain(`password=${alpha}\n`)
      await fetch('https://github.com/', `Bearer ${alpha}`)
      await fetch('https://github.com/', `token ${alpha}`)
      await fetch(
        'https://github.com/',
        `Basic ${Buffer.from(`x-access-token:${alpha}`).toString('base64')}`,
      )
      await fetch('https://other.example/', `Bearer ${alpha}`)
      expect(ordinarySeen).toEqual([undefined, `Bearer ${alpha}`, undefined])
      expect(seen).toEqual([
        `Bearer ${secret}`,
        `token ${secret}`,
        `Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}`,
        `Bearer ${alpha}`,
      ])
    } finally {
      await isolated.cleanup()
      await proxy.close()
      await Promise.all([
        new Promise<void>((done) => upstream.close(() => done())),
        new Promise<void>((done) => normal.close(() => done())),
      ])
    }
  })

  test('one transient discovery reads workspace instructions, skills and templates; a warm wake opens no guest', async () => {
    for (const name of ['alpha', 'beta', 'gamma']) {
      const path = join(dir.path, '.skills', name)
      await mkdir(path, { recursive: true })
      await writeFile(
        join(path, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} fixture\n---\nbody`,
      )
    }
    await writeFile(join(dir.path, 'AGENTS.md'), 'guest instruction')
    const prompts = join(dir.path, '.vela/prompts')
    await mkdir(prompts, { recursive: true })
    await writeFile(join(prompts, 'check.md'), 'check fixture')
    const model = createFauxModel({
      cache: true,
      responses: [fauxText('one'), fauxText('two')],
    })
    const vela = createVela({
      model,
      dataDir: join(dir.path, 'data'),
      env: () => env,
    })
    try {
      const s = vela.session('resources', {
        location: { cwd: dir.path, environment: 'guest' },
      })
      operations.length = 0
      await s.prompt('cold')
      const inventory = await s.resources()
      expect(inventory.contextFiles.map((f) => f.content)).toContain(
        'guest instruction',
      )
      expect(inventory.skills.map((s) => s.name)).toEqual([
        'alpha',
        'beta',
        'gamma',
      ])
      expect(inventory.promptTemplates.map((t) => t.name)).toEqual(['check'])
      expect(operations).toEqual(['discoverWorkspace'])
      operations.length = 0
      await s.prompt('warm')
      expect(operations).toEqual([])
      expect(model.calls[1]!.system).toBe(model.calls[0]!.system)
    } finally {
      await vela.dispose()
    }
  }, 60000)

  test('one binary reader keeps its open file for ranges, scans and metadata across replacement', async () => {
    const original = `${'A'.repeat(65535)}一\ntwo🙂\n末`
    value(await env.writeFile('page', original))
    const reader = value(await env.openBinaryReader('page', { noFollow: true }))
    try {
      expect(value(await reader.read(0, 65536))).toEqual(
        new TextEncoder().encode(original).slice(0, 65536),
      )
      value(await env.writeFile('new', 'new'))
      value(await env.renameFile('new', 'page'))
      expect(value(await reader.info()).size).toBe(65550)
      expect(
        value(await reader.scanLines({ startLine: 1, endLine: 2 })),
      ).toEqual({
        newlines: 2,
        start: 65539,
        end: 65546,
        selectedBytes: 7,
        firstLineEnd: 65546,
        lastLineStart: 65539,
        firstLineBytes: 7,
      })
      expect(new TextDecoder().decode(value(await reader.read(65539, 7)))).toBe(
        'two🙂',
      )
      expect(value(await reader.read(65550, 8))).toHaveLength(0)
    } finally {
      await reader.close()
    }
    expect(await reader.info()).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    expect(value(await env.readTextFile('page'))).toBe('new')
    await symlink('page', join(dir.path, 'link'))
    expect(
      await env.openBinaryReader('link', { noFollow: true }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
  })

  test('file operations return environment paths, raw bytes, temp files and typed failures', async () => {
    value(await env.createDir('nested', {}))
    const tmp = value(
      await env.createTempFile({ prefix: 'case-', suffix: '.bin' }),
    )
    expect(tmp.startsWith(`${resultRoot}/case-`)).toBe(true)
    value(await env.writeFile(tmp, Uint8Array.of(0, 255, 128)))
    expect(value(await env.readBinaryFile(tmp))).toEqual(
      Uint8Array.of(0, 255, 128),
    )
    expect(value(await env.joinPath(['nested', 'file']))).toBe('nested/file')
    expect(value(await env.absolutePath('~/a'))).toBe(join(dir.path, 'a'))
    expect(value(await env.canonicalPath('nested'))).toBe(
      join(dir.path, 'nested'),
    )
    expect(value(await env.listDir(resultRoot)).map((f) => f.path)).toEqual([
      tmp,
    ])
    expect(value(await env.fileInfo(tmp)).size).toBe(3)
    value(await env.remove(tmp, {}))
    expect(value(await env.exists(tmp))).toBe(false)
    expect(await env.readTextFile(tmp)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  test.each(['abort', 'timeout', 'callback', 'cleanup'] as const)(
    'foreground %s stops the ready ordinary child',
    async (mode) => {
      const marker = `marker-${mode}`
      const controller = new AbortController()
      const ready = Promise.withResolvers<void>()
      const run = env.exec(
        ['sh', '-c', `(echo ready; sleep 0.8; touch "${marker}") & wait`],
        {
          timeout: mode === 'timeout' ? 0.4 : undefined,
          onOutput(text) {
            if (text.includes('ready')) {
              ready.resolve()
              if (mode === 'callback') throw Error('observer failed')
            }
          },
        },
        controller.signal,
      )
      await ready.promise
      if (mode === 'abort') controller.abort()
      if (mode === 'cleanup') await env.cleanup()
      const result = await run
      expect(result).toMatchObject({
        ok: false,
        error: {
          code:
            mode === 'timeout'
              ? 'timeout'
              : mode === 'callback'
                ? 'callback_error'
                : 'aborted',
        },
      })
      await Bun.sleep(900)
      expect(existsSync(join(dir.path, marker))).toBe(false)
    },
  )

  test('command argv, streams, working directory, nonzero exits and complete spill', async () => {
    let out = '',
      err = ''
    value(await env.createDir('command-cwd', {}))
    const result = value(
      await env.exec(
        [
          'node',
          '-e',
          'process.stdout.write(process.argv[1]);process.stderr.write(process.cwd());process.exitCode=7',
          '--',
          'a ; $HOME',
        ],
        {
          cwd: 'command-cwd',
          spill: { afterBytes: 1, afterLines: 20 },
          onOutput(t, _s, { stream }) {
            if (stream === 'stdout') out += t
            else err += t
          },
        },
      ),
    )
    expect(result.exitCode).toBe(7)
    expect(out).toBe('a ; $HOME')
    expect(err).toBe(join(dir.path, 'command-cwd'))
    const log = value(await env.readTextFile(result.spillPath!))
    expect(log).toContain(out)
    expect(log).toContain(err)
    expect(await env.exec('true', { cwd: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'spawn_error' },
    })
  })
  ownerTest(
    'owner lifecycle fails before engine access for invalid config and propagates unavailable engine',
    async () => {
      const root = join(dir.path, 'owner')
      await mkdir(root)
      let calls = 0
      const down = async () => {
        calls++
        throw Error('engine offline')
      }
      const options = {
        dataDir: root,
        name: 'group',
        image: 'node:22-bookworm',
        network: 'off' as const,
      }
      await expect(
        prepareDocker({ ...options, image: '' }, down),
      ).rejects.toThrow('image')
      await expect(
        prepareDocker({ ...options, network: 'allowlist' as 'off' }, down),
      ).rejects.toThrow('network')
      expect(calls).toBe(0)
      await expect(prepareDocker(options, down)).rejects.toThrow(
        'engine offline',
      )
      expect(calls).toBeGreaterThan(0)
    },
  )

  ownerTest(
    'an owner reuses only the matching labeled container and rejects drift before exec',
    async () => {
      const dataDir = join(dir.path, 'lifecycle')
      await mkdir(dataDir)
      const options = {
        dataDir,
        name: 'test',
        network: 'off' as const,
        image: 'node:22-bookworm',
      }
      const id = '1'.repeat(64)
      let state: Record<string, unknown> | undefined
      let missingTools = ''
      let creates = 0,
        starts = 0,
        prepares = 0
      const engine = async (args: string[]) => {
        const get = (key: string) => args[args.indexOf(key) + 1]!
        if (args[0] === 'ps') return state ? id : ''
        if (args[0] === 'create') {
          creates++
          expect(args).toContain('--pull=never')
          expect(get('--network')).toBe('none')
          const labels = Object.fromEntries(
            args.flatMap((v, i) =>
              v === '--label' ? [args[i + 1]!.split('=')] : [],
            ),
          )
          const mount = get('--mount')
            .split(',')
            .find((x) => x.startsWith('src='))!
            .slice(4)
          state = {
            Id: id,
            Config: {
              Labels: labels,
              Image: options.image,
              User: get('--user'),
            },
            Mounts: [
              {
                Type: 'bind',
                Source: mount,
                Destination: '/workspace',
                RW: true,
              },
            ],
            HostConfig: { NetworkMode: 'none', Privileged: false },
            State: { Running: false },
          }
          return id
        }
        if (args[0] === 'inspect') return JSON.stringify([state])
        if (args[0] === 'start') {
          starts++
          state!.State = { Running: true }
          return id
        }
        if (args[0] === 'stop') {
          expect(args.at(-1)).toBe(id)
          state!.State = { Running: false }
          return id
        }
        if (args[0] === 'exec') {
          prepares++
          return missingTools
        }
        throw Error(`unexpected ${args[0]}`)
      }
      const first = await prepareDocker(options, engine)
      expect(await prepareDocker(options, engine)).toEqual(first)
      expect([creates, starts, prepares]).toEqual([1, 1, 2])
      const changed = () =>
        prepareDocker({ ...options, image: 'other' }, engine)
      await expect(changed()).rejects.toThrow()
      state!.State = { Running: false }
      missingTools = 'rg, fd'
      await expect(prepareDocker(options, engine)).rejects.toThrow(
        'Missing required Docker tools: rg, fd',
      )
      expect(state!.State).toEqual({ Running: false })
      state!.Mounts = []
      await expect(prepareDocker(options, engine)).rejects.toThrow()
      expect(prepares).toBe(3)
    },
  )

  test.skipIf(
    process.platform !== 'linux' || !process.getuid?.() || !process.getgid?.(),
  )(
    'a restricted allowlist change refuses the existing named container before start',
    async () => {
      const id = '3'.repeat(64)
      const options = {
        dataDir: join(dir.path, 'restricted-lifecycle'),
        name: 'fixture',
        image: 'node:22-bookworm',
        network: 'restricted' as const,
        allow: ['one.test'],
      }
      const transport = {
        directory: join(dir.path, 'engine-proxy-fixture'),
        socket: '/vela-egress/fixture.sock',
      }
      let state: Record<string, unknown> | undefined
      const calls: string[] = []
      const engine = async (args: string[]) => {
        const get = (key: string) => args[args.indexOf(key) + 1]!
        const entries = (key: string) =>
          args.flatMap((value, index) =>
            value === key ? [args[index + 1]!] : [],
          )
        calls.push(args[0]!)
        if (args[0] === 'ps') return state ? id : ''
        if (args[0] === 'create') {
          expect(get('--network')).toBe('none')
          state = {
            Id: id,
            Config: {
              Labels: Object.fromEntries(
                entries('--label').map((entry) => entry.split('=')),
              ),
              User: get('--user'),
              Image: options.image,
            },
            HostConfig: { NetworkMode: 'none', Privileged: false },
            State: { Running: false },
            Mounts: entries('--mount').map((entry) => {
              const [, source, destination, readonly] = entry.split(',')
              return {
                Type: 'bind',
                Source: source?.slice(4),
                Destination: destination?.slice(4),
                RW: !readonly,
              }
            }),
          }
          return id
        }
        if (args[0] === 'inspect') return JSON.stringify([state])
        if (args[0] === 'start' || args[0] === 'exec') return ''
        throw Error('Unexpected engine mutation')
      }
      expect((await prepareDocker(options, engine, transport)).id).toBe(id)
      calls.length = 0
      await expect(
        prepareDocker({ ...options, allow: ['two.test'] }, engine, transport),
      ).rejects.toThrow(/explicit owner restart required/)
      expect(calls).toEqual(['ps', 'inspect'])
    },
  )

  test('the SDK rejects adapters that do not match the requested cwd or local identity', async () => {
    const { createVela } = await import('@glows777/vela')
    const { createFauxModel, fauxText } = await import('@glows777/vela/testing')
    const model = createFauxModel({ responses: [fauxText('unexpected')] })
    const vela = createVela({
      dataDir: join(dir.path, 'sdk-config'),
      cwd: dir.path,
      model,
      env: () => env,
    })
    try {
      const wrong = vela.session('docker', {
        location: { environment: 'docker-test', cwd: '/different-cwd' },
      })
      await expect(wrong.prompt('test')).rejects.toThrow('unavailable')
      await expect(vela.session('local').prompt('test')).rejects.toThrow(
        'unavailable',
      )
      expect(model.calls).toHaveLength(0)
    } finally {
      await vela.dispose()
    }
  })

  test('the adapter preserves valid open-ended scans and returns an unavailable result for a lost transport', async () => {
    value(await env.writeFile('open-ended', 'one\ntwo'))
    const reader = value(await env.openBinaryReader('open-ended', undefined))
    try {
      expect(
        await reader.scanLines({ startLine: 0, endLine: Infinity }),
      ).toEqual(await reader.scanLines({ startLine: 0 }))
    } finally {
      await reader.close()
    }
    const down = dockerOperations('unreachable', dir.path, () =>
      spawn(join(dir.path, 'nonexistent-client'), [], { stdio: 'pipe' }),
    )
    const marker = join(dir.path, 'transport-must-not-run')
    expect(await down.exec(['touch', marker], {})).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
    expect(existsSync(marker)).toBe(false)
    await down.cleanup()
  })
})
