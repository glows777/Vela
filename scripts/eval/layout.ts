/** Revision-local paths: immutable flat snapshots and the workspace layout share one worker. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
export function runtimePaths(runtime: string) {
  const workspace = existsSync(join(runtime, 'packages/core/package.json'))
  const source =
    workspace &&
    ts.readConfigFile(join(runtime, 'tsconfig.json'), ts.sys.readFile).config
      ?.compilerOptions?.paths?.['@glows777/vela-core']?.[0] ===
      './packages/core/src/index.ts'
  const path = (flat: string, current: string) =>
    !workspace
      ? flat
      : source
        ? current.replace('/dist/', '/src/').replace(/\.js$/, '.ts')
        : current
  const lark = existsSync(join(runtime, 'test/support/lark.ts'))
  // A session transcript moved into `<id>/transcript.jsonl` (#267); older snapshots keep `<id>.jsonl`
  const storage = [
    'packages/core/src/session/storage.ts',
    'packages/core/dist/session/storage.js',
    'src/session/storage.ts',
  ]
    .map((path) => join(runtime, path))
    .find((path) => existsSync(path))
  const sessionDirectory =
    storage !== undefined &&
    readFileSync(storage, 'utf8').includes('transcript.jsonl')
  return {
    channelName: lark ? ('lark' as const) : ('feishu' as const),
    /** The transcript path of a session id, relative to the sessions directory. */
    sessionTranscript: (id: string) =>
      sessionDirectory ? `${id}/transcript.jsonl` : `${id}.jsonl`,
    helpers: `test/support/${lark ? 'lark' : 'feishu'}.ts`,
    workspace,
    source,
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
    todo: path(
      'src/extensions/todo/index.ts',
      'packages/core/dist/extensions/todo/index.js',
    ),
    lark: path('src/extensions/feishu/index.ts', 'packages/lark/dist/index.js'),
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
