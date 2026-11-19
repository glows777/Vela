import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { createVela, type ExecutionEnv, type Result } from '@glows777/vela-core'
import { buildDockerAdapter } from '../../extensions/docker/build.ts'
import { prepareDocker } from '../../extensions/docker/lifecycle.ts'
import { dockerOperations } from '../../extensions/docker/operations.ts'

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
