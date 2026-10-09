import { spyOn } from 'bun:test'
import type { CommandContext } from '../../src/cli/commands/index.ts'
import { createCliDispatcher } from '../../src/cli/dispatcher.ts'
import {
  type TestVelaOptions as CoreTestVelaOptions,
  createTestVela as createCoreTestVela,
} from '../../src/testing/test-vela.ts'
import { velaInternals } from '../../src/vela.ts'

export {
  cleanupTestVelas,
  type FixtureSkill,
  tempDir,
} from '../../src/testing/test-vela.ts'

export type TestVelaOptions = CoreTestVelaOptions

/**
 * createTestVela() from vela/testing plus the CLI's slash command dispatcher:
 * tests use exactly the same command handling as the CLI, applied to the default session (`t.session`).
 */
export function createTestVela(options: TestVelaOptions = {}) {
  const t = createCoreTestVela(options)
  const internals = velaInternals(t.vela)

  const ctx: CommandContext = {
    vela: t.vela,
    internals,
    session: t.session,
    // Command output still goes to console.log; capture it with captureConsole()
    print: (text) => console.log(text),
  }
  const dispatch = createCliDispatcher(t.vela)

  return Object.assign(t, {
    /** createVela()'s internals (registry, memory, knowledge base, channel gateway…), for tests only */
    internals,
    ctx,
    /** Run a slash command; returns what the CLI dispatcher does: false / true / Promise (async command) */
    dispatch: (command: string) => dispatch(command, ctx),
    /** Run a slash command and wait for it; returns whether a handler claimed the command */
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
