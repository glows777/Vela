import type { VelaEventListener } from '../agent/events.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import type { ModelMessage } from '../messages.ts'
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
      const result: BashResult = controller.signal.aborted
        ? { output: '', exitCode: undefined, cancelled: true, truncated: false }
        : await runBash(command, {
            env: environment!,
            signal: controller.signal,
            onUpdate: options.onUpdate,
            onDelta: (delta) =>
              this.host.emit({
                type: 'bash_execution_update',
                ...(options.id === undefined ? {} : { id: options.id }),
                delta,
              }),
          })
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
        ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
      })
      if (!this.host.busy.locked && this.flush()) await this.host.save()
      return result
    } finally {
      this.bashController = undefined
      this.bashRun = undefined
    }
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
