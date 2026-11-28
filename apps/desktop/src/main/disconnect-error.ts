export function isDisconnectError(error: unknown): boolean {
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'ECONNREFUSED' ||
      code === 'ERR_IPC_CHANNEL_CLOSED'
    ) {
      return true
    }
  }
  const msg = error instanceof Error ? error.message : String(error ?? '')
  return /Daemon (?:client|runtime client) (?:is closed|closed|disconnected|not connected|timed out)|Disconnected from Vela daemon|Socket is closed|This socket has been ended/i.test(
    msg,
  )
}
