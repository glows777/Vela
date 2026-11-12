import { format } from 'node:util'
import type { LogWarningsFunction, Warning } from 'ai'
import type { LogLevel } from './types.ts'

/**
 * Send console output and AI SDK warnings to the chat log while the TUI runs: writing either to the
 * terminal would garble the screen. Console methods are replaced here; the SDK writes through
 * `process.emitWarning`, so it is redirected through `globalThis.AI_SDK_LOG_WARNINGS` instead.
 * Returns the restore for shutdown.
 */
export function captureCliLogs(
  addNotice: (text: string, level: LogLevel | 'dim') => void,
): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  const to =
    (level: LogLevel | 'dim') =>
    (...args: unknown[]) =>
      addNotice(format(...args), level)
  console.log = to('dim')
  console.info = to('dim')
  console.warn = to('warning')
  console.error = to('error')

  // The default logger emits a provider warning again on every request; one session shows each text once.
  const shown = new Set<string>()
  const logWarnings: LogWarningsFunction = ({ warnings, provider, model }) => {
    const prefix = `AI SDK Warning${
      provider != null && model != null ? ` (${provider} / ${model})` : ''
    }:`
    for (const warning of warnings) {
      const text = formatWarning(warning, prefix)
      if (shown.has(text)) continue
      shown.add(text)
      addNotice(text, 'warning')
    }
  }
  const previous = globalThis.AI_SDK_LOG_WARNINGS
  globalThis.AI_SDK_LOG_WARNINGS = logWarnings
  return () => {
    Object.assign(console, original)
    if (previous === undefined)
      Reflect.deleteProperty(globalThis, 'AI_SDK_LOG_WARNINGS')
    else globalThis.AI_SDK_LOG_WARNINGS = previous
  }
}

/** The default logger's wording; the SDK exports the global and its type, not this formatter. */
function formatWarning(warning: Warning, prefix: string): string {
  switch (warning.type) {
    case 'unsupported':
    case 'compatibility': {
      const feature =
        warning.type === 'unsupported'
          ? 'is not supported'
          : 'is used in a compatibility mode'
      const text = `${prefix} The feature "${warning.feature}" ${feature}.`
      return warning.details ? `${text} ${warning.details}` : text
    }
    case 'deprecated':
      return `${prefix} Deprecated: "${warning.setting}". ${warning.message}`
    case 'other':
      return `${prefix} ${warning.message}`
    default:
      return `${prefix} ${JSON.stringify(warning, null, 2)}`
  }
}
