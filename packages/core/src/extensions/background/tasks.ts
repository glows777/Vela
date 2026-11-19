import type {
  BackgroundCommands,
  BackgroundTask,
} from '../../tools/background.ts'

/** How many tail lines one job shows: enough to see progress, short enough to scan. */
const TAIL_LINES = 10
/** The command head in a `/tasks` row; the id, state and clock come first. */
const COMMAND_HEAD = 80

/** Whole seconds as a person reads a command's clock: `4s`, `1m 05s`, `1h 02m`. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function commandHead(command: string): string {
  const head = command.trim().split('\n')[0]!.trim()
  return head.length > COMMAND_HEAD
    ? `${head.slice(0, COMMAND_HEAD - 1)}…`
    : head
}

function stateOf(task: BackgroundTask): string {
  const { snapshot } = task
  if (snapshot.state === 'running') return 'running'
  if (snapshot.stopped) return 'stopped'
  return snapshot.exitCode === undefined
    ? 'exited'
    : `exited (${snapshot.exitCode})`
}

/** One job: id, state, elapsed time and command head, then its output tail. */
function taskText(task: BackgroundTask, now: number): string[] {
  const { snapshot } = task
  const lines = [
    `${snapshot.id} · ${stateOf(task)} · ${duration((task.endedAt ?? now) - task.startedAt)} · $ ${commandHead(snapshot.command)}`,
  ]
  const tail = snapshot.output.trimEnd()
  const all = tail ? tail.split('\n') : []
  const hidden = Math.max(0, all.length - TAIL_LINES)
  if (hidden) lines.push(`  … ${hidden} earlier lines`)
  if (all.length) for (const line of all.slice(hidden)) lines.push(`  ${line}`)
  else lines.push('  (no output)')
  if (snapshot.truncated) lines.push('  [Showing the last output only]')
  if (snapshot.fullOutputPath)
    lines.push(`  Full output: ${snapshot.fullOutputPath}`)
  return lines
}

/**
 * `/tasks` lists every job the session still holds; `/tasks stop <id>` ends one through the same
 * stop as `background_stop` and answers with its final tail. The command's only arguments are an
 * optional `stop` and the id.
 */
export async function tasks(
  args: string,
  commands: BackgroundCommands,
): Promise<string> {
  const [action, id] = args.split(/\s+/).filter(Boolean)
  if (!action) {
    const all = commands.tasks()
    if (!all.length) return 'No background tasks'
    const now = Date.now()
    return [
      `[tasks] ${all.length} background ${all.length === 1 ? 'task' : 'tasks'}`,
      ...all.flatMap((task, index) =>
        index ? ['', ...taskText(task, now)] : taskText(task, now),
      ),
    ].join('\n')
  }
  if (action !== 'stop' || !id) return 'Usage: /tasks [stop <id>]'
  // The job leaves the table with the stop, so its start comes from the row read just before.
  const started = commands.tasks().find((task) => task.snapshot.id === id)
  const snapshot = await commands.stop(id)
  return taskText(
    {
      snapshot,
      startedAt: started?.startedAt ?? Date.now(),
      endedAt: Date.now(),
    },
    Date.now(),
  ).join('\n')
}
