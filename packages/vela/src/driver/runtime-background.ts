import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import { BackgroundJobManager, jobStopKey } from '../runtime/background-jobs.ts'
import { errorMessage } from '../shared/logger.ts'
import type {
  ExecutionError,
  ExecutionLocation,
  Result,
  ShellExecResult,
} from './execution/types.ts'
import type {
  BackgroundAdmission,
  BackgroundCommands,
  BackgroundSnapshot,
  BackgroundTask,
  CommandExit,
  ForegroundCommand,
} from './tools/background.ts'
import { OutputTail } from './tools/output-tail.ts'

const COMMAND_HEAD = 160
const DEFAULT_LIMIT_MS = 30 * 60_000
const MAX_LIMIT_MS = 2 * 60 * 60_000

function headOf(command: string): string {
  const head = command.trim().split('\n')[0]!.trim()
  return head.length > COMMAND_HEAD ? `${head.slice(0, COMMAND_HEAD)}…` : head
}

interface LiveRuntimeJob {
  id: string
  token: string
  command: string
  startedAt: number
  endedAt?: number
  deadline?: ReturnType<typeof setTimeout>
  timedOut?: boolean
  controller: AbortController
  output: OutputTail
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  fullOutputPath?: string
  finished: Promise<void>
}

class LiveForeground {
  state: 'foreground' | 'moved' | 'withdrawn' = 'foreground'
  readonly startedAt = Date.now()
  settled = false
  readonly detached = Promise.withResolvers<BackgroundAdmission>()
  resumeTimeout?: () => void
  exitResult!: Promise<CommandExit>

  constructor(
    readonly command: string,
    readonly controller: AbortController,
    readonly output: OutputTail,
    readonly toolCallId?: string,
    readonly runSignal?: AbortSignal,
    readonly excludeFromContext = false,
    private readonly suspendTimeout?: () => (() => void) | undefined,
  ) {}

  readonly forward = () => {
    if (this.state === 'foreground') {
      this.controller.abort(this.runSignal?.reason)
    }
  }

  follow(): void {
    const resume = this.resumeTimeout
    this.resumeTimeout = undefined
    if (this.runSignal?.aborted) {
      this.state = 'withdrawn'
      this.controller.abort(this.runSignal.reason)
      return
    }
    this.state = 'foreground'
    this.runSignal?.addEventListener('abort', this.forward, { once: true })
    resume?.()
  }

  unfollow(): void {
    this.state = 'moved'
    this.runSignal?.removeEventListener('abort', this.forward)
    this.resumeTimeout = this.suspendTimeout?.()
  }
}

export interface RuntimeBackgroundController extends BackgroundCommands {
  watch<S>(options: {
    command: string
    toolCallId?: string
    signal?: AbortSignal
    output: OutputTail
    start: (signal: AbortSignal) => Promise<S>
    exit: (settled: S) => CommandExit
    excludeFromContext?: boolean
    suspendTimeout?: () => (() => void) | undefined
  }): ForegroundCommand<S>
  setRunContext(ctx: {
    runId: string
    wakeSession?: (sessionId: string) => void
    location?: ExecutionLocation
  }): void
  hasRunningJobs(): boolean
}

/**
 * Connects `ToolRegistry.background` inside `createVelaAgentDriver` to Runtime's
 * durable `BackgroundJobManager` (`background_jobs` + `inbox_events` wake).
 */
export function createRuntimeBackgroundController(params: {
  db: VelaDatabase
  sessionId: string
  runId: string
  wakeSession?: (sessionId: string) => void
  location: ExecutionLocation
}): RuntimeBackgroundController {
  const { db, sessionId } = params
  let currentRunId = params.runId
  let currentWake = params.wakeSession
  let currentLocation = params.location
  const manager = new BackgroundJobManager(db, (sid) => currentWake?.(sid))
  const jobs = new Map<string, LiveRuntimeJob>()
  const foreground = new Set<LiveForeground>()
  let seq = 0

  const toSnapshot = (job: LiveRuntimeJob): BackgroundSnapshot => {
    const { text, truncated } = job.output.read()
    return {
      id: job.id,
      command: job.command,
      state: job.state,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.stopped ? { stopped: true } : {}),
      output: text,
      truncated,
      ...(job.fullOutputPath ? { fullOutputPath: job.fullOutputPath } : {}),
    }
  }

  const registerJob = (opts: {
    id: string
    token: string
    command: string
    startedAt: number
    controller: AbortController
    output: OutputTail
  }): { job: LiveRuntimeJob; clearPoll: () => void } => {
    const job: LiveRuntimeJob = {
      id: opts.id,
      token: opts.token,
      command: opts.command,
      startedAt: opts.startedAt,
      controller: opts.controller,
      output: opts.output,
      state: 'running',
      finished: Promise.resolve(),
    }
    jobs.set(opts.id, job)

    if (
      db.open &&
      db.get<{ id: string }>('SELECT id FROM sessions WHERE id = ?', sessionId)
    ) {
      manager.recordStart({
        id: opts.token,
        sessionId,
        runId: currentRunId,
        command: opts.command,
        commandHead: headOf(opts.command),
        location: currentLocation,
        abort: () => {
          job.stopped = true
          opts.controller.abort(new DOMException('Stopped', 'AbortError'))
        },
      })
    }

    let stopPoll: ReturnType<typeof setInterval> | undefined
    stopPoll = setInterval(() => {
      if (!db.open || job.state !== 'running') return
      try {
        const row = db.get<{ key: string }>(
          'SELECT key FROM kv_meta WHERE key = ?',
          jobStopKey(opts.token),
        )
        if (row) {
          db.run('DELETE FROM kv_meta WHERE key = ?', jobStopKey(opts.token))
          job.stopped = true
          opts.controller.abort(new DOMException('Stopped', 'AbortError'))
        }
      } catch {}
    }, 50)
    stopPoll.unref?.()

    return {
      job,
      clearPoll: () => {
        if (stopPoll) {
          clearInterval(stopPoll)
          stopPoll = undefined
        }
      },
    }
  }

  const settleJob = (
    job: LiveRuntimeJob,
    clearPoll: () => void,
    status: 'completed' | 'failed' | 'stopped',
    exitCode: number | undefined,
    outputPath: string | undefined,
    errText?: string,
  ) => {
    clearTimeout(job.deadline)
    clearPoll()
    job.state = 'exited'
    job.endedAt = Date.now()
    job.exitCode = exitCode
    job.fullOutputPath = outputPath
    const { text, truncated } = job.output.read()
    const tail = text
      ? `${text}${truncated ? '\n\n[Showing the last output only]' : ''}`
      : '(no output)'
    const headline = job.timedOut
      ? `Background command "${job.id}" was stopped after reaching its background time limit.`
      : errText !== undefined
        ? `Background command ${job.id} could not start or run: ${errText}.`
        : exitCode === undefined
          ? `Background command ${job.id} finished.`
          : `Background command ${job.id} finished with exit code ${exitCode}.`
    const summaryText = `${headline}\nCommand: ${headOf(job.command)}\nOutput:\n${tail}${
      outputPath ? `\nFull output: ${outputPath}` : ''
    }`
    if (db.open) {
      try {
        db.run('DELETE FROM kv_meta WHERE key = ?', jobStopKey(job.token))
        manager.recordFinish({
          id: job.token,
          status,
          exitCode: exitCode ?? null,
          outputPath: outputPath ?? null,
          summaryText,
          silent: Boolean(job.stopped && !job.timedOut),
        })
      } catch {}
    }
  }

  const settleFromCommandExit = (
    job: LiveRuntimeJob,
    clearPoll: () => void,
    exit: CommandExit,
  ) => {
    if (job.stopped) {
      settleJob(job, clearPoll, 'stopped', exit.exitCode, exit.spillPath)
      return
    }
    if (exit.error !== undefined) {
      settleJob(job, clearPoll, 'failed', undefined, exit.spillPath, exit.error)
      return
    }
    const code = exit.exitCode
    settleJob(
      job,
      clearPoll,
      (code ?? 0) === 0 ? 'completed' : 'failed',
      code,
      exit.spillPath,
    )
  }

  const attachJobDeadline = (
    job: LiveRuntimeJob,
    controller: AbortController,
    timeout?: number,
  ) => {
    const hasTimeout =
      timeout !== undefined && Number.isFinite(timeout) && timeout > 0
    const limit = hasTimeout
      ? Math.min(timeout * 1000, MAX_LIMIT_MS)
      : DEFAULT_LIMIT_MS
    job.deadline = setTimeout(() => {
      if (controller.signal.aborted) return
      job.timedOut = true
      job.stopped = true
      controller.abort(new DOMException('Time limit', 'AbortError'))
    }, limit)
    job.deadline.unref?.()
  }

  const moveForegroundEntry = (entry: LiveForeground): string => {
    const id = `bg-${++seq}`
    const token = randomUUID()
    let registered: { job: LiveRuntimeJob; clearPoll: () => void } | undefined
    try {
      registered = registerJob({
        id,
        token,
        command: entry.command,
        startedAt: entry.startedAt,
        controller: entry.controller,
        output: entry.output,
      })
    } catch (error) {
      jobs.delete(id)
      entry.follow()
      throw error
    }
    const { job, clearPoll } = registered
    if (entry.settled) {
      clearPoll()
      job.stopped = true
      job.state = 'exited'
      jobs.delete(id)
      if (db.open) {
        try {
          manager.recordFinish({
            id: token,
            status: 'stopped',
            silent: true,
          })
        } catch {}
      }
      throw new Error(
        'The command finished while it was being moved to the background; its result came from the call.',
      )
    }
    entry.resumeTimeout = undefined
    attachJobDeadline(job, entry.controller)
    job.finished = entry.exitResult.then(
      (exit) => settleFromCommandExit(job, clearPoll, exit),
      (error) =>
        settleJob(
          job,
          clearPoll,
          job.stopped ? 'stopped' : 'failed',
          undefined,
          undefined,
          errorMessage(error),
        ),
    )
    const { text, truncated } = entry.output.read()
    entry.detached.resolve({ id, output: text, truncated })
    return id
  }

  return {
    setRunContext(ctx: {
      runId: string
      wakeSession?: (sessionId: string) => void
      location?: ExecutionLocation
    }) {
      currentRunId = ctx.runId
      currentWake = ctx.wakeSession
      if (ctx.location) currentLocation = ctx.location
    },

    hasRunningJobs(): boolean {
      for (const job of jobs.values()) {
        if (job.state === 'running') return true
      }
      return false
    },

    async adopt({
      command,
      timeout,
      start,
      signal,
    }): Promise<BackgroundAdmission> {
      const id = `bg-${++seq}`
      const token = randomUUID()
      const controller = new AbortController()
      const output = new OutputTail()
      const onSignalAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', onSignalAbort, { once: true })

      let job!: LiveRuntimeJob
      let clearPoll!: () => void
      try {
        signal?.throwIfAborted()
        ;({ job, clearPoll } = registerJob({
          id,
          token,
          command,
          startedAt: Date.now(),
          controller,
          output,
        }))
      } catch (error) {
        jobs.delete(id)
        signal?.removeEventListener('abort', onSignalAbort)
        throw error
      }

      signal?.removeEventListener('abort', onSignalAbort)
      attachJobDeadline(job, controller, timeout)

      job.finished = Promise.resolve()
        .then(() =>
          start({
            onOutput: (chunk) => job.output.append(chunk),
            signal: controller.signal,
          }),
        )
        .then(
          (res: Result<ShellExecResult, ExecutionError>) => {
            if (job.stopped) {
              settleJob(
                job,
                clearPoll,
                'stopped',
                res.ok ? res.value.exitCode : undefined,
                res.ok ? res.value.spillPath : res.error.spillPath,
              )
              return
            }
            if (res.ok) {
              const code = res.value.exitCode
              settleJob(
                job,
                clearPoll,
                code === 0 ? 'completed' : 'failed',
                code,
                res.value.spillPath,
              )
            } else {
              settleJob(
                job,
                clearPoll,
                'failed',
                undefined,
                res.error.spillPath,
                res.error.message,
              )
            }
          },
          (error) => {
            settleJob(
              job,
              clearPoll,
              job.stopped ? 'stopped' : 'failed',
              undefined,
              undefined,
              errorMessage(error),
            )
          },
        )

      const { text, truncated } = job.output.read()
      return { id, output: text, truncated }
    },

    watch<S>({
      command,
      toolCallId,
      signal,
      output,
      start,
      exit,
      excludeFromContext,
      suspendTimeout,
    }: {
      command: string
      toolCallId?: string
      signal?: AbortSignal
      output: OutputTail
      start: (signal: AbortSignal) => Promise<S>
      exit: (settled: S) => CommandExit
      excludeFromContext?: boolean
      suspendTimeout?: () => (() => void) | undefined
    }): ForegroundCommand<S> {
      const entry = new LiveForeground(
        command,
        new AbortController(),
        output,
        toolCallId,
        signal,
        excludeFromContext === true,
        suspendTimeout,
      )
      foreground.add(entry)
      entry.follow()
      const result = Promise.resolve().then(() =>
        start(entry.controller.signal),
      )
      void result.then(
        () => {
          entry.settled = true
        },
        () => {
          entry.settled = true
        },
      )
      entry.exitResult = result
        .then(exit, (cause) => ({ error: errorMessage(cause) }))
        .finally(() => {
          foreground.delete(entry)
          entry.runSignal?.removeEventListener('abort', entry.forward)
        })
      return {
        result,
        detached: entry.detached.promise,
      }
    },

    async detach(toolCallId?: string): Promise<string[]> {
      const live = [...foreground].filter(
        (entry) => entry.state === 'foreground',
      )
      const claimable = live.filter((entry) => !entry.excludeFromContext)
      const targets =
        toolCallId === undefined
          ? claimable
          : claimable.filter((entry) => entry.toolCallId === toolCallId)
      if (toolCallId !== undefined && targets.length === 0) {
        const running = live
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
        if (entry.state !== 'foreground' || entry.settled) continue
        entry.unfollow()
        ids.push(moveForegroundEntry(entry))
      }
      return ids
    },

    snapshot(id: string): BackgroundSnapshot {
      const job = jobs.get(id)
      if (!job) throw new Error(`Unknown background command ${id}`)
      return toSnapshot(job)
    },

    tasks(): BackgroundTask[] {
      return [...jobs.values()].map((job) => ({
        snapshot: toSnapshot(job),
        startedAt: job.startedAt,
        ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
      }))
    },

    async stop(id: string): Promise<BackgroundSnapshot> {
      const job = jobs.get(id)
      if (!job) throw new Error(`Unknown background command ${id}`)
      job.stopped = true
      job.controller.abort(new DOMException('Stopped', 'AbortError'))
      await job.finished
      const snap = toSnapshot(job)
      jobs.delete(id)
      return snap
    },

    async stopAll(): Promise<void> {
      for (const job of jobs.values()) {
        job.stopped = true
        job.controller.abort(new DOMException('Stopped', 'AbortError'))
      }
      await Promise.allSettled([...jobs.values()].map((j) => j.finished))
    },
  }
}
