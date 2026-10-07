import { spyOn } from 'bun:test'
import type { CommandContext } from '../../src/cli/commands'
import { createCliDispatcher } from '../../src/cli/dispatcher'
import type { PluginDefinition } from '../../src/plugins/types'
import {
  createTestVela as createCoreTestVela,
  type TestVelaOptions as CoreTestVelaOptions,
} from '../../src/testing/test-vela'

export {
  cleanupTestVelas,
  type FixtureSkill,
  tempDir,
} from '../../src/testing/test-vela'

export interface TestVelaOptions extends CoreTestVelaOptions {
  /** 斜杠命令里可加载的插件，默认无 */
  plugins?: Map<string, PluginDefinition>
}

/**
 * vela/testing 的 createTestVela()，再加上 CLI 的斜杠命令分发器：
 * 测试用和 CLI 完全相同的命令处理，命令作用在默认会话（`t.session`）上。
 */
export function createTestVela(options: TestVelaOptions = {}) {
  const t = createCoreTestVela(options)

  let asks = 0
  let idleWaiters: (() => void)[] = []
  const ctx: CommandContext = {
    vela: t.vela,
    session: t.session,
    ask: () => {
      asks++
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) resolve()
    },
  }
  const dispatch = createCliDispatcher(t.vela, options.plugins ?? new Map())

  return Object.assign(t, {
    ctx,
    /** 执行斜杠命令；返回值同 CLI 分发器：true / false / 'async' */
    dispatch: (command: string) => dispatch(command, ctx),
    /** 执行斜杠命令并等它结束（异步命令等到它调用 ask()） */
    command: async (command: string) => {
      const before = asks
      const done = new Promise<void>((resolve) => idleWaiters.push(resolve))
      const result = dispatch(command, ctx)
      if (result === 'async' && asks === before) await done
      return result
    },
    askCount: () => asks,
  })
}

export type TestVela = ReturnType<typeof createTestVela>

/** 捕获 console.log / console.error 的输出，返回拼好的文本 */
export async function captureConsole<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; output: string }> {
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
