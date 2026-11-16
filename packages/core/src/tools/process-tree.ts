import { type ChildProcess, spawn } from 'node:child_process'

/**
 * Signals a child and its descendants: the POSIX process group it was spawned in, or `taskkill /T`
 * on Windows, which has no process groups and no SIGTERM to wait for. A process that is already
 * gone is not an error; any other failure is thrown to the caller.
 */
export function signalProcessTree(
  proc: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  const pid = proc.pid
  if (pid === undefined) return Promise.resolve()
  if (process.platform === 'win32')
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          proc.kill('SIGKILL')
        } catch {}
        resolve()
      }
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', fallback)
      killer.once('close', (code) => (code === 0 ? resolve() : fallback()))
    })
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ESRCH'
      )
    )
      throw error
  }
  return Promise.resolve()
}
