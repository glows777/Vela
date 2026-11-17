import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createLocalExecutionEnv } from '@glows777/vela-core'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'

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
