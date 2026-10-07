import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VelaLogger } from '../logger'

/**
 * CLI 的 logger：打到终端，debug 只在 VELA_DEBUG=1 时输出。
 * `stderr`：单次 / json / rpc 模式全部写 stderr，stdout 只放结果和协议（同 pi）。
 */
export function createConsoleLogger(
  options: { debug?: boolean; stderr?: boolean } = {},
): VelaLogger {
  const info = options.stderr ? console.error : console.log
  return {
    debug: (message) => {
      if (options.debug) info(`  ${message}`)
    },
    info: (message) => info(`  ${message}`),
    warn: (message) => console.error(`  ${message}`),
    error: (message) => console.error(`  ${message}`),
  }
}

/**
 * 交互模式的 logger：TUI 启动前打到终端；`attach()` 之后 info / warn / error 显示在对话区。
 * debug（VELA_DEBUG=1）写进 `debugLog` 文件，不打乱画面。
 */
export function createInteractiveLogger(options: {
  debugLog?: string
}): {
  logger: VelaLogger
  attach: (sink: (level: 'info' | 'warning' | 'error', message: string) => void) => void
} {
  let sink: ((level: 'info' | 'warning' | 'error', message: string) => void) | undefined
  const write =
    (level: 'info' | 'warning' | 'error') => (message: string) => {
      if (sink) sink(level, message)
      else (level === 'info' ? console.log : console.error)(`  ${message}`)
    }
  const { debugLog } = options
  if (debugLog) mkdirSync(dirname(debugLog), { recursive: true })
  return {
    logger: {
      debug: (message) => {
        if (debugLog)
          appendFileSync(debugLog, `${new Date().toISOString()} ${message}\n`)
      },
      info: write('info'),
      warn: write('warning'),
      error: write('error'),
    },
    attach: (next) => {
      sink = next
    },
  }
}
