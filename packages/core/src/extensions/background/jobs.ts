import { randomUUID } from 'node:crypto'
import type {
  ExecutionError,
  Result,
  ShellExecResult,
} from '../../execution/types.ts'
import type { VelaLogger } from '../../logger.ts'
import { errorMessage } from '../../logger.ts'
import type {
  BackgroundCommands,
  BackgroundSnapshot,
  BackgroundStart,
} from '../../tools/background.ts'
import { fitOutputTail, OUTPUT_MAX_BYTES } from '../../tools/output-tail.ts'
import type { VelaSession } from '../../vela-session.ts'

/** The command head in a delivery message and in `background_stop`. */
const COMMAND_HEAD = 160

/** In-memory output tail; a command that prints forever only ever costs this buffer. */
export class OutputTail {
  private chunks: string[] = []
  private bytes = 0

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes > OUTPUT_MAX_BYTES * 2) this.compact()
  }

  private compact(): void {
    // Keep enough bytes for the limit, then let read() cut both limits.
    const text = this.text()
    const buffer = Buffer.from(text)
    const kept =
      buffer.length > OUTPUT_MAX_BYTES * 2
        ? buffer.subarray(buffer.length - OUTPUT_MAX_BYTES * 2).toString()
        : text
    this.chunks = [kept]
    this.bytes = Buffer.byteLength(kept)
  }

  private text(): string {
    return this.chunks.join('')
  }

  /** The tail within both limits; `truncated` means older output was dropped. */
  read(): { text: string; truncated: boolean } {
    const { text, truncated } = fitOutputTail(this.text())
    return { text, truncated }
  }
}

interface Job {
  token: string
  stoppedNotice?: Promise<void>
  id: string
  command: string
  controller: AbortController
  finished: Promise<void>
  output: OutputTail
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  /** No delivery: the caller has the tail (`background_stop`) or the run that would answer is ending. */
  silent?: boolean
}

const commandHead = (command: string) => {
  const head = command.trim().split('\n')[0]!.trim()
  return head.length > COMMAND_HEAD ? `${head.slice(0, COMMAND_HEAD)}…` : head
}

/** Jobs die with their session; an optional host tracks the result still owed after a restart. */
export class BackgroundJobs implements BackgroundCommands {
  private readonly jobs = new Map<string, Job>()
  private sequence = 0

  constructor(
    private readonly session: VelaSession,
    private readonly logger: VelaLogger,
  ) {}

  async adopt({
    command,
    start,
  }: {
    command: string
    start: (
      run: BackgroundStart,
    ) => Promise<Result<ShellExecResult, ExecutionError>>
  }): Promise<string> {
    const id = `bg-${++this.sequence}`
    const controller = new AbortController()
    const job: Job = {
      token: randomUUID(),
      id,
      command,
      controller,
      output: new OutputTail(),
      state: 'running',
      finished: Promise.resolve(),
    }
    this.jobs.set(id, job)
    // Stop/close can find the job while its start record is being saved. Only the
    // admission phase waits here; a running job has its own lifetime.
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
      return id
    } catch (error) {
      // A failed/cancelled admission never launches a process or claims it started.
      await this.notifyStopped(job).catch((cleanupError) =>
        this.logger.error(
          `[background] Could not clear ${id}: ${errorMessage(cleanupError)}`,
        ),
      )
      if (!job.stopped) this.jobs.delete(id)
      throw error
    }
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
      })
      job.state = 'exited'
      if (job.silent) return
      if (!result.ok) {
        this.deliver(
          `Background command ${job.id} could not start or run: ${result.error.message}.`,
          job,
        )
        return
      }
      job.exitCode = result.value.exitCode
      this.deliver(
        `Background command ${job.id} finished with exit code ${job.exitCode}.`,
        job,
      )
    } catch (error) {
      job.state = 'exited'
      if (!job.silent)
        this.deliver(
          `Background command ${job.id} could not start or run: ${errorMessage(error)}.`,
          job,
        )
    }
  }

  snapshot(id: string): BackgroundSnapshot {
    const job = this.job(id)
    const { text, truncated } = job.output.read()
    return {
      id: job.id,
      command: job.command,
      state: job.state,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.stopped ? { stopped: true } : {}),
      output: text,
      truncated,
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
  }

  private notifyStopped(job: Job): Promise<void> {
    job.stoppedNotice ??= Promise.resolve().then(() =>
      this.session.host?.background?.({ type: 'stopped', token: job.token }),
    )
    return job.stoppedNotice
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
    const message = `${status}\nCommand: ${commandHead(job.command)}\nOutput:\n${output}`
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
