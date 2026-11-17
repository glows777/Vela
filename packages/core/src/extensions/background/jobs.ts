import { setTimeout as delay } from 'node:timers/promises'
import { errorMessage, type VelaLogger } from '../../logger.ts'
import type {
  BackgroundCommands,
  BackgroundSnapshot,
} from '../../tools/background.ts'
import { type RunningShell, readOutputTail } from '../../tools/shell.ts'
import type { VelaSession } from '../../vela-session.ts'

/** SIGTERM first, then SIGKILL when the process group ignores it. */
const STOP_GRACE_MS = 2000
/** The command head in a delivery message and in `background_stop`. */
const COMMAND_HEAD = 160

interface Job {
  id: string
  shell: RunningShell
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

/** Whether the process group still has members; POSIX only, and ESRCH means it is gone. */
function groupAlive(job: Job): boolean {
  const pid = job.shell.pid
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

/**
 * The jobs of one session; they die with it, and nothing is persisted. A job is a started shell
 * whose output file is also its tail, so declared and adopted commands are the same kind of job.
 */
export class BackgroundJobs implements BackgroundCommands {
  private readonly jobs = new Map<string, Job>()
  private sequence = 0

  constructor(
    private readonly session: VelaSession,
    private readonly logger: VelaLogger,
  ) {}

  adopt(shell: RunningShell): string {
    const id = `bg-${++this.sequence}`
    const job: Job = { id, shell, state: 'running' }
    this.jobs.set(id, job)
    // A channel conversation stays open while its command runs, so idle cleanup cannot kill a long build.
    this.session.trackWork(
      shell.exited.then(
        () => {},
        () => {},
      ),
    )
    void shell.exited.then(
      (run) => {
        if (job.state === 'exited') return
        job.state = 'exited'
        job.exitCode = run.exitCode
        if (job.silent) return
        const state = job.stopped
          ? 'was stopped'
          : `finished with exit code ${job.exitCode}`
        void this.deliver(`Background command ${id} ${state}.`, job)
      },
      (error) => {
        if (job.state === 'exited') return
        job.state = 'exited'
        if (job.silent) return
        void this.deliver(
          `Background command ${id} ended unexpectedly: ${errorMessage(error)}.`,
          job,
        )
      },
    )
    return id
  }

  async snapshot(id: string): Promise<BackgroundSnapshot> {
    const job = this.job(id)
    const tail = await readOutputTail(job.shell.path)
    return {
      id: job.id,
      command: job.shell.command,
      state: job.state,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.stopped ? { stopped: true } : {}),
      output: tail.text,
      truncated: tail.truncated,
    }
  }

  /** End one command; the caller already receives its tail from the tool result, so this never delivers. */
  async stop(id: string): Promise<BackgroundSnapshot> {
    const job = this.job(id)
    if (job.state === 'running') {
      job.stopped = true
      job.silent = true
      await this.terminate(job)
      job.state = 'exited'
      job.exitCode = (await job.shell.exited).exitCode
    }
    const snapshot = await this.snapshot(id)
    // The result has been handed to the caller; the job goes with it.
    this.jobs.delete(id)
    return snapshot
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
    for (const job of running) this.jobs.delete(job.id)
  }

  private job(id: string): Job {
    const job = this.jobs.get(id)
    if (!job)
      throw new Error(
        `Unknown background command ${id}. It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.`,
      )
    return job
  }

  /** SIGTERM the process group, SIGKILL it after the grace period, and wait for exit. */
  private async terminate(job: Job): Promise<void> {
    if (job.state === 'exited') return
    const exited = job.shell.exited.catch(() => undefined)
    const startedAt = Date.now()
    job.shell.signal('SIGTERM')
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
    if (process.platform !== 'win32' && groupAlive(job))
      job.shell.signal('SIGKILL')
    await exited
  }

  private async deliver(status: string, job: Job): Promise<void> {
    const path = job.shell.path
    try {
      const { text, truncated } = await readOutputTail(path)
      const output = text
        ? `${text}${truncated ? `\n\n[Showing the last output only. Full output: ${path}]` : ''}`
        : '(no output)'
      const message = `${status}\nCommand: ${commandHead(job.shell.command)}\nOutput:\n${output}`
      const host = this.session.host
      if (host) await host.deliver(message)
      else
        await this.session.sendMessage(
          { customType: 'background', content: message, display: false },
          { triggerTurn: true, deliverAs: 'followUp' },
        )
    } catch (error) {
      this.logger.error(
        `[background] Could not deliver ${job.id}: ${errorMessage(error)}`,
      )
    } finally {
      // Delivered or not, the result has left the job: its tail no longer answers for it.
      this.jobs.delete(job.id)
    }
  }
}
