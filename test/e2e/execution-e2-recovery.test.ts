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
