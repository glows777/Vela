/** How a command run by the shell runner ended. */
export interface ShellRun {
  /** The exit code, or 128 + the signal number when a signal killed it */
  exitCode: number
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** The run's `signal` aborted the command */
  cancelled: boolean
}

/**
 * A command that has started. `exited` settles when it ends and its output file has been closed, so
 * a caller can stop waiting and hand the handle to a background job instead.
 */
export interface RunningShell {
  readonly command: string
  /** File holding its combined stdout and stderr */
  readonly path: string
  readonly pid: number | undefined
  readonly exited: Promise<ShellRun>
  /** Signals the process tree now: SIGTERM to let it clean up, SIGKILL to end it. */
  signal(signal: 'SIGTERM' | 'SIGKILL'): void
}
