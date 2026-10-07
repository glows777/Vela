import { spyOn } from 'bun:test'
import type { CommandContext } from '../../src/cli/commands'
import { createCliDispatcher } from '../../src/cli/dispatcher'
import { velaInternals } from '../../src/vela'
import {
  createTestVela as createCoreTestVela,
  type TestVelaOptions as CoreTestVelaOptions,
} from '../../src/testing/test-vela'

export {
  cleanupTestVelas,
  type FixtureSkill,
  tempDir,
} from '../../src/testing/test-vela'

export type TestVelaOptions = CoreTestVelaOptions

/**
 * vela/testing 的 createTestVela()，再加上 CLI 的斜杠命令分发器：
 * 测试用和 CLI 完全相同的命令处理，命令作用在默认会话（`t.session`）上。
 */
export function createTestVela(options: TestVelaOptions = {}) {
  const t = createCoreTestVela(options)
  const internals = velaInternals(t.vela)

  const ctx: CommandContext = {
    vela: t.vela,
    internals,
    session: t.session,
    // 命令输出照旧走 console.log，用 captureConsole() 捕获
    print: (text) => console.log(text),
  }
  const dispatch = createCliDispatcher(t.vela)

  return Object.assign(t, {
    /** createVela() 的内部对象（registry、记忆、知识库、通道网关…），只给测试用 */
    internals,
    ctx,
    /** 执行斜杠命令；返回值同 CLI 分发器：false / true / Promise（异步命令） */
    dispatch: (command: string) => dispatch(command, ctx),
    /** 执行斜杠命令并等它结束；返回是否认领了这个命令 */
    command: async (command: string) => {
      const result = dispatch(command, ctx)
      if (result instanceof Promise) await result
      return result !== false
    },
  })
}

export type TestVela = ReturnType<typeof createTestVela>

/** 捕获 console.log / console.error 的输出，返回拼好的文本 */
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
