import type { VelaLogger } from '../logger'

/** CLI 的 logger：打到终端，debug 只在 VELA_DEBUG=1 时输出。 */
export function createConsoleLogger(
  options: { debug?: boolean } = {},
): VelaLogger {
  return {
    debug: (message) => {
      if (options.debug) console.log(`  ${message}`)
    },
    info: (message) => console.log(`  ${message}`),
    warn: (message) => console.error(`  ${message}`),
    error: (message) => console.error(`  ${message}`),
  }
}
