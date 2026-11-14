import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { VelaLogger } from '../../logger.ts'
import { errorMessage } from '../../logger.ts'
import type { VelaSession } from '../../vela-session.ts'
import { backgroundDelivery } from './host.ts'

/** What the model reads per call, the same limits as `bash`: the last 2000 lines or 50KB. */
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
/** SIGTERM first, then SIGKILL when the process group ignores it. */
const STOP_GRACE_MS = 2000
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
    if (this.bytes > MAX_BYTES * 2) this.compact()
  }

  private compact(): void {
    // Keep enough bytes for the line limit, then let read() cut both limits.
    const text = this.text()
    const buffer = Buffer.from(text)
    const kept =
      buffer.length > MAX_BYTES * 2
        ? buffer.subarray(buffer.length - MAX_BYTES * 2).toString()
        : text
    this.chunks = [kept]
    this.bytes = Buffer.byteLength(kept)
  }

  private text(): string {
    return this.chunks.join('')
  }

  /** The tail within both limits; `truncated` means older output was dropped. */
  read(): { text: string; truncated: boolean } {
    let text = this.text()
    let truncated = false
    const buffer = Buffer.from(text)
    if (buffer.length > MAX_BYTES) {
      // A cut may land inside a UTF-8 sequence; drop the replacement character it decodes to.
      text = buffer
        .subarray(buffer.length - MAX_BYTES)
        .toString()
        .replace(/^\uFFFD+/, '')
      // Drop the partial first line; one huge line keeps its cut end (like bash).
      const newline = text.indexOf('\n')
      if (newline >= 0 && newline !== text.length - 1)
        text = text.slice(newline + 1)
      truncated = true
    }
    // Count lines like bash: a final newline does not start another line.
    const endsWithNewline = text.endsWith('\n')
    const lines = text.split('\n')
    if (endsWithNewline) lines.pop()
    if (lines.length > MAX_LINES) {
      text =
        lines.slice(lines.length - MAX_LINES).join('\n') +
        (endsWithNewline ? '\n' : '')
      truncated = true
    }
    return { text, truncated }
  }
}

interface Job {
  id: string
  command: string
  child: ChildProcess
  output: OutputTail
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  /** No delivery: the caller has the tail (`background_stop`) or the run that would answer is ending. */
  silent?: boolean
}

export interface JobSnapshot {
  id: string
  command: string
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  output: string
  truncated: boolean
}

const commandHead = (command: string) => {
  const head = command.trim().split('\n')[0]!.trim()
  return head.length > COMMAND_HEAD ? `${head.slice(0, COMMAND_HEAD)}…` : head
}

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null) =>
  code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)

/** Whether the process group still has members; POSIX only, and ESRCH means it is gone. */
function groupAlive(job: Job): boolean {
  const pid = job.child.pid
  if (pid === undefined) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EPERM'
    )
  }
}

/** The jobs of one session; they die with it, and nothing is persisted. */
export class BackgroundJobs {
  private readonly jobs = new Map<string, Job>()
  private sequence = 0

  constructor(
    private readonly session: VelaSession,
    private readonly shellPath: () => string,
    private readonly logger: VelaLogger,
  ) {}

  /** Commands still running: the session stays open while this is above zero. */
  get running(): number {
    return [...this.jobs.values()].filter((job) => job.state === 'running')
      .length
  }

  start(command: string): { id: string; pid?: number } {
    const id = `bg-${++this.sequence}`
    const output = new OutputTail()
    let child: ChildProcess
    try {
      child = spawn(this.shellPath(), ['-lc', command], {
        cwd: this.session.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX process groups and Windows taskkill /T stop pipelines and descendants.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      throw new Error(
        `Could not start background command: ${errorMessage(error)}`,
      )
    }
    const job: Job = { id, command, child, output, state: 'running' }
    this.jobs.set(id, job)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => output.append(chunk))
    child.stderr?.on('data', (chunk: string) => output.append(chunk))
    child.once('error', (error) => {
      if (job.state === 'exited') return
      job.state = 'exited'
      this.deliver(
        `Background command ${id} could not start: ${errorMessage(error)}.`,
        job,
      )
    })
    child.once('exit', (code, signal) => {
      if (job.state === 'exited') return
      job.state = 'exited'
      job.exitCode = exitCodeOf(code, signal)
      if (job.silent) return
      const state = job.stopped
        ? 'was stopped'
        : `finished with exit code ${job.exitCode}`
      this.deliver(`Background command ${id} ${state}.`, job)
    })
    return { id, ...(child.pid === undefined ? {} : { pid: child.pid }) }
  }

  snapshot(id: string): JobSnapshot {
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
  async stop(id: string): Promise<JobSnapshot> {
    const job = this.job(id)
    if (job.state === 'running') {
      job.stopped = true
      job.silent = true
      await this.terminate(job)
    }
    return this.snapshot(id)
  }

  /**
   * End every job with its session (Stop, close, shutdown). These exits are not delivered: the
   * run that would answer is gone, and a close must not start a new one.
   */
  async stopAll(): Promise<void> {
    const running = [...this.jobs.values()].filter(
      (job) => job.state === 'running',
    )
    for (const job of running) {
      job.stopped = true
      job.silent = true
    }
    await Promise.all(running.map((job) => this.terminate(job)))
  }

  private job(id: string): Job {
    const job = this.jobs.get(id)
    if (!job)
      throw new Error(
        `Unknown background command ${id}. It may have ended with a restart or session close.`,
      )
    return job
  }

  /** SIGTERM the process group, SIGKILL it after the grace period, and wait for exit. */
  private async terminate(job: Job): Promise<void> {
    if (job.state === 'exited') return
    const exited = new Promise<void>((resolve) => {
      job.child.once('exit', () => resolve())
      job.child.once('error', () => resolve())
    })
    const kill = (signal: NodeJS.Signals) => {
      const pid = job.child.pid
      if (pid === undefined) return
      try {
        if (process.platform === 'win32') job.child.kill(signal)
        else process.kill(-pid, signal)
      } catch (error) {
        if (
          !(error && typeof error === 'object' && 'code' in error) ||
          error.code !== 'ESRCH'
        ) {
          job.child.kill(signal)
        }
      }
    }
    const startedAt = Date.now()
    kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_GRACE_MS)
    })
    try {
      await Promise.race([exited, grace])
    } finally {
      clearTimeout(timer)
    }
    // The shell can exit on SIGTERM while descendants are still shutting down (or ignoring it), and
    // its exit is neither the group finishing nor a reason to shorten the grace. Wait for the rest
    // of the group until the deadline, then escalate.
    while (
      process.platform !== 'win32' &&
      groupAlive(job) &&
      Date.now() - startedAt < STOP_GRACE_MS
    )
      await delay(20)
    if (process.platform !== 'win32' && groupAlive(job)) kill('SIGKILL')
    await exited
  }

  private deliver(status: string, job: Job): void {
    const { text, truncated } = job.output.read()
    const output = text
      ? `${text}${truncated ? '\n\n[Showing the last output only]' : ''}`
      : '(no output)'
    const result = {
      id: job.id,
      command: job.command,
      text: `${status}\nCommand: ${commandHead(job.command)}\nOutput:\n${output}`,
    }
    const delivery = backgroundDelivery(this.session)
    const send = delivery
      ? Promise.resolve(delivery(this.session, result))
      : this.session.sendMessage(
          { customType: 'background', content: result.text, display: false },
          { triggerTurn: true, deliverAs: 'followUp' },
        )
    void send.catch((error) =>
      this.logger.error(
        `[background] Could not deliver ${job.id}: ${errorMessage(error)}`,
      ),
    )
  }
}
