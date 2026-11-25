import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { BackgroundJobManager } from '../runtime/background-jobs.ts'
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
  controller: AbortController
  output: OutputTail
  state: 'running' | 'exited'
  exitCode?: number
  stopped?: boolean
  fullOutputPath?: string
  finished: Promise<void>
}

/**
 * Connects `ToolRegistry.background` inside `createVelaAgentDriver` to Runtime's
 * durable `BackgroundJobManager` (`background_jobs` + `inbox_events` wake).
 */
export function createRuntimeBackgroundController(params: {
  db: VelaDatabase
  manager: BackgroundJobManager
  sessionId: string
  runId: string
  location: ExecutionLocation
}): BackgroundCommands {
  const { db, manager, sessionId, runId, location } = params
  const jobs = new Map<string, LiveRuntimeJob>()
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

  return {
    async adopt({ command, start, signal }): Promise<BackgroundAdmission> {
      const id = `bg-${++seq}`
      const token = randomUUID()
      const controller = new AbortController()
      const job: LiveRuntimeJob = {
        id,
        token,
        command,
        startedAt: Date.now(),
        controller,
        output: new OutputTail(),
        state: 'running',
        finished: Promise.resolve(),
      }
      jobs.set(id, job)

      const onSignalAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', onSignalAbort, { once: true })

      try {
        signal?.throwIfAborted()
        if (
          db.open &&
          db.get<{ id: string }>(
            'SELECT id FROM sessions WHERE id = ?',
            sessionId,
          )
        ) {
          manager.recordStart({
            id: token,
            sessionId,
            runId,
            command,
            commandHead: headOf(command),
            location,
            abort: () =>
              controller.abort(new DOMException('Stopped', 'AbortError')),
          })
        }
      } catch (error) {
        jobs.delete(id)
        signal?.removeEventListener('abort', onSignalAbort)
        throw error
      }

      signal?.removeEventListener('abort', onSignalAbort)

      const settleJob = (
        status: 'completed' | 'failed' | 'stopped',
        exitCode: number | undefined,
        outputPath: string | undefined,
        errText?: string,
      ) => {
        job.state = 'exited'
        job.endedAt = Date.now()
        job.exitCode = exitCode
        job.fullOutputPath = outputPath
        const { text, truncated } = job.output.read()
        const tail = text
          ? `${text}${truncated ? '\n\n[Showing the last output only]' : ''}`
          : '(no output)'
        const header =
          status === 'stopped'
            ? 'stopped'
            : errText
              ? `failed (${errText})`
              : `completed (exit code ${exitCode ?? 0})`
        const summaryText = `Background command "${headOf(command)}" ${header}.\nOutput:\n${tail}${
          outputPath ? `\nFull output: ${outputPath}` : ''
        }`
        if (db.open) {
          manager.recordFinish({
            id: token,
            status,
            exitCode: exitCode ?? null,
            outputPath: outputPath ?? null,
            summaryText,
            silent: Boolean(job.stopped),
          })
        }
      }

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
                'stopped',
                res.ok ? res.value.exitCode : undefined,
                res.ok ? res.value.spillPath : res.error.spillPath,
              )
              return
            }
            if (res.ok) {
              const code = res.value.exitCode
              settleJob(
                code === 0 ? 'completed' : 'failed',
                code,
                res.value.spillPath,
              )
            } else {
              settleJob(
                'failed',
                undefined,
                res.error.spillPath,
                res.error.message,
              )
            }
          },
          (error) => {
            settleJob(
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
      signal,
      output,
      start,
      exit,
    }: {
      command: string
      toolCallId?: string
      signal?: AbortSignal
      output: OutputTail
      start: (signal: AbortSignal) => Promise<S>
      exit: (settled: S) => CommandExit
    }): ForegroundCommand<S> {
      const controller = new AbortController()
      const forward = () => controller.abort(signal?.reason)
      if (signal?.aborted) controller.abort(signal.reason)
      else signal?.addEventListener('abort', forward, { once: true })
      const result = Promise.resolve()
        .then(() => start(controller.signal))
        .finally(() => signal?.removeEventListener('abort', forward))
      void exit
      void command
      void output
      return {
        result,
        detached: new Promise<BackgroundAdmission>(() => {}),
      }
    },

    async detach() {
      return []
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
      return toSnapshot(job)
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
