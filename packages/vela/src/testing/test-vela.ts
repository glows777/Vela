import {
  type VelaOptions as CoreVelaOptions,
  createVela,
  type Vela,
} from '../driver/index.ts'
import type { VelaExtension } from '../extension-api.ts'
import { defaultDocsPaths } from '../shared/docs-paths.ts'
import { resolveShellPath } from '../shared/shell-path.ts'
import {
  type TestVelaOptions as CoreOptions,
  type TestVela as CoreTestVela,
  createTestVela as createCoreTestVela,
} from './core/index.ts'

export {
  cleanupTestVelas,
  type FixtureSkill,
  tempDir,
} from './core/index.ts'

export interface TestVelaOptions extends Omit<CoreOptions, 'extensions'> {
  extensions?: VelaExtension[]
}

type TestVelaAssembler = (options: CoreVelaOptions) => Vela

/** Compatibility fixture retains memory extension. */
export function createTestVela(
  options: TestVelaOptions = {},
  assemble?: TestVelaAssembler,
): Omit<CoreTestVela, 'vela'> & { vela: Vela } {
  const { extensions, ...base } = options
  let vela!: Vela
  const create: TestVelaAssembler =
    assemble ??
    ((coreOptions) =>
      createVela({
        ...coreOptions,
        docs: coreOptions.docs ?? defaultDocsPaths(),
        shellPath:
          coreOptions.shellPath ??
          resolveShellPath(undefined, {
            platform: process.platform,
            env: process.env,
          }),
        extensions: [...(coreOptions.extensions ?? []), ...(extensions ?? [])],
      }))
  const fixture = createCoreTestVela(base, (coreOptions) => {
    vela = create(coreOptions)
    return vela
  })
  return fixture as Omit<typeof fixture, 'vela'> & { vela: Vela }
}
export type TestVela = ReturnType<typeof createTestVela>
