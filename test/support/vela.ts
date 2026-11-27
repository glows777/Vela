import { spyOn } from 'bun:test'
import {
  type TestVelaOptions as CoreTestVelaOptions,
  createTestVela as createCoreTestVela,
} from '@glows777/vela/testing'
import type { CommandContext } from '../../packages/vela/src/cli/commands/index.ts'
import { createCliDispatcher } from '../../packages/vela/src/cli/dispatcher.ts'
import type { InternalSessionOptions } from '../../packages/vela/src/driver/session/options.ts'
import { velaInternals } from './compat-vela.ts'
import { legacyVelaAsRuntime } from './legacy-vela-runtime.ts'

export {
  cleanupTestVelas,
  tempDir,
} from '@glows777/vela/testing'

export type TestVelaOptions = Omit<CoreTestVelaOptions, 'session'> & {
  session?: InternalSessionOptions
}

/**
 * createTestVela() from vela/testing plus the CLI's v0.9 Runtime adapter & slash command dispatcher.
 */
export function createTestVela(
  options: TestVelaOptions = {},
  assemble?: Parameters<typeof createCoreTestVela>[1],
) {
  const t = createCoreTestVela(options, assemble)
  const internals = velaInternals(t.vela)
  const { runtime, clientFor } = legacyVelaAsRuntime(t.vela)

  const ctx: CommandContext = {
    runtime,
    session: clientFor(t.session),
    print: (text) => console.log(text),
  }
  const dispatch = createCliDispatcher(runtime)

  return Object.assign(t, {
    internals,
    runtime,
    clientFor,
    ctx,
    dispatch: (command: string) => dispatch(command, ctx),
    command: async (command: string) => {
      const result = dispatch(command, ctx)
      if (result instanceof Promise) await result
      return result !== false
    },
  })
}

export type TestVela = ReturnType<typeof createTestVela>

/** Capture console.log / console.error output and return the joined text */
export async function captureConsole<T>(
  fn: () => T,
): Promise<{ result: Awaited<T>; output: string }> {
  const lines: string[] = []
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  const log = spyOn(console, 'log').mockImplementation(record)
  const error = spyOn(console, 'error').mockImplementation(record)
  try {
    const result = await fn()
    return { result, output: lines.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}
