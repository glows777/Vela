import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VelaLogger } from '../logger.ts'

/**
 * CLI logger: prints to the terminal; debug only when VELA_DEBUG=1.
 * `stderr`: print / json / rpc modes write everything to stderr, keeping stdout for results and protocol (like pi).
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
 * Interactive-mode logger: prints to the terminal until the TUI starts; after `attach()`, info / warn / error
 * show in the chat log. debug (VELA_DEBUG=1) goes to the `debugLog` file so it doesn't garble the screen.
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
