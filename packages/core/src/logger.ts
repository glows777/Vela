/**
 * Diagnostic output that is not an event (plugin loading, hook errors, bad session file lines, ...).
 * Core never writes to the terminal: silent by default; the CLI passes one that prints.
 */
export interface VelaLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const noop = () => {}

export const silentLogger: VelaLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
