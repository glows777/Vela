import { expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'

test('saved local execution location survives session restart and clone', async () => {
  const dir = tempDir()
  const workspace = join(dir.path, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'marker.txt'), 'workspace marker')
  const model = createFauxModel({ responses: [fauxText('ok')] })
  const vela = createVela({ cwd: dir.path, dataDir: '.data', model })
  try {
    const session = vela.session('location', {
      location: { environment: 'local', cwd: workspace },
    })
    await session.prompt('Remember this workspace')
    const header = JSON.parse(
      readFileSync(
        join(vela.dataDir, 'sessions/location/transcript.jsonl'),
        'utf8',
      ).split('\n')[0]!,
    )
    expect(header.location).toEqual({ environment: 'local', cwd: workspace })
    const cloned = (await session.clone({ sessionId: 'location-clone' }))
      .session!
    expect((await cloned.executeBash('cat marker.txt')).output).toBe(
      'workspace marker',
    )
    await session.close()
    const resumed = vela.session('location', {
      location: { environment: 'local', cwd: dir.path },
    })
    expect(await resumed.resume()).toBe(true)
    expect((await resumed.executeBash('cat marker.txt')).output).toBe(
      'workspace marker',
    )
    const cloneAfterResume = (
      await resumed.clone({ sessionId: 'resumed-clone' })
    ).session!
    expect((await cloneAfterResume.executeBash('cat marker.txt')).output).toBe(
      'workspace marker',
    )
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('nonlocal location cannot silently execute on the host before migration', () => {
  const dir = tempDir()
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [] }),
  })
  try {
    expect(() =>
      vela.session('remote', {
        location: { environment: 'remote', cwd: '/workspace' },
      }),
    ).toThrow()
  } finally {
    void vela.dispose()
    dir.cleanup()
  }
})

test('local execution environment reads, writes and executes within its cwd', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    expect((await env.writeFile('sample.txt', 'hello', undefined)).ok).toBe(
      true,
    )
    const text = await env.readTextFile('sample.txt', undefined)
    expect(text).toEqual({ ok: true, value: 'hello' })
    let output = ''
    const result = await env.exec(
      ['cat', 'sample.txt'],
      {
        onOutput: (chunk) => {
          output += chunk
        },
      },
      undefined,
    )
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } })
    expect(output).toBe('hello')
    const missing = await env.readTextFile('missing', undefined)
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } })
  } finally {
    await env.cleanup(undefined)
    dir.cleanup()
  }
})

test('new sessions persist their default local location', async () => {
  const dir = tempDir()
  const vela = createVela({
    cwd: dir.path,
    dataDir: '.data',
    model: createFauxModel({ responses: [fauxText('ok')] }),
  })
  try {
    await vela.session('default-location').prompt('hello')
    const header = JSON.parse(
      readFileSync(
        join(vela.dataDir, 'sessions/default-location/transcript.jsonl'),
        'utf8',
      ).split('\n')[0]!,
    )
    expect(header.location).toEqual({ environment: 'local', cwd: dir.path })
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('local environment spills complete output and distinguishes errors from exit codes', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    let output = ''
    const result = await env.exec(
      ['sh', '-c', 'printf abcdef; exit 7'],
      {
        spill: { afterBytes: 3, afterLines: 100 },
        onOutput: (chunk) => {
          output += chunk
        },
      },
      undefined,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.value.exitCode).toBe(7)
    expect(output).toBe('abcdef')
    expect(readFileSync(result.value.spillPath!, 'utf8')).toBe('abcdef')
    const aborted = new AbortController()
    aborted.abort()
    expect(
      await env.exec(['echo', 'never'], undefined, aborted.signal),
    ).toMatchObject({ ok: false, error: { code: 'aborted' } })
  } finally {
    await env.cleanup(undefined)
    dir.cleanup()
  }
})

test('local environment reports invalid reader operations without throwing', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    writeFileSync(join(dir.path, 'lines.txt'), 'one\ntwo\n')
    const result = await env.openBinaryReader('lines.txt', undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    const reader = result.value
    expect(await reader.read(-1, 1)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    expect(await reader.scanLines({ startLine: -1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    await reader.close()
    expect(await reader.info()).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    expect(await reader.read(0, 1)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('local shell aborts an in-flight process without replay', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const controller = new AbortController()
    const result = await env.exec(
      ['sh', '-c', 'printf started; sleep 10; printf late'],
      {
        onOutput: (chunk) => {
          if (chunk.includes('started')) controller.abort()
        },
      },
      controller.signal,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'aborted' } })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('line spill counts a trailing partial line', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const result = await env.exec(['sh', '-c', 'printf "a\\nb"'], {
      spill: { afterBytes: 100, afterLines: 1 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.value.spillPath).toBeDefined()
    expect(readFileSync(result.value.spillPath!, 'utf8')).toBe('a\nb')
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('local shell returns timeout and spawn failures as results', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    expect(
      await env.exec(['vela-missing-executable-123'], undefined),
    ).toMatchObject({ ok: false, error: { code: 'spawn_error' } })
    expect(
      await env.exec(['sh', '-c', 'sleep 10'], { timeout: 0.05 }),
    ).toMatchObject({ ok: false, error: { code: 'timeout' } })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('execution environment resolver is consulted for each tool call and fails closed', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { fauxToolCall } = await import('@glows777/vela/testing')
  const dir = tempDir()
  const calls: string[] = []
  writeFileSync(join(dir.path, 'secret.txt'), 'host marker')
  const model = createFauxModel({
    responses: [
      fauxToolCall('read', { path: 'secret.txt' }),
      fauxToolCall('read', { path: 'secret.txt' }),
      fauxText('done'),
    ],
  })
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ sessionId, location }) => {
      calls.push(`${sessionId}:${location.environment}`)
      // Prepare workspace resources, allow the first read, then take the environment offline.
      return calls.length <= 2
        ? createLocalExecutionEnv({ cwd: location.cwd })
        : undefined
    },
  })
  try {
    await vela.session('resolver').prompt('read twice')
    expect(calls).toEqual([
      'resolver:local',
      'resolver:local',
      'resolver:local',
    ])
    expect(model.calls[1]!.toolResults[0]!.output).toContain('host marker')
    expect(model.calls[2]!.toolResults[0]!.output).not.toContain('host marker')
    expect(model.calls[2]!.toolResults[0]!.output).toContain('unavailable')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('a missing resolver cannot run a user shell command on the host', async () => {
  const dir = tempDir()
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [] }),
    env: () => undefined,
  })
  try {
    await expect(
      vela.session('user-command').executeBash('touch should-not-exist'),
    ).rejects.toThrow('unavailable')
    expect(
      require('node:fs').existsSync(join(dir.path, 'should-not-exist')),
    ).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('a failing output callback aborts the command and returns callback_error', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const result = await env.exec(['sh', '-c', 'printf started; sleep 10'], {
      onOutput: () => {
        throw new Error('subscriber failed')
      },
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'callback_error' },
    })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('legacy session without location retains existing cwd fallback', async () => {
  const dir = tempDir()
  const workspace = join(dir.path, 'legacy')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'marker.txt'), 'legacy')
  writeFileSync(join(dir.path, 'marker.txt'), 'host')
  const vela = createVela({
    cwd: dir.path,
    dataDir: '.data',
    model: createFauxModel({ responses: [fauxText('ok')] }),
  })
  try {
    const session = vela.session('legacy', { cwd: workspace })
    await session.prompt('hello')
    await session.close()
    const transcript = join(vela.dataDir, 'sessions/legacy/transcript.jsonl')
    const lines = readFileSync(transcript, 'utf8').split('\n')
    const header = JSON.parse(lines[0]!)
    delete header.location
    lines[0] = JSON.stringify(header)
    writeFileSync(transcript, lines.join('\n'))
    const resumed = vela.session('legacy')
    expect(await resumed.resume()).toBe(true)
    expect((await resumed.executeBash('cat marker.txt')).output).toBe('host')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('local file operations follow the environment contract for directories and symlinks', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { symlinkSync } = await import('node:fs')
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    expect(await env.writeFile('nested/file.txt', 'contents')).toMatchObject({
      ok: true,
    })
    expect(await env.openBinaryReader('nested', undefined)).toMatchObject({
      ok: false,
      error: { code: 'is_directory' },
    })
    if (process.platform !== 'win32') {
      symlinkSync('nested/file.txt', join(dir.path, 'alias'))
      expect(
        await env.openBinaryReader('alias', { noFollow: true }),
      ).toMatchObject({ ok: false, error: { code: 'invalid' } })
    }
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('local directory creation defaults recursive and exists recognizes dangling symlinks', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { symlinkSync } = await import('node:fs')
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    expect(await env.createDir('a/b', undefined)).toMatchObject({ ok: true })
    if (process.platform !== 'win32') {
      symlinkSync('missing-target', join(dir.path, 'dangling'))
      expect(await env.exists('dangling')).toEqual({ ok: true, value: true })
    }
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('local temp file preserves the requested filename prefix and suffix', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { basename } = await import('node:path')
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const result = await env.createTempFile({
      prefix: 'trace-',
      suffix: '.log',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(basename(result.value)).toMatch(/^trace-.+\.log$/)
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test.skipIf(process.platform === 'win32')(
  'local listing skips unsupported file kinds',
  async () => {
    const { createLocalExecutionEnv } = await import(
      '../../packages/vela/src/driver/index.ts'
    )
    const dir = tempDir()
    const env = createLocalExecutionEnv({ cwd: dir.path })
    try {
      const made = await env.exec(['mkfifo', 'pipe'], undefined)
      expect(made.ok).toBe(true)
      writeFileSync(join(dir.path, 'file.txt'), 'ok')
      const result = await env.listDir('.')
      expect(result.ok).toBe(true)
      if (!result.ok) throw result.error
      expect(result.value.map((x) => x.name)).toEqual(['file.txt'])
    } finally {
      await env.cleanup()
      dir.cleanup()
    }
  },
)

test('local exec returns after the shell exits even if a background child retains stdout', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const started = Date.now()
    const result = await env.exec(['sh', '-c', 'sleep 2 &'], undefined)
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } })
    expect(Date.now() - started).toBeLessThan(1000)
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test.skipIf(process.platform === 'win32')(
  'local exists reports unsupported file kinds as invalid',
  async () => {
    const { createLocalExecutionEnv } = await import(
      '../../packages/vela/src/driver/index.ts'
    )
    const dir = tempDir()
    const env = createLocalExecutionEnv({ cwd: dir.path })
    try {
      expect((await env.exec(['mkfifo', 'pipe'], undefined)).ok).toBe(true)
      expect(await env.exists('pipe')).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      })
    } finally {
      await env.cleanup()
      dir.cleanup()
    }
  },
)

test('malformed stored locations fail closed instead of falling back to the host', async () => {
  const dir = tempDir()
  const vela = createVela({
    cwd: dir.path,
    dataDir: '.data',
    model: createFauxModel({ responses: [fauxText('ok')] }),
  })
  try {
    const initial = vela.session('malformed')
    await initial.prompt('hello')
    await initial.close()
    const transcript = join(vela.dataDir, 'sessions/malformed/transcript.jsonl')
    const lines = readFileSync(transcript, 'utf8').split('\n')
    const header = JSON.parse(lines[0]!)
    header.location = { environment: 'local' }
    lines[0] = JSON.stringify(header)
    writeFileSync(transcript, lines.join('\n'))
    const reopened = vela.session('malformed')
    await expect(reopened.resume()).rejects.toThrow('location')
    await expect(reopened.executeBash('touch must-not-run')).rejects.toThrow()
    expect(require('node:fs').existsSync(join(dir.path, 'must-not-run'))).toBe(
      false,
    )
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('local shell honors configured shell path and reports unavailable shell', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({
    cwd: dir.path,
    shellPath: '/missing-vela-shell',
  })
  try {
    const result = await env.exec('printf should-not-run', undefined)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'shell_unavailable' },
    })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('large shell output spills all bytes without truncation', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const result = await env.exec(
      ['sh', '-c', 'head -c 200000 /dev/zero | tr "\\000" x'],
      { spill: { afterBytes: 1024, afterLines: 100 } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(readFileSync(result.value.spillPath!).length).toBe(200000)
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('exported session JSONL keeps its execution location', async () => {
  const dir = tempDir()
  const workspace = join(dir.path, 'exported')
  mkdirSync(workspace)
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [fauxText('ok')] }),
  })
  try {
    const session = vela.session('export-location', {
      location: { environment: 'local', cwd: workspace },
    })
    await session.prompt('hello')
    const path = await session.exportJsonl('export-location.jsonl')
    const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!)
    expect(header.location).toEqual({ environment: 'local', cwd: workspace })
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('binary reader scans unicode line boundaries and preserves positional reads', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    writeFileSync(join(dir.path, 'unicode.txt'), '一\ntwo\n末')
    const opened = await env.openBinaryReader('unicode.txt', undefined)
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw opened.error
    const reader = opened.value
    expect(await reader.scanLines({ startLine: 1, endLine: 2 })).toMatchObject({
      ok: true,
      value: { newlines: 2, start: 4, end: 7, selectedBytes: 3 },
    })
    const bytes = await reader.read(4, 3)
    expect(bytes.ok).toBe(true)
    if (bytes.ok) expect(new TextDecoder().decode(bytes.value)).toBe('two')
    await reader.close()
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('a spill storage failure is distinguished from a callback failure', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    env.createTempFile = async () => ({
      ok: false,
      error: Object.assign(new Error('disk failure'), {
        code: 'unknown' as const,
      }),
    })
    const result = await env.exec(['sh', '-c', 'printf long-output; sleep 2'], {
      spill: { afterBytes: 1, afterLines: 100 },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown' } })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('local paths accept file URLs', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { pathToFileURL } = await import('node:url')
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    writeFileSync(join(dir.path, 'url.txt'), 'url content')
    expect(
      await env.readTextFile(pathToFileURL(join(dir.path, 'url.txt')).href),
    ).toEqual({ ok: true, value: 'url content' })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('a missing working directory is a spawn failure, not a missing shell', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const result = await env.exec('echo no', { cwd: 'missing-directory' })
    expect(result).toMatchObject({ ok: false, error: { code: 'spawn_error' } })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('local exec flushes an incomplete UTF-8 sequence when the shell exits', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    let output = ''
    const result = await env.exec(
      ['sh', '-c', "printf '\\342\\202'; sleep 2 &"],
      {
        onOutput: (text) => {
          output += text
        },
      },
    )
    expect(result.ok).toBe(true)
    expect(output).toBe('\uFFFD')
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('environment cleanup stops a command and its descendants', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { existsSync } = await import('node:fs')
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const run = env.exec(
      ['sh', '-c', '(sleep 0.4; touch should-not-exist) & echo ready; wait'],
      {
        onOutput: (text) => {
          if (text.includes('ready')) ready()
        },
      },
    )
    await started
    await env.cleanup()
    await run
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(existsSync(join(dir.path, 'should-not-exist'))).toBe(false)
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('closing a session while its environment resolves cannot start a user command', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { existsSync } = await import('node:fs')
  const dir = tempDir()
  let release!: (env: ReturnType<typeof createLocalExecutionEnv>) => void
  const pending = new Promise<ReturnType<typeof createLocalExecutionEnv>>(
    (resolve) => {
      release = resolve
    },
  )
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [] }),
    env: () => pending,
  })
  try {
    const session = vela.session('close-pending')
    const command = session.executeBash('touch must-not-exist')
    await session.close()
    release(createLocalExecutionEnv({ cwd: dir.path }))
    await expect(command).rejects.toThrow('closed')
    expect(existsSync(join(dir.path, 'must-not-exist'))).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('shell output is delivered before a slow spill file is created', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    const original = env.createTempFile.bind(env)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    env.createTempFile = async (options, signal) => {
      await gate
      return original(options, signal)
    }
    let output = ''
    const run = env.exec(['sh', '-c', 'printf hello'], {
      spill: { afterBytes: 1, afterLines: 10 },
      onOutput: (text) => {
        output += text
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const observedBeforeRelease = output
    release()
    await run
    expect(observedBeforeRelease).toBe('hello')
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('aborting while resolving a working directory never starts the command', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { existsSync } = await import('node:fs')
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = env.absolutePath.bind(env)
    env.absolutePath = async (path) => {
      await gate
      return original(path)
    }
    const controller = new AbortController()
    const run = env.exec(
      ['sh', '-c', 'touch must-not-exist'],
      { cwd: '.' },
      controller.signal,
    )
    controller.abort()
    release()
    expect(await run).toMatchObject({ ok: false, error: { code: 'aborted' } })
    expect(existsSync(join(dir.path, 'must-not-exist'))).toBe(false)
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test('aborting a user command while its environment resolves never runs it', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { existsSync } = await import('node:fs')
  const dir = tempDir()
  let release!: (env: ReturnType<typeof createLocalExecutionEnv>) => void
  const pending = new Promise<ReturnType<typeof createLocalExecutionEnv>>(
    (resolve) => {
      release = resolve
    },
  )
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [] }),
    env: () => pending,
  })
  try {
    const session = vela.session('abort-pending')
    const command = session.executeBash('touch must-not-exist')
    expect(session.isBashRunning).toBe(true)
    session.abortBash()
    release(createLocalExecutionEnv({ cwd: dir.path }))
    expect((await command).cancelled).toBe(true)
    expect(existsSync(join(dir.path, 'must-not-exist'))).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('immediately aborting a default user command prevents its side effect', async () => {
  const { existsSync } = await import('node:fs')
  const dir = tempDir()
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [] }),
  })
  try {
    const session = vela.session('abort-immediately')
    const command = session.executeBash('touch must-not-exist')
    session.abortBash()
    expect((await command).cancelled).toBe(true)
    expect(existsSync(join(dir.path, 'must-not-exist'))).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('local commands inherit and override the host environment only when requested', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  const key = 'VELA_EXEC_INHERIT_TEST'
  const previous = process.env[key]
  process.env[key] = 'inherited'
  const outputs: string[] = []
  try {
    const command = [
      process.execPath,
      '-e',
      `process.stdout.write(process.env.${key} || 'absent')`,
    ]
    for (const options of [
      {},
      { env: { [key]: 'override' } },
      { inheritEnv: false },
    ]) {
      let output = ''
      const result = await env.exec(command, {
        ...options,
        onOutput: (text) => {
          output += text
        },
      })
      expect(result.ok).toBe(true)
      outputs.push(output)
    }
    expect(outputs).toEqual(['inherited', 'override', 'absent'])
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
    await env.cleanup()
    dir.cleanup()
  }
})

test('stopping a model tool call does not wait for an unresolved environment', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { fauxToolCall } = await import('@glows777/vela/testing')
  const dir = tempDir()
  let release!: (env: ReturnType<typeof createLocalExecutionEnv>) => void
  let entered!: () => void
  const called = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<ReturnType<typeof createLocalExecutionEnv>>(
    (resolve) => {
      release = resolve
    },
  )
  let prepared = false
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({
      responses: [fauxToolCall('read', { path: 'marker' })],
    }),
    env: () => {
      if (!prepared) return createLocalExecutionEnv({ cwd: dir.path })
      entered()
      return pending
    },
  })
  try {
    const session = vela.session('stop-resolver')
    await session.resources()
    prepared = true
    const run = session.prompt('read')
    await called
    const stopped = session.abort()
    const result = await Promise.race([
      stopped.then(() => 'stopped'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('timeout'), 500),
      ),
    ])
    expect(result).toBe('stopped')
    release(createLocalExecutionEnv({ cwd: dir.path }))
    await run.catch(() => {})
  } finally {
    release(createLocalExecutionEnv({ cwd: dir.path }))
    await vela.dispose()
    dir.cleanup()
  }
})

test('cleanup stops a background descendant after its shell has exited', async () => {
  if (process.platform === 'win32') return
  const { createLocalExecutionEnv } = await import(
    '../../packages/vela/src/driver/index.ts'
  )
  const { existsSync } = await import('node:fs')
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    expect((await env.exec('(sleep 0.6; touch leaked) &', {})).ok).toBe(true)
    await env.cleanup()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(existsSync(join(dir.path, 'leaked'))).toBe(false)
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test.skipIf(process.platform === 'win32')(
  'cleanup reports a denied signal to a surviving group and can retry it',
  async () => {
    const { createLocalExecutionEnv } = await import(
      '../../packages/vela/src/driver/index.ts'
    )
    const dir = tempDir()
    const env = createLocalExecutionEnv({ cwd: dir.path })
    const kill = process.kill.bind(process)
    let pgid: number | undefined
    let attempts = 0
    const denied = Object.assign(new Error('group kill denied'), {
      code: 'EPERM',
    })
    const spy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === pgid && signal === 'SIGKILL' && ++attempts === 1) throw denied
      return kill(pid, signal)
    })
    try {
      const shell = await env.exec(
        ['sh', '-c', 'trap "" TERM; sleep 30 >/dev/null 2>&1 & echo $$'],
        {
          onOutput: (text) => {
            pgid = -Number(text.trim())
          },
        },
      )
      expect(shell.ok).toBe(true)
      expect(pgid).toBeLessThan(0)
      expect(kill(pgid!, 0)).toBe(true)
      await expect(env.cleanup()).rejects.toBe(denied)
      expect(kill(pgid!, 0)).toBe(true)
      await env.cleanup()
      expect(attempts).toBe(2)
    } finally {
      spy.mockRestore()
      if (pgid && attempts < 2) {
        try {
          kill(pgid, 'SIGKILL')
        } catch {}
      }
      dir.cleanup()
    }
  },
)
