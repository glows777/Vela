import { expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { createLocalExecutionEnv, loadConfig } from '@glows777/vela-core'
import { inspectSession } from '@glows777/vela-core/diagnostics'

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'an unreadable workspace skill reports its path and leaves the session and neighboring skill usable',
  async () => {
    const dir = tempDir()
    const warnings: string[] = []
    for (const name of ['broken', 'working']) {
      const base = join(dir.path, '.vela/skills', name)
      mkdirSync(base, { recursive: true })
      writeFileSync(
        join(base, 'SKILL.md'),
        `---\nname: ${name}\ndescription: test ${name}\n---\nbody`,
      )
    }
    const bad = join(dir.path, '.vela/skills/broken/SKILL.md')
    chmodSync(bad, 0o000)
    const model = createFauxModel({ responses: [fauxText('ok')] })
    const vela = createVela({
      cwd: dir.path,
      model,
      logger: { ...console, warn: (message) => warnings.push(message) },
    })
    try {
      await vela.session('skills').prompt('hi')
      expect(model.calls[0]!.system).toContain('test working')
      expect(model.calls[0]!.system).not.toContain('test broken')
      expect(warnings.join(' ')).toContain(bad)
    } finally {
      await vela.dispose()
      dir.cleanup()
    }
  },
)

test('a first turn cannot omit workspace instructions while its environment is offline and retries once available', async () => {
  const dir = tempDir()
  writeFileSync(join(dir.path, 'AGENTS.md'), 'mandatory workspace context')
  let online = false
  const model = createFauxModel({ responses: [fauxText('ok')] })
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) =>
      online ? createLocalExecutionEnv({ cwd: location.cwd }) : undefined,
  })
  try {
    const session = vela.session('unavailable')
    await expect(session.prompt('hi')).rejects.toThrow('unavailable')
    expect(model.calls).toHaveLength(0)
    online = true
    await session.prompt('hi')
    expect(model.calls[0]!.system).toContain('mandatory workspace context')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('a throwing user bash progress callback does not interrupt the command', async () => {
  const dir = tempDir()
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [] }),
  })
  try {
    let updates = 0
    const result = await vela
      .session('progress')
      .executeBash('printf first; sleep 0.3; printf last', {
        onUpdate: () => {
          updates++
          throw new Error('view disconnected')
        },
      })
    expect(updates).toBeGreaterThan(0)
    expect(result).toMatchObject({ output: 'firstlast', exitCode: 0 })
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('read_file uses the selected execution environment instead of reading the host', async () => {
  const dir = tempDir()
  writeFileSync(join(dir.path, 'marker.txt'), 'host-only marker')
  const model = createFauxModel({
    responses: [
      fauxToolCall('read_file', { path: 'marker.txt' }),
      fauxText('done'),
    ],
  })
  let reads = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.openBinaryReader = async () => {
        reads++
        return {
          ok: false,
          error: Object.assign(new Error('environment denied read'), {
            code: 'permission_denied' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela.session('boundary').prompt('read marker')
    expect(reads).toBe(1)
    expect(model.calls[1]!.toolResults[0]!.output).not.toContain(
      'host-only marker',
    )
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('write_file does not write to the host when its environment denies the write', async () => {
  const dir = tempDir()
  const model = createFauxModel({
    responses: [
      fauxToolCall('write_file', {
        path: 'forbidden.txt',
        content: 'host side effect',
      }),
      fauxText('done'),
    ],
  })
  let writes = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.writeFile = async () => {
        writes++
        return {
          ok: false,
          error: Object.assign(new Error('environment denied write'), {
            code: 'permission_denied' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela.session('boundary-write').prompt('write a file')
    expect(writes).toBe(1)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir.path, 'forbidden.txt'))).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('write_file can update its own new file under a symlinked workspace directory', async () => {
  const dir = tempDir()
  mkdirSync(join(dir.path, 'actual'))
  symlinkSync(join(dir.path, 'actual'), join(dir.path, 'linked'), 'dir')
  const path = 'linked/new/note.txt'
  const model = createFauxModel({
    responses: [
      fauxToolCall('write_file', { path, content: 'first' }),
      fauxToolCall('write_file', { path, content: 'second' }),
      fauxToolCall('write_file', {
        path: 'actual/new/note.txt',
        content: 'third',
      }),
      fauxText('done'),
    ],
  })
  const vela = createVela({ cwd: dir.path, model })
  try {
    await vela.session('write-through-link').prompt('create and revise note')
    expect(model.calls[2]!.toolResults.at(-1)!.output).toContain('Wrote')
    expect(readFileSync(join(dir.path, path), 'utf8')).toBe('third')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('edit_file leaves the host untouched when its environment refuses edits', async () => {
  const dir = tempDir()
  const file = join(dir.path, 'edit.txt')
  writeFileSync(file, 'original')
  const model = createFauxModel({
    responses: [
      fauxToolCall('edit_file', {
        path: 'edit.txt',
        edits: [{ oldText: 'original', newText: 'changed' }],
      }),
      fauxText('done'),
    ],
  })
  let reads = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.readTextFile = async () => {
        reads++
        return {
          ok: false,
          error: Object.assign(new Error('environment denied edit'), {
            code: 'permission_denied' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela.session('boundary-edit').prompt('edit it')
    expect(reads).toBe(1)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(file, 'utf8')).toBe('original')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('list_directory uses the selected environment instead of listing the host', async () => {
  const dir = tempDir()
  writeFileSync(join(dir.path, 'private.txt'), 'host only')
  const model = createFauxModel({
    responses: [
      fauxToolCall('list_directory', { path: '.' }),
      fauxText('done'),
    ],
  })
  let listings = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.listDir = async () => {
        listings++
        return {
          ok: false,
          error: Object.assign(new Error('environment denied listing'), {
            code: 'permission_denied' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela
      .session('boundary-list', { tools: ['+list_directory'] })
      .prompt('list files')
    expect(listings).toBe(1)
    expect(model.calls[1]!.toolResults[0]!.output).not.toContain('private.txt')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('bash never starts a host command when its environment denies execution', async () => {
  const dir = tempDir()
  const marker = join(dir.path, 'bash-host-marker')
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'touch bash-host-marker' }),
      fauxText('done'),
    ],
  })
  let execs = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.exec = async () => {
        execs++
        return {
          ok: false,
          error: Object.assign(new Error('environment unavailable'), {
            code: 'unavailable' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela.session('boundary-bash').prompt('run bash')
    expect(execs).toBe(1)
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('default local bash keeps spilled output under the session result root', async () => {
  const dir = tempDir()
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: "printf '%060000d' 0" }),
      fauxText('done'),
    ],
  })
  const vela = createVela({ cwd: dir.path, dataDir: '.data', model })
  try {
    await vela.session('spill-location').prompt('generate output')
    const output = String(model.calls[1]!.toolResults[0]!.output)
    const path = output.match(/Full output: ([^\]\n]+)/)?.[1]
    expect(path).toBeDefined()
    expect(
      path!.startsWith(
        vela.session('spill-location').registry.results.dir + '/',
      ),
    ).toBe(true)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('user bash cannot execute on host when the selected environment rejects it', async () => {
  const dir = tempDir()
  const marker = join(dir.path, 'user-bash-host-marker')
  let execs = 0
  const vela = createVela({
    cwd: dir.path,
    model: createFauxModel({ responses: [] }),
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.exec = async () => {
        execs++
        return {
          ok: false,
          error: Object.assign(new Error('environment unavailable'), {
            code: 'unavailable' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await expect(
      vela
        .session('user-bash-boundary')
        .executeBash('touch user-bash-host-marker'),
    ).rejects.toThrow('environment unavailable')
    expect(execs).toBe(1)
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('default session environment preserves login-shell invocation for model and user bash', async () => {
  const { chmodSync } = await import('node:fs')
  const dir = tempDir()
  const shell = join(dir.path, 'shell')
  writeFileSync(shell, '#!/bin/sh\nprintf "%s" "$1"\n')
  chmodSync(shell, 0o755)
  const model = createFauxModel({
    responses: [fauxToolCall('bash', { command: 'ignored' }), fauxText('done')],
  })
  const vela = createVela({ cwd: dir.path, shellPath: shell, model })
  try {
    const session = vela.session('login-shell')
    await session.prompt('run')
    expect(model.calls[1]!.toolResults[0]!.output).toBe('-lc')
    expect((await session.executeBash('ignored')).output).toBe('-lc')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('grep uses the execution environment instead of host search', async () => {
  const dir = tempDir()
  writeFileSync(join(dir.path, 'secret.txt'), 'host-secret-token')
  const model = createFauxModel({
    responses: [
      fauxToolCall('grep', { pattern: 'host-secret-token', path: '.' }),
      fauxText('done'),
    ],
  })
  let execs = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.exec = async () => {
        execs++
        return {
          ok: false,
          error: Object.assign(new Error('environment denied search'), {
            code: 'unavailable' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela.session('grep-boundary', { tools: ['+grep'] }).prompt('search')
    expect(execs).toBe(1)
    expect(model.calls[1]!.toolResults[0]!.output).not.toContain(
      'host-secret-token',
    )
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('grep and find preserve nested relative paths when a search root is a directory symlink', async () => {
  const dir = tempDir()
  mkdirSync(join(dir.path, 'actual', 'nested'), { recursive: true })
  writeFileSync(join(dir.path, 'actual/nested/hit.txt'), 'needle')
  symlinkSync(join(dir.path, 'actual'), join(dir.path, 'linked'), 'dir')
  const model = createFauxModel({
    responses: [
      fauxToolCall('grep', { pattern: 'needle', path: 'linked' }),
      fauxToolCall('find', { pattern: 'hit.txt', path: 'linked' }),
      fauxText('done'),
    ],
  })
  const vela = createVela({ cwd: dir.path, model })
  try {
    await vela
      .session('search-link', { tools: ['+grep', '+find'] })
      .prompt('search linked')
    expect(model.calls[1]!.toolResults[0]!.output).toContain(
      'nested/hit.txt:1: needle',
    )
    expect(model.calls[2]!.toolResults.at(-1)!.output).toContain(
      'nested/hit.txt',
    )
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('grep returns real local matches and context through the selected environment', async () => {
  const dir = tempDir()
  writeFileSync(join(dir.path, 'notes.txt'), 'before\nneedle here\nafter\n')
  const model = createFauxModel({
    responses: [
      fauxToolCall('grep', { pattern: 'needle', path: '.', context: 1 }),
      fauxText('done'),
    ],
  })
  const vela = createVela({ cwd: dir.path, model })
  try {
    await vela.session('grep-real', { tools: ['+grep'] }).prompt('search')
    const output = String(model.calls[1]!.toolResults[0]!.output)
    expect(output).toContain('notes.txt:2: needle here')
    expect(output).toContain('notes.txt-1- before')
    expect(output).toContain('notes.txt-3- after')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('find does not run the host binary when the selected environment rejects execution', async () => {
  const { chmodSync, existsSync } = await import('node:fs')
  const dir = tempDir()
  const fd = join(dir.path, 'fd')
  const marker = join(dir.path, 'fd-host-marker')
  writeFileSync(fd, '#!/bin/sh\ntouch "' + marker + '"\n')
  chmodSync(fd, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${dir.path}:${previous ?? ''}`
  const model = createFauxModel({
    responses: [fauxToolCall('find', { pattern: '*' }), fauxText('done')],
  })
  let execs = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.exec = async () => {
        execs++
        return {
          ok: false,
          error: Object.assign(new Error('environment denied find'), {
            code: 'unavailable' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela.session('find-boundary', { tools: ['+find'] }).prompt('find')
    expect(execs).toBe(1)
    expect(existsSync(marker)).toBe(false)
  } finally {
    process.env.PATH = previous
    await vela.dispose()
    dir.cleanup()
  }
})

test('background commands use their session environment, not host spawn', async () => {
  const { existsSync } = await import('node:fs')
  const { background } = await import(
    '../../packages/core/src/extensions/background/index.ts'
  )
  const dir = tempDir()
  const marker = join(dir.path, 'bg-host-marker')
  const model = createFauxModel({
    responses: [
      fauxToolCall('background_start', { command: 'touch bg-host-marker' }),
      fauxText('done'),
      fauxText('failure received'),
    ],
  })
  let execs = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    extensions: [background()],
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      env.exec = async () => {
        execs++
        return {
          ok: false,
          error: Object.assign(new Error('environment denied background'), {
            code: 'unavailable' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela
      .session('bg-boundary', { tools: ['+background_start'] })
      .prompt('start')
    await Bun.sleep(80)
    expect(execs).toBe(1)
    expect(existsSync(marker)).toBe(false)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('model and user bash report partial effects on a real local spill failure', async () => {
  const { createSessionLocalExecutionEnv } = await import(
    '../../packages/core/src/execution/local.ts'
  )
  const { readFileSync } = await import('node:fs')
  const dir = tempDir()
  const root = join(dir.path, 'blocked-root')
  writeFileSync(root, 'ordinary file')
  const command = 'echo started >> runs; seq 1 2100'
  const model = createFauxModel({
    responses: [fauxToolCall('bash', { command }), fauxText('stopped')],
  })
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) =>
      createSessionLocalExecutionEnv({ cwd: location.cwd, tempRoot: root }),
  })
  try {
    const session = vela.session('failed-spill')
    await session.prompt('run once')
    expect(model.calls[1]!.toolResults[0]!.output).toContain(
      'Do not automatically rerun',
    )
    await expect(session.executeBash(command)).rejects.toThrow(
      'may have had partial effects',
    )
    expect(readFileSync(join(dir.path, 'runs'), 'utf8')).toBe(
      'started\nstarted\n',
    )
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('oversized tool output is saved through the session environment', async () => {
  const { default: z } = await import('zod')
  const dir = tempDir()
  const model = createFauxModel({
    responses: [fauxToolCall('extension-1_large_report', {}), fauxText('done')],
  })
  let writes = 0
  let removals = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    extensions: [
      (api) => {
        api.registerTool({
          name: 'large_report',
          description: 'test',
          inputSchema: z.object({}),
          maxResultChars: 100,
          execute: async () => 'report-data'.repeat(100),
        })
      },
    ],
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      const remove = env.remove.bind(env)
      env.remove = async (...args) => {
        removals++
        return remove(...args)
      }
      env.writeFile = async () => {
        writes++
        return {
          ok: false,
          error: Object.assign(new Error('storage denied'), {
            code: 'permission_denied' as const,
          }),
        }
      }
      return env
    },
  })
  try {
    await vela.session('report-boundary').prompt('report')
    expect(writes).toBe(1)
    expect(removals).toBe(1)
    const output = String(model.calls[1]!.toolResults[0]!.output)
    expect(output).toContain('could not be saved')
    expect(output).not.toContain('Full output:')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('execution environment publishes a complete file by rename and removes staging on failure', async () => {
  const dir = tempDir()
  const env = createLocalExecutionEnv({ cwd: dir.path })
  try {
    expect((await env.writeFile('draft.part', 'complete')).ok).toBe(true)
    expect((await env.renameFile('draft.part', 'published.txt')).ok).toBe(true)
    expect(await env.readTextFile('published.txt')).toEqual({
      ok: true,
      value: 'complete',
    })
    expect((await env.remove('draft.part', { force: true })).ok).toBe(true)
    expect((await env.remove('published.txt', { force: true })).ok).toBe(true)
    expect(await env.exists('published.txt')).toEqual({
      ok: true,
      value: false,
    })
  } finally {
    await env.cleanup()
    dir.cleanup()
  }
})

test.each([false, true])(
  'memory session clone retains private spilled bash output after parent closes (custom local factory %p)',
  async (custom) => {
    const { memorySessionStorage } = await import('@glows777/vela-core')
    const { readFileSync } = await import('node:fs')
    const dir = tempDir()
    const vela = createVela({
      cwd: dir.path,
      env: custom
        ? ({ location }) => createLocalExecutionEnv({ cwd: location.cwd })
        : undefined,
      dataDir: '.data',
      sessionStorage: memorySessionStorage(),
      model: createFauxModel({ responses: [] }),
    })
    try {
      const parent = vela.session('parent-spill')
      const result = await parent.executeBash("printf '%060000d' 0")
      expect(result.fullOutputPath).toBeDefined()
      expect(
        result.fullOutputPath!.startsWith(parent.registry.results.dir + '/'),
      ).toBe(true)
      if (process.platform !== 'win32') {
        const { statSync } = await import('node:fs')
        expect(statSync(result.fullOutputPath!).mode & 0o777).toBe(0o600)
      }
      const child = (await parent.clone({ sessionId: 'child-spill' })).session!
      const blob = JSON.stringify(child.messages)
      const path = blob.match(/Full output: ([^\]\\]+)/)?.[1]
      expect(path).toBeDefined()
      await parent.close()
      expect(readFileSync(path!, 'utf8')).toHaveLength(60000)
    } finally {
      await vela.dispose()
      dir.cleanup()
    }
  },
)

test('microcompaction stores recoverable tool output in the session environment', async () => {
  const dir = tempDir()
  for (let i = 0; i < 8; i++)
    writeFileSync(
      join(dir.path, `file-${i}.txt`),
      `file ${i}\n` + 'content '.repeat(1400),
    )
  const model = createFauxModel({
    responses: [
      ...Array.from({ length: 8 }, (_, i) =>
        fauxToolCall('read_file', { path: `file-${i}.txt` }),
      ),
      fauxText('done'),
    ],
  })
  let allocations = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    limits: {
      microcompactThreshold: 1,
      minMicroSavings: 1,
      summaryThreshold: 1e9,
    },
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      const create = env.createTempFile.bind(env)
      env.createTempFile = async (...args) => {
        allocations++
        return create(...args)
      }
      return env
    },
  })
  try {
    await vela.session('micro-boundary').prompt('read all')
    expect(JSON.stringify(model.calls.at(-1)!.prompt)).toContain(
      'tool result preview omitted',
    )
    expect(allocations).toBeGreaterThan(0)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test.each(['missing', 'directory'])(
  'an instruction override linked to a %s target allows the regular AGENTS.md to load',
  async (target) => {
    const dir = tempDir()
    const destination = join(dir.path, target)
    if (target === 'directory') mkdirSync(destination)
    symlinkSync(destination, join(dir.path, 'AGENTS.override.md'), 'dir')
    writeFileSync(join(dir.path, 'AGENTS.md'), 'FALLBACK_INSTRUCTIONS')
    const model = createFauxModel({ responses: [fauxText('done')] })
    const vela = createVela({ cwd: dir.path, model })
    try {
      await vela.session('linked-instructions').prompt('hello')
      expect(model.calls[0]!.system).toContain('FALLBACK_INSTRUCTIONS')
    } finally {
      await vela.dispose()
      dir.cleanup()
    }
  },
)

test('workspace AGENTS instructions come from the selected session environment', async () => {
  const dir = tempDir()
  writeFileSync(join(dir.path, 'AGENTS.md'), 'HOST_CONTEXT_ONLY')
  const model = createFauxModel({ responses: [fauxText('done')] })
  let reads = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      const read = env.readTextFile.bind(env)
      env.readTextFile = async (path, signal) => {
        if (path.endsWith('/AGENTS.md')) {
          reads++
          return { ok: true, value: 'ENV_CONTEXT_ONLY' }
        }
        return read(path, signal)
      }
      return env
    },
  })
  try {
    await vela.session('context-boundary').prompt('hello')
    expect(reads).toBeGreaterThan(0)
    expect(model.calls[0]!.system).toContain('ENV_CONTEXT_ONLY')
    expect(model.calls[0]!.system).not.toContain('HOST_CONTEXT_ONLY')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('workspace skill metadata comes from the selected session environment', async () => {
  const dir = tempDir()
  const skill = join(dir.path, '.skills', 'example')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: example\ndescription: HOST_SKILL_ONLY\n---\nHost body',
  )
  const model = createFauxModel({ responses: [fauxText('done')] })
  let reads = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      const read = env.readTextFile.bind(env)
      env.readTextFile = async (path, signal) => {
        if (path.endsWith('/.skills/example/SKILL.md')) {
          reads++
          return {
            ok: true,
            value:
              '---\nname: example\ndescription: ENV_SKILL_ONLY\n---\nEnv body',
          }
        }
        return read(path, signal)
      }
      return env
    },
  })
  try {
    await vela.session('skill-boundary').prompt('hello')
    expect(reads).toBeGreaterThan(0)
    expect(model.calls[0]!.system).toContain('ENV_SKILL_ONLY')
    expect(model.calls[0]!.system).not.toContain('HOST_SKILL_ONLY')
    model.push(fauxText('done'))
    await vela.session('skill-boundary').prompt('/skill:example extra')
    expect(model.calls[1]!.lastUserText).toContain('Env body')
    expect(model.calls[1]!.lastUserText).not.toContain('Host body')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('explicit host skills remain available alongside another session workspace', async () => {
  const dir = tempDir()
  const host = join(dir.path, 'host')
  const workspace = join(dir.path, 'workspace')
  mkdirSync(join(host, 'shared'), { recursive: true })
  mkdirSync(join(workspace, '.skills', 'local'), { recursive: true })
  writeFileSync(
    join(host, 'shared', 'SKILL.md'),
    '---\nname: shared\ndescription: Explicit host skill\n---\nShared body',
  )
  writeFileSync(
    join(workspace, '.skills', 'local', 'SKILL.md'),
    '---\nname: local\ndescription: Workspace skill\n---\nLocal body',
  )
  const model = createFauxModel({ responses: [fauxText('done')] })
  const vela = createVela({ cwd: dir.path, model, skillDirs: [host] })
  try {
    await vela
      .session('explicit-and-workspace', { cwd: workspace })
      .prompt('hello')
    expect(model.calls[0]!.system).toContain('Explicit host skill')
    expect(model.calls[0]!.system).toContain('Workspace skill')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('workspace prompt template comes from the selected session environment', async () => {
  const dir = tempDir()
  const prompts = join(dir.path, '.vela', 'prompts')
  mkdirSync(prompts, { recursive: true })
  writeFileSync(join(prompts, 'hello.md'), 'HOST_TEMPLATE_ONLY')
  const model = createFauxModel({ responses: [fauxText('done')] })
  let reads = 0
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      const read = env.readTextFile.bind(env)
      env.readTextFile = async (path, signal) => {
        if (path.endsWith('/.vela/prompts/hello.md')) {
          reads++
          return { ok: true, value: 'ENV_TEMPLATE_ONLY $1' }
        }
        return read(path, signal)
      }
      return env
    },
  })
  try {
    await vela.session('template-boundary').prompt('/hello world')
    expect(reads).toBeGreaterThan(0)
    expect(model.calls[0]!.lastUserText).toContain('ENV_TEMPLATE_ONLY world')
    expect(model.calls[0]!.lastUserText).not.toContain('HOST_TEMPLATE_ONLY')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('CLI config keeps user instructions host-side but reads workspace instructions from env', async () => {
  const dir = tempDir()
  const workspace = join(dir.path, 'workspace')
  const agentDir = join(dir.path, 'agent')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'AGENTS.md'), 'USER_INSTRUCTIONS')
  writeFileSync(join(workspace, 'AGENTS.md'), 'HOST_WORKSPACE_INSTRUCTIONS')
  const config = loadConfig({ cwd: workspace, agentDir, trusted: true })
  const model = createFauxModel({ responses: [fauxText('done')] })
  const vela = createVela({
    cwd: workspace,
    model,
    sessionResources: structuredClone(config.sessionResources),
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      const read = env.readTextFile.bind(env)
      env.readTextFile = async (path, signal) =>
        path === join(workspace, 'AGENTS.md')
          ? { ok: true, value: 'ENV_WORKSPACE_INSTRUCTIONS' }
          : read(path, signal)
      return env
    },
  })
  try {
    await vela.session('cli-resources').prompt('hello')
    expect(model.calls[0]!.system).toContain('USER_INSTRUCTIONS')
    expect(model.calls[0]!.system).toContain('ENV_WORKSPACE_INSTRUCTIONS')
    expect(model.calls[0]!.system).not.toContain('HOST_WORKSPACE_INSTRUCTIONS')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('untrusted CLI workspace does not load workspace skills or templates', async () => {
  const dir = tempDir()
  const workspace = join(dir.path, 'workspace')
  const agentDir = join(dir.path, 'agent')
  mkdirSync(join(workspace, '.skills', 'untrusted'), { recursive: true })
  mkdirSync(join(workspace, '.vela', 'prompts'), { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(workspace, '.skills', 'untrusted', 'SKILL.md'),
    '---\nname: untrusted\ndescription: UNTRUSTED_SKILL\n---\nUntrusted body',
  )
  writeFileSync(
    join(workspace, '.vela', 'prompts', 'untrusted.md'),
    'UNTRUSTED_TEMPLATE',
  )
  const config = loadConfig({ cwd: workspace, agentDir, trusted: false })
  const model = createFauxModel({ responses: [fauxText('done')] })
  const vela = createVela({
    cwd: workspace,
    model,
    sessionResources: structuredClone(config.sessionResources),
  })
  try {
    await vela.session('untrusted').prompt('/untrusted')
    expect(model.calls[0]!.system).not.toContain('UNTRUSTED_SKILL')
    expect(model.calls[0]!.lastUserText).toBe('/untrusted')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('trusted CLI workspace loads its skills and templates through env', async () => {
  const dir = tempDir()
  const workspace = join(dir.path, 'workspace')
  const agentDir = join(dir.path, 'agent')
  mkdirSync(join(workspace, '.skills', 'project'), { recursive: true })
  mkdirSync(join(workspace, '.vela', 'prompts'), { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(workspace, '.skills', 'project', 'SKILL.md'),
    '---\nname: project\ndescription: PROJECT_SKILL\n---\nProject body',
  )
  writeFileSync(
    join(workspace, '.vela', 'prompts', 'project.md'),
    'PROJECT_TEMPLATE',
  )
  const config = loadConfig({ cwd: workspace, agentDir, trusted: true })
  const model = createFauxModel({ responses: [fauxText('done')] })
  const vela = createVela({
    cwd: workspace,
    model,
    sessionResources: structuredClone(config.sessionResources),
  })
  try {
    await vela.session('trusted').prompt('/project')
    expect(model.calls[0]!.system).toContain('PROJECT_SKILL')
    expect(model.calls[0]!.lastUserText).toBe('PROJECT_TEMPLATE')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('trusted workspace discovers ancestor .agents skills through the environment up to git root', async () => {
  const dir = tempDir()
  const root = join(dir.path, 'project')
  const workspace = join(root, 'nested')
  const agentDir = join(dir.path, 'agent')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.agents', 'skills', 'parent'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(root, '.agents', 'skills', 'parent', 'SKILL.md'),
    '---\nname: parent\ndescription: PARENT_SKILL\n---\nParent body',
  )
  const config = loadConfig({ cwd: workspace, agentDir, trusted: true })
  const model = createFauxModel({ responses: [fauxText('done')] })
  const vela = createVela({
    cwd: workspace,
    model,
    sessionResources: structuredClone(config.sessionResources),
  })
  try {
    await vela.session('ancestor').prompt('hello')
    expect(model.calls[0]!.system).toContain('PARENT_SKILL')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('workspace skill discovery follows symlinks and tolerates malformed neighbors', async () => {
  const dir = tempDir()
  const realSkill = join(dir.path, 'shared-skill')
  const skills = join(dir.path, '.skills')
  mkdirSync(realSkill, { recursive: true })
  mkdirSync(skills, { recursive: true })
  writeFileSync(
    join(realSkill, 'SKILL.md'),
    '---\nname: linked\ndescription: LINKED_SKILL\n---\nLinked body',
  )
  writeFileSync(join(skills, 'bad.md'), '---\ninvalid: [\n---\nno')
  symlinkSync(realSkill, join(skills, 'link'), 'dir')
  const model = createFauxModel({ responses: [fauxText('done')] })
  const vela = createVela({ cwd: dir.path, model })
  try {
    await vela.session('linked-skills').prompt('hello')
    expect(model.calls[0]!.system).toContain('LINKED_SKILL')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('overlapping session inspections and subsequent wakes share one workspace prompt', async () => {
  const dir = tempDir()
  const instructions = join(dir.path, 'AGENTS.md')
  writeFileSync(instructions, 'cache fixture')
  let loads = 0
  const model = createFauxModel({
    responses: [fauxText('one'), fauxText('two')],
  })
  const vela = createVela({
    cwd: dir.path,
    model,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      const read = env.readTextFile.bind(env)
      env.readTextFile = (path, signal) => {
        if (path === instructions) loads++
        return read(path, signal)
      }
      return env
    },
  })
  try {
    const session = vela.session('inspection')
    const [first, second] = await Promise.all([
      inspectSession(vela, session),
      inspectSession(vela, session),
    ])
    await session.prompt('one')
    await session.prompt('two')
    expect(first.systemPrompt).toBe(second.systemPrompt)
    expect(model.calls[0]!.system).toBe(model.calls[1]!.system)
    expect(loads).toBe(1)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('a workspace prompt template can link to a shared Markdown file', async () => {
  const dir = tempDir()
  const prompts = join(dir.path, '.vela', 'prompts')
  mkdirSync(prompts, { recursive: true })
  const target = join(dir.path, 'shared.md')
  writeFileSync(target, 'Shared prompt for $1')
  symlinkSync(target, join(prompts, 'review.md'))
  const model = createFauxModel({ responses: [fauxText('done')] })
  const vela = createVela({ cwd: dir.path, model })
  try {
    await vela.session('linked-template').prompt('/review code')
    expect(model.calls[0]!.lastUserText).toBe('Shared prompt for code')
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})
