import type { VelaEventListener } from '../agent/events.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import type { ModelMessage } from '../messages.ts'
import type {
  BackgroundCommands,
  ForegroundCommand,
} from '../tools/background.ts'
import { OutputTail } from '../tools/output-tail.ts'
import { type BashResult, runBash } from '../tools/shell.ts'
import type { TokenTracker } from '../usage/tracker.ts'
import {
  type BashExecutionEntry,
  bashExecutionToText,
  type NewEntry,
} from './entries.ts'
import type { SessionStore } from './index.ts'

/** One session's user shell command and results waiting for its agent loop to stop. */
export class UserBash {
  /** The running `executeBash()` command */
  private bashController?: AbortController
  /** The running `executeBash()` call, which close() waits for so its result is saved */
  private bashRun?: Promise<unknown>
  /** `!` commands that finished while the agent ran, recorded when it stops (like pi) */
  private readonly pendingBash: NewEntry<BashExecutionEntry>[] = []
  constructor(
    private readonly host: {
      store: SessionStore
      emit: VelaEventListener
      busy: { locked: boolean }
      save: () => Promise<void>
      messages: ModelMessage[]
      tracker: TokenTracker
      timestamps: Map<ModelMessage, number>
      prepare: () => Promise<ExecutionEnv>
      /** Prepares the session and fires `session_start`, so extensions can see the command */
      start: (signal?: AbortSignal) => Promise<void>
      /** The session's job table, once the `background` extension installed it */
      background: () => BackgroundCommands | undefined
      isClosed: () => boolean
      isDraining: () => boolean
    },
  ) {}
  get isRunning(): boolean {
    return this.bashController !== undefined
  }
  get running(): Promise<unknown> | undefined {
    return this.bashRun
  }
  execute(
    command: string,
    options: {
      excludeFromContext?: boolean
      onUpdate?: (output: string) => void
      id?: string
    },
  ): Promise<BashResult> {
    if (this.bashController)
      throw new Error(
        'A shell command is already running: wait for it or call abortBash()',
      )
    const controller = new AbortController()
    this.bashController = controller
    const run = this.run(command, controller, options)
    this.bashRun = run
    return run
  }

  private async run(
    command: string,
    controller: AbortController,
    options: {
      excludeFromContext?: boolean
      onUpdate?: (output: string) => void
      id?: string
    },
  ): Promise<BashResult> {
    try {
      // Register the command before awaiting its environment so abort/close can stop it.
      let onAbort!: () => void
      const cancelled = new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      let environment: ExecutionEnv | undefined
      try {
        environment = await Promise.race([this.host.prepare(), cancelled])
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
      }
      if (this.host.isClosed()) throw new Error('Session is closed')
      // Appending to a saved session that was not resumed would mix two conversations in one log
      await this.host.store.assertNew()
      if (this.host.isDraining())
        throw new Error('Session is draining; shell command was not executed')
      // A session's first act can be a `!` command; its extensions install the job table here.
      // The startup follows the command's own signal, so cancelling it does not wait for workspace
      // preparation or a slow `session_start` hook.
      if (!controller.signal.aborted) {
        const starting = this.host.start(controller.signal)
        await Promise.race([
          starting.catch((error) => {
            // A cancelled startup is this command's cancellation, not a failure to report.
            if (!controller.signal.aborted) throw error
          }),
          cancelled,
        ])
      }
      // The same tail the job table keeps, so a command moved to the background keeps reporting
      // from one buffer and its snapshot starts where the foreground output stopped.
      const output = new OutputTail()
      const start = (signal: AbortSignal) =>
        runBash(command, {
          env: environment!,
          signal,
          onUpdate: options.onUpdate,
          onDelta: (delta) =>
            this.host.emit({
              type: 'bash_execution_update',
              ...(options.id === undefined ? {} : { id: options.id }),
              delta,
            }),
          output,
        })
      // A cancelled command is not registered, so it cannot be claimed and never starts a shell
      // that only has to be killed.
      const foreground = controller.signal.aborted
        ? undefined
        : this.host.background()?.watch({
            command,
            signal: controller.signal,
            output,
            start,
            ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
            exit: (settled) => ({
              exitCode: settled.exitCode,
              spillPath: settled.fullOutputPath,
            }),
          })
      const result: BashResult = controller.signal.aborted
        ? { output: '', exitCode: undefined, cancelled: true, truncated: false }
        : foreground
          ? await this.settle(foreground)
          : await start(controller.signal)
      this.pendingBash.push({
        type: 'bash_execution',
        command,
        output: result.output,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        cancelled: result.cancelled,
        truncated: result.truncated,
        ...(result.fullOutputPath
          ? { fullOutputPath: result.fullOutputPath }
          : {}),
        ...(result.backgroundTaskId
          ? { backgroundTaskId: result.backgroundTaskId }
          : {}),
        ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
      })
      if (!this.host.busy.locked && this.flush()) await this.host.save()
      return result
    } finally {
      this.bashController = undefined
      this.bashRun = undefined
    }
  }

  /** The command's own result, or the synthetic one: its tail so far and the id it now runs under. */
  private async settle(
    foreground: ForegroundCommand<BashResult>,
  ): Promise<BashResult> {
    const outcome = await Promise.race([
      foreground.result.then((value) => ({ type: 'result' as const, value })),
      foreground.detached.then((admission) => ({
        type: 'detached' as const,
        admission,
      })),
    ])
    return outcome.type === 'result'
      ? outcome.value
      : {
          output: outcome.admission.output,
          exitCode: undefined,
          cancelled: false,
          truncated: outcome.admission.truncated,
          backgroundTaskId: outcome.admission.id,
        }
  }

  /**
   * Moves running shell commands to the background: every one this session holds in the foreground
   * (including your own `!` command), or the one model-issued `bash` call named by its tool-call id.
   * The waiting call returns a synthetic result naming the job, and the exit arrives later as the
   * job's result. Returns the new background ids; an unknown id throws and names the running calls.
   */
  detach(toolCallId?: string): Promise<string[]> {
    const commands = this.host.background()
    if (!commands)
      return Promise.reject(
        new Error(
          'Background commands are not enabled in this session: it has no background tools.',
        ),
      )
    return commands.detach(toolCallId)
  }

  /** Cancels the running `executeBash()` command (pi's abortBash); it is still recorded, as cancelled. */
  abort(): void {
    this.bashController?.abort()
  }

  /** Records `!` commands that finished while the agent ran; returns whether there were any. */
  flush(): boolean {
    const pending = this.pendingBash.splice(0)
    for (const execution of pending) {
      const message: ModelMessage | undefined = execution.excludeFromContext
        ? undefined
        : { role: 'user', content: bashExecutionToText(execution) }
      if (message) {
        this.host.messages.push(message)
        this.host.tracker.addMessage(message)
        this.host.timestamps.set(message, Date.now())
      }
      this.host.store.appendBashExecution(execution, message)
    }
    return pending.length > 0
  }
}
