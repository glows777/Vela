import { isDeadTerminalError } from './components.ts'

export function registerInteractiveSignalHandlers(options: {
  hasCustomTerminal: boolean
  onShutdown: () => void
  onEmergencyExit: () => never
  onBeforeCrash: () => void
  cleanups: Array<() => void>
}): void {
  const signals: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGTERM'] : ['SIGTERM', 'SIGHUP']
  for (const signal of signals) {
    const handler = () => options.onShutdown()
    process.prependListener(signal, handler)
    options.cleanups.push(() => process.off(signal, handler))
  }
  if (options.hasCustomTerminal) return
  const terminalError = (error: Error) => {
    if (isDeadTerminalError(error)) options.onEmergencyExit()
    throw error
  }
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    stream.on('error', terminalError)
    options.cleanups.push(() => stream.off('error', terminalError))
  }
  const crash = (error: Error) => {
    if (isDeadTerminalError(error)) options.onEmergencyExit()
    options.onBeforeCrash()
    console.error('vela exited due to an uncaught exception:', error)
    process.exit(1)
  }
  process.prependListener('uncaughtException', crash)
  options.cleanups.push(() => process.off('uncaughtException', crash))
}
