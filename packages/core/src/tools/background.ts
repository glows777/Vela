import type { RunningShell } from './running-shell.ts'

/** A background command as `background_output` and `background_stop` report it. */
export interface BackgroundSnapshot {
  id: string
  command: string
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  /** The output tail: the last 2,000 lines or 50KB of the command's output file */
  output: string
  truncated: boolean
}

/**
 * A session's background commands, installed by the `background` extension. Without one, `bash` has
 * no `run_in_background`: the tool refuses it rather than starting a command nothing would watch.
 */
export interface BackgroundCommands {
  /**
   * Takes ownership of a started command: its exit is delivered to the session as one message and
   * the caller stops waiting for it. Returns the job id (`bg-1`, `bg-2`, … for the session).
   */
  adopt(shell: RunningShell): string
  /** A job's state and output tail; throws for an id that already delivered or was stopped. */
  snapshot(id: string): Promise<BackgroundSnapshot>
  /** Ends a job and returns its final state; the caller gets the tail, so this never delivers. */
  stop(id: string): Promise<BackgroundSnapshot>
}
