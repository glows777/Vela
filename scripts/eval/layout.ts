/** Revision-local paths: immutable flat snapshots, multi-package and single-package layouts share one worker. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
export function runtimePaths(runtime: string) {
  const multiPackage = existsSync(join(runtime, 'packages/core/package.json'))
  const singlePackage =
    !multiPackage && existsSync(join(runtime, 'packages/vela/package.json'))
  const workspace = multiPackage || singlePackage
  const tsPaths = ts.readConfigFile(
    join(runtime, 'tsconfig.json'),
    ts.sys.readFile,
  ).config?.compilerOptions?.paths
  const source = singlePackage
    ? tsPaths?.['@glows777/vela']?.[0] === './packages/vela/src/index.ts'
    : multiPackage &&
      tsPaths?.['@glows777/vela-core']?.[0] === './packages/core/src/index.ts'
  const path = (flat: string, multi: string, single: string) => {
    const selected = singlePackage ? single : multiPackage ? multi : flat
    return workspace && source
      ? selected.replace('/dist/', '/src/').replace(/\.js$/, '.ts')
      : selected
  }
  const lark = existsSync(join(runtime, 'test/support/lark.ts'))
  // A session transcript moved into `<id>/transcript.jsonl` (#267); older snapshots keep `<id>.jsonl`
  const storage = [
    'packages/vela/src/driver/session/storage.ts',
    'packages/vela/dist/driver/session/storage.js',
    'packages/core/src/session/storage.ts',
    'packages/core/dist/session/storage.js',
    'src/session/storage.ts',
  ]
    .map((p) => join(runtime, p))
    .find((p) => existsSync(p))
  const sessionDirectory =
    storage !== undefined &&
    readFileSync(storage, 'utf8').includes('transcript.jsonl')
  const sqliteStore = [
    'packages/vela/src/driver/session/db-store.ts',
    'packages/vela/dist/driver/session/db-store.js',
  ]
    .map((p) => join(runtime, p))
    .find((p) => existsSync(p))
  const sqliteSessions = sqliteStore !== undefined
  const fileToolPath = [
    'packages/vela/src/driver/tools/file.ts',
    'packages/vela/dist/driver/tools/file.js',
    'packages/core/src/tools/file.ts',
    'packages/core/dist/tools/file.js',
    'src/tools/file.ts',
  ]
    .map((p) => join(runtime, p))
    .find((p) => existsSync(p))
  const usesPiCoreToolNames =
    fileToolPath !== undefined &&
    /name:\s*['"]read['"]/.test(readFileSync(fileToolPath, 'utf8'))
  return {
    channelName: lark ? ('lark' as const) : ('feishu' as const),
    sqliteSessions,
    usesPiCoreToolNames,
    /** The transcript path of a session id, relative to the sessions directory. */
    sessionTranscript: (id: string) =>
      sqliteSessions
        ? '../vela.db'
        : sessionDirectory
          ? `${id}/transcript.jsonl`
          : `${id}.jsonl`,
    helpers: `test/support/${lark ? 'lark' : 'feishu'}.ts`,
    workspace,
    source,
    testing: path(
      'src/testing/test-vela.ts',
      'packages/vela/dist/testing/index.js',
      'packages/vela/dist/testing/index.js',
    ),
    models: path(
      'src/config/models.ts',
      'packages/core/dist/config/models.js',
      'packages/vela/dist/providers/models-config.js',
    ),
    channelTesting: path(
      'src/channels/testing.ts',
      'packages/channels/dist/testing.js',
      'packages/vela/dist/legacy-channels/testing.js',
    ),
    legacyVela: 'src/vela.ts',
    web: path(
      'src/extensions/web/index.ts',
      'packages/core/dist/extensions/web/index.js',
      'packages/vela/dist/driver/extensions/web/index.js',
    ),
    todo: path(
      'src/extensions/todo/index.ts',
      'packages/core/dist/extensions/todo/index.js',
      'packages/vela/dist/driver/extensions/todo/index.js',
    ),
    lark: path(
      'src/extensions/feishu/index.ts',
      'packages/lark/dist/index.js',
      'packages/vela/dist/lark/index.js',
    ),
    channelId: path(
      'src/channels/session-id.ts',
      'packages/channels/dist/session-id.js',
      'packages/vela/dist/legacy-channels/session-id.js',
    ),
    scope: path(
      'src/channels/scope.ts',
      'packages/channels/dist/scope.js',
      'packages/vela/dist/legacy-channels/scope.js',
    ),
    memoryStore: path(
      'src/extensions/memory/store.ts',
      'packages/core/dist/extensions/memory/store.js',
      'packages/vela/dist/driver/extensions/memory/store.js',
    ),
  }
}
