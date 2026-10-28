/** Revision-local paths: immutable flat snapshots and the workspace layout share one worker. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
export function runtimePaths(runtime: string) {
  const workspace = existsSync(join(runtime, 'packages/core/package.json'))
  const path = (flat: string, current: string) => (workspace ? current : flat)
  return {
    workspace,
    testing: path(
      'src/testing/test-vela.ts',
      'packages/vela/dist/testing/index.js',
    ),
    models: path('src/config/models.ts', 'packages/core/dist/config/models.js'),
    channelTesting: path(
      'src/channels/testing.ts',
      'packages/channels/dist/testing.js',
    ),
    legacyVela: 'src/vela.ts',
    web: path(
      'src/extensions/web/index.ts',
      'packages/core/dist/extensions/web/index.js',
    ),
    feishu: path(
      'src/extensions/feishu/index.ts',
      'packages/lark/dist/index.js',
    ),
    channelId: path(
      'src/channels/session-id.ts',
      'packages/channels/dist/session-id.js',
    ),
    scope: path('src/channels/scope.ts', 'packages/channels/dist/scope.js'),
    memoryStore: path(
      'src/extensions/memory/store.ts',
      'packages/core/dist/extensions/memory/store.js',
    ),
  }
}
