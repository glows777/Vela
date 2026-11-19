import type {
  ExecutionError,
  Result,
  ShellExecResult,
} from '../execution/types.ts'
import type { OutputTail } from './output-tail.ts'

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
  /** The environment's file with the complete output, known once it has spilled */
  fullOutputPath?: string
}

/** A job as `/tasks` lists it: the snapshot plus when it started and, once it ended, when. */
export interface BackgroundTask {
  snapshot: BackgroundSnapshot
  /** Epoch milliseconds: when the command started, or when it was moved to the background */
  startedAt: number
  /** Epoch milliseconds when it exited; unset while it runs */
  endedAt?: number
}

/** What a background command runs with: its output sink, its own abort signal and its shell. */
export interface BackgroundStart {
  /** Every chunk of output as it arrives, in order */
  onOutput: (chunk: string) => void
  /** Aborts this command alone; a job outlives the tool call that started it */
  signal: AbortSignal
  /**
   * The shell to run a local command with, from `background({ shellPath })`; unset means the
   * session's execution environment chooses. An environment that is not local chooses its own.
   */
  shell?: string
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
  /**
   * Registers a command that is already running in the foreground, so a caller can move it to the
   * background later. The table only holds it: no id, no delivery and no tracked work until then.
   * `start` runs with a signal that follows the run's until the command is moved.
   */
  watch<S>(options: {
    command: string
    /** The model-issued call waiting for this command; unset for the user's own `!` command. */
    toolCallId?: string
    /** The run's signal: a foreground command follows it, a moved one no longer does. */
    signal?: AbortSignal
    /** The command's bounded tail, which the job keeps for its snapshot and delivery after a move. */
    output: OutputTail
    /** Starts the command; the promise settles when it exits. */
    start: (signal: AbortSignal) => Promise<S>
    /** How the job reports that outcome (exit code, spilled output file, or a message) */
    exit: (settled: S) => CommandExit
  }): ForegroundCommand<S>
  /**
   * Moves running foreground commands to the background: every one the session is running (the
   * user's own `!` command too), or the one model-issued call named by its tool-call id. Returns the
   * new job ids; an unknown id throws and names the calls that are running.
   */
  detach(toolCallId?: string): Promise<string[]>
  /** A job's state and output tail; throws for an id that already delivered or was stopped. */
  snapshot(id: string): BackgroundSnapshot
  /** Every job still in the table, oldest first, for `/tasks`. */
  tasks(): BackgroundTask[]
  /** Ends a job and returns its final state; the caller gets the tail, so this never delivers. */
  stop(id: string): Promise<BackgroundSnapshot>
  /**
   * Ends every job with its session (Stop, close, shutdown). These exits are not delivered: the run
   * that would answer is gone, and a close must not start a new one.
   */
  stopAll(): Promise<void>
}

/** One command running in the foreground, registered so a caller can move it to the background. */
export interface ForegroundCommand<S> {
  /** The command's result as the caller awaits it; rejects only when the environment throws. */
  result: Promise<S>
  /**
   * Resolves with the new job's id and the tail so far once this call is moved to the background;
   * never resolves while it stays in the foreground.
   */
  detached: Promise<BackgroundAdmission>
}

/** How a moved command ended, as its job reports it. */
export interface CommandExit {
  exitCode?: number
  /** The environment's file with the complete output, known once the command spills */
  spillPath?: string
  /** The command could not start or run; the delivery carries this message */
  error?: string
}
