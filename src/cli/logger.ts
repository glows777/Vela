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
