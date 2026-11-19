import type {
  ExecutionError,
  Result,
  ShellExecResult,
} from '../execution/types.ts'

/** A started job as the call that started it reports it. */
export interface BackgroundAdmission {
  id: string
  /** The tail the command already wrote when the call returned; empty when it has not spoken yet */
  output: string
  truncated: boolean
}

/** A background command as `background_output` and `background_stop` report it. */
export interface BackgroundSnapshot {
  id: string
  command: string
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  /** The output tail: the last 2,000 lines or 50KB of the command's output */
  output: string
  truncated: boolean
}

/** What a background command runs with: its output sink and its own abort signal. */
export interface BackgroundStart {
  /** Every chunk of output as it arrives, in order */
  onOutput: (chunk: string) => void
  /** Aborts this command alone; a job outlives the tool call that started it */
  signal: AbortSignal
}

/**
 * A session's background commands, installed by the `background` extension and passed to tools in
 * `ToolContext`. It owns the ids, the bounded tails and the exit deliveries, so `bash` starts a
 * background command through it instead of keeping a second implementation.
 */
export interface BackgroundCommands {
  /**
   * Takes ownership of a command: allocates its id, keeps its tail and delivers its exit to the
   * session. Resolves once the command may start, with what it has already written, so a caller
   * that cannot record the job in time fails the call instead of promising a result.
   */
  adopt(options: {
    command: string
    /** Starts the command; the promise settles when it exits. */
    start: (
      run: BackgroundStart,
    ) => Promise<Result<ShellExecResult, ExecutionError>>
    /**
     * The calling tool's signal. Admission follows it, so a cancelled call launches nothing; the
     * running job does not, because it outlives the call.
     */
    signal?: AbortSignal
  }): Promise<BackgroundAdmission>
  /** A job's state and output tail; throws for an id that already delivered or was stopped. */
  snapshot(id: string): BackgroundSnapshot
  /** Ends a job and returns its final state; the caller gets the tail, so this never delivers. */
  stop(id: string): Promise<BackgroundSnapshot>
  /**
   * Ends every job with its session (Stop, close, shutdown). These exits are not delivered: the run
   * that would answer is gone, and a close must not start a new one.
   */
  stopAll(): Promise<void>
}
