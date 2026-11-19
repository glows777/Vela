import { randomUUID } from 'node:crypto'
import type {
  ExecutionError,
  Result,
  ShellExecResult,
} from '../../execution/types.ts'
import type { VelaLogger } from '../../logger.ts'
import { errorMessage } from '../../logger.ts'
import type {
  BackgroundAdmission,
  BackgroundCommands,
  BackgroundSnapshot,
  BackgroundStart,
  BackgroundTask,
  CommandExit,
  ForegroundCommand,
} from '../../tools/background.ts'
import { OutputTail } from '../../tools/output-tail.ts'
import type { VelaSession } from '../../vela-session.ts'

/** The command head in a delivery message and in `background_stop`. */
const COMMAND_HEAD = 160

interface Job {
  token: string
  stoppedNotice?: Promise<void>
  id: string
  command: string
  startedAt: number
  endedAt?: number
  controller: AbortController
  finished: Promise<void>
  output: OutputTail
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  /** The environment's file with the complete output, known once the command spills */
  fullOutputPath?: string
  /** No delivery: the caller has the tail (`background_stop`) or the run that would answer is ending. */
  silent?: boolean
}

const commandHead = (command: string) => {
  const head = command.trim().split('\n')[0]!.trim()
  return head.length > COMMAND_HEAD ? `${head.slice(0, COMMAND_HEAD)}…` : head
}

/**
 * A command the session runs in the foreground. It has no id, tail reader or delivery until a
 * caller moves it to the background, and it follows the run's signal until then.
 */
class Foreground {
  /** `withdrawn` is a claim that was rolled back after the run aborted: nothing left to claim. */
  state: 'foreground' | 'moved' | 'withdrawn' = 'foreground'
  /** When it started in the foreground: a moved job keeps clocking from there in `/tasks`. */
  readonly startedAt = Date.now()
  /** Set as soon as the command's own result settles: from then on it can no longer be claimed. */
  settled = false
  /** Resolves with the job id and the tail so far once this call is moved */
  readonly detached = Promise.withResolvers<BackgroundAdmission>()
  /** The command's outcome, as the job reports it; a failed start is one more outcome */
  exitResult!: Promise<CommandExit>

  constructor(
    readonly command: string,
    readonly controller: AbortController,
    readonly output: OutputTail,
    readonly toolCallId?: string,
    /** The run's signal this command follows while it is in the foreground */
    readonly run?: AbortSignal,
    /** `!!`: the command's output is kept out of the model context, so it cannot become a job */
    readonly excludeFromContext = false,
  ) {}

  /** An interrupted run cancels a foreground command; a moved one no longer reaches here. */
  readonly forward = () => {
    if (this.state === 'foreground') this.controller.abort(this.run?.reason)
  }

  /**
   * Follow the run's signal. A run that already aborted cancelled this command (the old abort is
   * not replayed to a removed listener), so it is cancelled rather than left running unclaimed.
   */
  follow(): void {
    if (this.run?.aborted) {
      this.state = 'withdrawn'
      this.controller.abort(this.run.reason)
      return
    }
    this.state = 'foreground'
    this.run?.addEventListener('abort', this.forward, { once: true })
  }

  /** Take the command out of the run's reach; a claim is synchronous, so only one caller wins. */
  unfollow(): void {
    this.state = 'moved'
    this.run?.removeEventListener('abort', this.forward)
  }
}

/** Jobs die with their session; an optional host tracks the result still owed after a restart. */
export class BackgroundJobs implements BackgroundCommands {
  private readonly jobs = new Map<string, Job>()
  private readonly foreground = new Set<Foreground>()
  private sequence = 0

  constructor(
    private readonly session: VelaSession,
    private readonly logger: VelaLogger,
    private readonly shellPath?: string,
  ) {}

  async adopt({
    command,
    start,
    signal,
  }: {
    command: string
    start: (
      run: BackgroundStart,
    ) => Promise<Result<ShellExecResult, ExecutionError>>
    signal?: AbortSignal
  }): Promise<BackgroundAdmission> {
    const id = `bg-${++this.sequence}`
    const controller = new AbortController()
    const job: Job = {
      token: randomUUID(),
      id,
      command,
      startedAt: Date.now(),
      controller,
      output: new OutputTail(),
      state: 'running',
      finished: Promise.resolve(),
    }
    this.jobs.set(id, job)
    // Stop/close can find the job while its start record is being saved. Only this
    // admission phase follows the calling tool's signal; a running job has its own lifetime.
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const prepared = Promise.resolve().then(async () => {
      await this.session.host?.background?.({
        type: 'started',
        token: job.token,
        id,
        commandHead: commandHead(command),
      })
      controller.signal.throwIfAborted()
    })
    job.finished = prepared.then(
      () => this.run(job, start),
      () => {
        job.state = 'exited'
      },
    )
    this.session.trackWork(job.finished)
    try {
      await prepared
      controller.signal.throwIfAborted()
      this.syncStatus()
      // An environment can emit output before this returns; the call reports that tail.
      const { text, truncated } = job.output.read()
      return { id, output: text, truncated }
    } catch (error) {
      // A failed/cancelled admission never launches a process or claims it started.
      job.silent = true
      await this.notifyStopped(job).catch((cleanupError) =>
        this.logger.error(
          `[background] Could not clear ${id}: ${errorMessage(cleanupError)}`,
        ),
      )
      if (!job.stopped) this.jobs.delete(id)
      this.syncStatus()
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  watch<S>({
    command,
    toolCallId,
    signal,
    output,
    start,
    exit,
    excludeFromContext,
  }: {
    command: string
    toolCallId?: string
    signal?: AbortSignal
    output: OutputTail
    start: (signal: AbortSignal) => Promise<S>
    exit: (settled: S) => CommandExit
    excludeFromContext?: boolean
  }): ForegroundCommand<S> {
    const entry = new Foreground(
      command,
      new AbortController(),
      output,
      toolCallId,
      signal,
      excludeFromContext === true,
    )
    this.foreground.add(entry)
    entry.follow()
    const result = Promise.resolve().then(() => start(entry.controller.signal))
    // Registered before any caller awaits it, so a claim never races a settled command.
    void result.then(
      () => (entry.settled = true),
      () => (entry.settled = true),
    )
    entry.exitResult = result
      .then(exit, (cause) => ({ error: errorMessage(cause) }))
      .finally(() => {
        // A settled command can no longer be moved; whoever holds it has its result.
        this.foreground.delete(entry)
        entry.run?.removeEventListener('abort', entry.forward)
      })
    return { result, detached: entry.detached.promise }
  }

  async detach(toolCallId?: string): Promise<string[]> {
    const foreground = [...this.foreground].filter(
      (entry) => entry.state === 'foreground',
    )
    // A job delivers its exit to the model, which a `!!` command promised not to do: it stays in
    // the foreground, where Esc still cancels it, and is left out of a move-everything request.
    const claimable = foreground.filter((entry) => !entry.excludeFromContext)
    const targets =
      toolCallId === undefined
        ? claimable
        : claimable.filter((entry) => entry.toolCallId === toolCallId)
    if (toolCallId !== undefined && targets.length === 0) {
      // Sorted so the message reads the same however the calls happened to start.
      const running = foreground
        .flatMap((entry) => (entry.toolCallId ? [entry.toolCallId] : []))
        .sort()
      throw new Error(
        `No running bash call with tool call ID ${toolCallId}. ${
          running.length
            ? `Running: ${running.join(', ')}`
            : 'No bash call is running in the foreground.'
        }`,
      )
    }
    const ids: string[] = []
    for (const entry of targets) {
      // Claim one call at a time: a move that fails must leave the calls behind it following the
      // run, and an overlapping request must not find an entry claimed but never recorded.
      if (entry.state !== 'foreground' || entry.settled) continue
      entry.unfollow()
      ids.push(await this.move(entry))
    }
    return ids
  }

  /** Hand one claimed command to a job; a failed record leaves it in the foreground. */
  private async move(entry: Foreground): Promise<string> {
    // `detach` claimed it: the command stopped following the run before this record started, so a
    // Stop that races the record cannot abort a command the job is about to own.
    const id = `bg-${++this.sequence}`
    const job: Job = {
      token: randomUUID(),
      id,
      command: entry.command,
      startedAt: entry.startedAt,
      controller: entry.controller,
      output: entry.output,
      state: 'running',
      finished: Promise.resolve(),
    }
    this.jobs.set(id, job)
    try {
      await this.session.host?.background?.({
        type: 'started',
        token: job.token,
        id,
        commandHead: commandHead(entry.command),
      })
    } catch (error) {
      // The host may already hold a start record it could not acknowledge, so clear it before
      // handing the command back to its call.
      await this.discard(job)
      entry.follow()
      throw error
    }
    if (entry.settled) {
      // The command ended while its start record was being saved, so the call already returned
      // its own result. Promise no job: clear the record and say the move was too late.
      await this.discard(job)
      throw new Error(
        'The command finished while it was being moved to the background; its result came from the call.',
      )
    }
    job.finished = entry.exitResult.then((exit) => this.exited(job, exit))
    this.session.trackWork(job.finished)
    const { text, truncated } = entry.output.read()
    entry.detached.resolve({ id, output: text, truncated })
    this.syncStatus()
    return id
  }

  private async run(
    job: Job,
    start: (
      run: BackgroundStart,
    ) => Promise<Result<ShellExecResult, ExecutionError>>,
  ): Promise<void> {
    try {
      job.controller.signal.throwIfAborted()
      const result = await start({
        onOutput: (chunk) => job.output.append(chunk),
        signal: job.controller.signal,
        ...(this.shellPath === undefined ? {} : { shell: this.shellPath }),
      })
      this.exited(
        job,
        result.ok
          ? {
              exitCode: result.value.exitCode,
              spillPath: result.value.spillPath,
            }
          : { spillPath: result.error.spillPath, error: result.error.message },
      )
    } catch (error) {
      this.failed(job, error)
    }
  }

  /** A declared or moved command exited the same way: record how, then deliver unless silent. */
  private exited(job: Job, exit: CommandExit): void {
    job.state = 'exited'
    job.endedAt = Date.now()
    job.fullOutputPath = exit.spillPath
    this.syncStatus()
    if (job.silent) return
    if (exit.error !== undefined) {
      this.deliver(
        `Background command ${job.id} could not start or run: ${exit.error}.`,
        job,
      )
      return
    }
    job.exitCode = exit.exitCode
    this.deliver(
      exit.exitCode === undefined
        ? `Background command ${job.id} finished.`
        : `Background command ${job.id} finished with exit code ${exit.exitCode}.`,
      job,
    )
  }

  private failed(job: Job, cause: unknown): void {
    job.state = 'exited'
    job.endedAt = Date.now()
    this.syncStatus()
    if (!job.silent)
      this.deliver(
        `Background command ${job.id} could not start or run: ${errorMessage(cause)}.`,
        job,
      )
  }

  snapshot(id: string): BackgroundSnapshot {
    return this.snapshotOf(this.job(id))
  }

  /** Every job still in the table, oldest first, for `/tasks`. */
  tasks(): BackgroundTask[] {
    return [...this.jobs.values()].map((job) => ({
      snapshot: this.snapshotOf(job),
      startedAt: job.startedAt,
      ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
    }))
  }

  private snapshotOf(job: Job): BackgroundSnapshot {
    const { text, truncated } = job.output.read()
    return {
      id: job.id,
      command: job.command,
      state: job.state,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.stopped ? { stopped: true } : {}),
      output: text,
      truncated,
      ...(job.fullOutputPath === undefined
        ? {}
        : { fullOutputPath: job.fullOutputPath }),
    }
  }

  /** End one command; the caller already receives its tail from the tool result, so this never delivers. */
  async stop(id: string): Promise<BackgroundSnapshot> {
    const job = this.job(id)
    job.silent = true
    if (job.state === 'running') {
      job.stopped = true
      await this.terminate(job)
    }
    await this.notifyStopped(job)
    const snapshot = this.snapshot(id)
    // The result has been handed to the caller; the tail and its memory go with the job.
    this.jobs.delete(id)
    this.syncStatus()
    return snapshot
  }

  /**
   * End every job with its session (Stop, close, shutdown). These exits are not delivered: the
   * run that would answer is gone, and a close must not start a new one.
   */
  async stopAll(): Promise<void> {
    const running = [...this.jobs.values()]
    for (const job of running) {
      job.stopped = true
      job.silent = true
    }
    // Admit the clear at the Stop boundary, before termination awaits: the host's
    // serialized writes then keep jobs started by a later run. This also clears
    // results already queued outside this in-memory map. A synchronous host error
    // must not prevent termination of the captured jobs.
    const cleared = (async () => {
      await this.session.host?.background?.({ type: 'stopped' })
    })()
    await Promise.all([cleared, ...running.map((job) => this.terminate(job))])
    for (const job of running) this.jobs.delete(job.id)
    this.syncStatus()
  }

  /** Drop a job that never existed as far as the model is concerned, clearing its start record. */
  private async discard(job: Job): Promise<void> {
    job.silent = true
    job.state = 'exited'
    this.jobs.delete(job.id)
    this.syncStatus()
    await this.notifyStopped(job).catch((cleanupError) =>
      this.logger.error(
        `[background] Could not clear ${job.id}: ${errorMessage(cleanupError)}`,
      ),
    )
  }

  private notifyStopped(job: Job): Promise<void> {
    job.stoppedNotice ??= Promise.resolve().then(() =>
      this.session.host?.background?.({ type: 'stopped', token: job.token }),
    )
    return job.stoppedNotice
  }

  /** The footer's extension status slot: the running jobs and their ids, cleared when none runs. */
  private syncStatus(): void {
    const running = [...this.jobs.values()].filter(
      (job) => job.state === 'running',
    )
    this.session.ui.setStatus(
      'background',
      running.length === 0
        ? undefined
        : `${running.length} background ${running.length === 1 ? 'task' : 'tasks'} · ${running.map((job) => job.id).join(', ')}`,
    )
  }

  private job(id: string): Job {
    const job = this.jobs.get(id)
    if (!job)
      throw new Error(
        `Unknown background command ${id}. It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.`,
      )
    return job
  }

  /** Abort through the originating execution environment and wait for completion. */
  private async terminate(job: Job): Promise<void> {
    if (job.state === 'exited') return
    job.controller.abort()
    await job.finished
  }

  private deliver(status: string, job: Job): void {
    const { text, truncated } = job.output.read()
    const output = text
      ? `${text}${truncated ? '\n\n[Showing the last output only]' : ''}`
      : '(no output)'
    const fullOutput = job.fullOutputPath
      ? `\nFull output: ${job.fullOutputPath}`
      : ''
    const message = `${status}\nCommand: ${commandHead(job.command)}\nOutput:\n${output}${fullOutput}`
    const host = this.session.host
    const send = host
      ? Promise.resolve().then(() =>
          job.silent
            ? undefined
            : host.background
              ? host.background({
                  type: 'result',
                  token: job.token,
                  text: message,
                })
              : host.deliver(message),
        )
      : this.session.sendMessage(
          { customType: 'background', content: message, display: false },
          { triggerTurn: true, deliverAs: 'followUp' },
        )
    void send
      .catch((error) =>
        this.logger.error(
          `[background] Could not deliver ${job.id}: ${errorMessage(error)}`,
        ),
      )
      // Delivered or not, the result has left the job: its tail no longer answers for it.
      .finally(() => this.jobs.delete(job.id))
  }
}
