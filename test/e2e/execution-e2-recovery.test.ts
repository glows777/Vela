import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { createLocalExecutionEnv } from '@glows777/vela-core'

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

test('memory session clone retains spilled user bash output after parent closes', async () => {
  const { memorySessionStorage } = await import('@glows777/vela-core')
  const { readFileSync } = await import('node:fs')
  const dir = tempDir()
  const vela = createVela({
    cwd: dir.path,
    dataDir: '.data',
    sessionStorage: memorySessionStorage(),
    model: createFauxModel({ responses: [] }),
  })
  try {
    const parent = vela.session('parent-spill')
    const result = await parent.executeBash("printf '%060000d' 0")
    expect(result.fullOutputPath).toBeDefined()
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
})

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
