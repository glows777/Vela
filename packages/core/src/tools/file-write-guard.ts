import { stat } from 'node:fs/promises'
import type { ToolContext, ToolRegistry } from './registry.ts'

/** Size and modification time of a file at one moment, used to notice changes made outside the session. */
export type FileStat = { mtimeMs: number; size: number }

type ReadChain = {
  line: number
  col: number
  fromStart: boolean
  stat: FileStat
}

const notReadError = (path: string) =>
  `Refusing to overwrite "${path}": this session has not read the whole file. Read it with read_file through to the end first, or use edit_file for a targeted change.`

const changedError = (path: string) =>
  `Refusing to overwrite "${path}": the file changed on disk since this session read or wrote it. Read it again, or use edit_file for a targeted change.`

const sameStat = (recorded: FileStat | undefined, current: FileStat) =>
  recorded !== undefined &&
  recorded.mtimeMs === current.mtimeMs &&
  recorded.size === current.size

/**
 * What one session's file tools know about the files they read and wrote. A page continues the
 * read only when it starts where the previous page ended (the footer's offset/column) and the file
 * has not changed since; reaching the end of a chain that began at the start of the file marks it
 * complete.
 */
export class SessionFileState {
  private readonly chain = new Map<string, ReadChain | 'complete'>()
  private readonly readable = new Map<string, FileStat>()
  private readonly written = new Map<string, FileStat>()

  /** Records one text page; `next` is the page's continuation, undefined at EOF. */
  noteRead(
    path: string,
    offset: number,
    column: number,
    next: { line: number; col: number } | undefined,
    stat: FileStat,
  ): void {
    const previous = this.chain.get(path)
    const startsAtBeginning = offset === 1 && column === 0
    const continues =
      previous !== undefined &&
      previous !== 'complete' &&
      previous.line === offset &&
      previous.col === column
        ? previous
        : undefined
    if (!startsAtBeginning && !continues) {
      // A page that proves nothing about the start does not erase an earlier complete read
      if (previous !== 'complete') this.chain.delete(path)
      return
    }
    if (continues && !sameStat(continues.stat, stat)) {
      // The pages cover different versions of the file, so together they prove nothing
      this.chain.delete(path)
      return
    }
    const fromStart = startsAtBeginning || continues?.fromStart === true
    if (next) {
      this.chain.set(path, { line: next.line, col: next.col, fromStart, stat })
      return
    }
    if (!fromStart) return
    this.chain.set(path, 'complete')
    this.readable.set(path, stat)
  }

  noteWritten(path: string, stat: FileStat): void {
    this.written.set(path, stat)
  }

  /** Why write_file must not replace `path`, or undefined when it may. */
  refusal(
    path: string,
    displayPath: string,
    current: FileStat | undefined,
  ): string | undefined {
    if (current === undefined) return undefined
    if (sameStat(this.readable.get(path), current)) return undefined
    if (sameStat(this.written.get(path), current)) return undefined
    if (this.readable.has(path) || this.written.has(path))
      return changedError(displayPath)
    return notReadError(displayPath)
  }
}

// Session registries are forked once per session and reused across runs, so this is per-session
// in-memory state; a resumed session gets a new registry and must read again.
const sessionStates = new WeakMap<ToolRegistry, SessionFileState>()

/** The calling session's file state; undefined outside a session (a tool called without a registry). */
export function stateFor(context?: ToolContext): SessionFileState | undefined {
  const registry = context?.registry
  if (!registry) return undefined
  let state = sessionStates.get(registry)
  if (!state) {
    state = new SessionFileState()
    sessionStates.set(registry, state)
  }
  return state
}

const isMissingPathError = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR')

/** The file's current stat, or undefined when the path does not exist or is not a regular file. */
export async function statIfExists(
  path: string,
): Promise<FileStat | undefined> {
  try {
    const stats = await stat(path)
    return stats.isFile()
      ? { mtimeMs: stats.mtimeMs, size: stats.size }
      : undefined
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

/** The file's stat after the tool read or wrote it. */
export async function fileStat(path: string): Promise<FileStat> {
  const stats = await stat(path)
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}
