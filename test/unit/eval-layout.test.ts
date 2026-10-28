import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('eval retains flat historical paths and selects the new workspace layout', async () => {
  const { runtimePaths } = await import('../../scripts/eval/layout.ts')
  const root = await mkdtemp(join(tmpdir(), 'vela-layout-'))
  try {
    expect(runtimePaths(root).testing).toBe('src/testing/test-vela.ts')
    expect(runtimePaths(root).models).toBe('src/config/models.ts')
    await mkdir(join(root, 'packages/core'), { recursive: true })
    await Bun.write(join(root, 'packages/core/package.json'), '{}')
    expect(runtimePaths(root).testing).toBe(
      'packages/vela/dist/testing/index.js',
    )
    expect(runtimePaths(root).models).toBe(
      'packages/core/dist/config/models.js',
    )
    expect(runtimePaths(root).channelTesting).toBe(
      'packages/channels/dist/testing.js',
    )
    expect(runtimePaths(root).lark).toBe('packages/lark/dist/index.js')
    await Bun.write(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          paths: { '@glows777/vela-core': ['./packages/core/src/index.ts'] },
        },
      }),
    )
    expect(runtimePaths(root).source).toBe(true)
    expect(runtimePaths(root).testing).toBe(
      'packages/vela/src/testing/index.ts',
    )
    expect(runtimePaths(root).models).toBe('packages/core/src/config/models.ts')
    expect(runtimePaths(root).channelTesting).toBe(
      'packages/channels/src/testing.ts',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
