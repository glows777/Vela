import type { Dirent } from 'node:fs'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import { silentLogger, type VelaLogger } from '../logger.ts'
import {
  isSessionV1,
  migrateSessionV1,
  type SessionFileEntry,
  type SessionSummary,
  summarizeSession,
} from './entries.ts'

export type { SessionSummary } from './entries.ts'

/**
 * Where a session's history is kept.
 * `file`: one jsonl file. It may not exist until the first user or assistant message is persisted.
 * `memory`: process memory only; nothing is written and the session cannot be resumed.
 * `unknown`: the storage did not say. It may still be durable; there is no path to show.
 */
export type SessionPersistence =
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'memory' }
  | { readonly type: 'unknown' }

/**
 * Session storage (injectable, like pi's SessionManager): file and memory are built in, or plug in a database.
 * A session is an append-only list of entries (pi's format): a header, then one entry per message,
 * compaction, setting change, … Entries are never rewritten.
 */
export interface SessionStorage {
  /**
   * Where this session is kept. File storage returns the jsonl path; memory storage returns
   * `{ type: 'memory' }`. Custom storage may omit this. Omitting it means the location is
   * unknown, not that the session is unsaved.
   */
  persistence?(id: string): SessionPersistence
  /** The session's header and entries in append order, or undefined if nothing was ever appended. */
  load(id: string): Promise<SessionFileEntry[] | undefined>
  /** Appends entries in order. The first append of a new session starts with its header. */
  append(id: string, entries: SessionFileEntry[]): Promise<void>
  /** Lists saved sessions, newest first (like pi's SessionManager.list). Custom storage may skip it; the list is then empty. */
  list?(): Promise<SessionSummary[]>
}

/** Sorts by last entry, newest first. Sessions without messages are left out (nothing to continue). */
function newestFirst(summaries: SessionSummary[]): SessionSummary[] {
  return summaries
    .filter((s) => s.messageCount > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Storage that says whether a session is a file or only in memory. */
type ReportingStorage = SessionStorage & {
  persistence(id: string): SessionPersistence
}

/** Memory storage: gone when the process exits (the CLI's --no-session; the SDK default without dataDir). */
export function memorySessionStorage(): SessionStorage {
  const sessions = new Map<string, SessionFileEntry[]>()
  const storage: ReportingStorage = {
    persistence: () => ({ type: 'memory' }),
    load: async (id) => {
      const found = sessions.get(id)
      return found && structuredClone(found)
    },
    append: async (id, entries) => {
      const list = sessions.get(id) ?? []
      list.push(...structuredClone(entries))
      sessions.set(id, list)
    },
    list: async () =>
      newestFirst(
        [...sessions].map(([id, entries]) => summarizeSession(id, entries)),
      ),
  }
  return storage
}

/**
 * Whether tool history, long tool output and the usage log belong under the data directory.
 * `--no-session` is memory storage on a real data directory: those must not land there.
 * With no `dataDir`, the SDK's temporary directory is removed by `dispose()`, so writing there is fine.
 */
export function sessionArtifactsUseDataDir(
  storage: SessionStorage,
  id: string,
  temporaryDataDir = false,
): boolean {
  return temporaryDataDir || storage.persistence?.(id)?.type !== 'memory'
}

/**
 * File storage: `<dir>/<id>/transcript.jsonl`, one entry per line, appended (like pi), mode 0600.
 * A 0.5.0 flat file `<dir>/<id>.jsonl` is moved into that directory when the session is first read
 * or written. A version-1 file (one checkpoint) is converted and rewritten by atomic replace when loaded.
 */
export function fileSessionStorage(
  dir: string,
  logger: VelaLogger = silentLogger,
): SessionStorage {
  const transcriptOf = (id: string) => join(dir, id, 'transcript.jsonl')
  const flatOf = (id: string) => join(dir, `${id}.jsonl`)

  const exists = async (path: string) => {
    try {
      await stat(path)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // `<dir>/<id>` is a file: the transcript below it cannot exist
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw error
    }
  }
  const isFile = async (path: string) => {
    try {
      return (await stat(path)).isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /** Makes `<dir>/<id>/` usable, converting a flat session that occupies the name first. */
  const makeDirectory = async (id: string): Promise<void> => {
    const target = join(dir, id)
    let blocked = false
    try {
      await mkdir(target, { recursive: true, mode: 0o700 })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTDIR') throw error
      blocked = true
    }
    if (!blocked) return
    // Ids may contain `.`, so the flat file of session `a.jsonl` is the directory session `a` needs.
    // Converting that session first frees the name; every step drops one `.jsonl`, so the chain ends.
    const owner = id.endsWith('.jsonl') ? id.slice(0, -'.jsonl'.length) : ''
    if (!owner || !(await isFile(target)))
      throw new Error(
        `Cannot store session ${id}: ${target} exists and is not a session transcript`,
      )
    await convert(owner)
    await mkdir(target, { recursive: true, mode: 0o700 })
  }

  /** Moves a 0.5.0 flat transcript into `<dir>/<id>/transcript.jsonl` with one rename inside `dir`. */
  const convert = async (id: string): Promise<void> => {
    const flat = flatOf(id)
    if (!(await exists(flat))) return
    await makeDirectory(id)
    try {
      await rename(flat, transcriptOf(id))
    } catch (error) {
      // Another process may have converted it first: only trust that when the new path is there
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        !(await exists(transcriptOf(id)))
      )
        throw error
    }
  }

  /** The transcript to read and append to; converts a flat session first, undefined when there is none yet. */
  const resolve = async (id: string): Promise<string | undefined> => {
    if (await exists(transcriptOf(id))) return transcriptOf(id)
    if (!(await exists(flatOf(id)))) return undefined
    await convert(id)
    return transcriptOf(id)
  }

  const readAt = async (path: string) => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    return { path, text, lines: parseLines(text, path, logger) }
  }

  const storage: ReportingStorage = {
    persistence: (id) => ({ type: 'file', path: transcriptOf(id) }),
    async load(id) {
      const path = await resolve(id)
      const file = path ? await readAt(path) : undefined
      if (!file?.lines.length) return
      if (!isSessionV1(file.lines)) {
        // A write cut off mid-line leaves no trailing newline: end it so the next append starts a new line (like pi)
        if (!file.text.endsWith('\n')) await appendFile(file.path, '\n')
        return file.lines as SessionFileEntry[]
      }
      const entries = migrateSessionV1(id, file.lines)
      await replaceFile(file.path, entries)
      logger.info(`[session] Converted ${file.path} to session format 2`)
      return entries
    },
    async append(id, entries) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      let path = await resolve(id)
      // A new session: the transcript goes into its own directory, which the write creates
      if (!path) {
        await makeDirectory(id)
        path = transcriptOf(id)
      }
      await appendFile(
        path,
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        { mode: 0o600 },
      )
    },
    async list() {
      let names: Dirent[]
      try {
        names = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      // Listing never writes: a directory form wins over a leftover flat file of the same id
      const ids: string[] = names
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      for (const entry of names) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const id = entry.name.slice(0, -'.jsonl'.length)
        if (!ids.includes(id)) ids.push(id)
      }
      const summaries: SessionSummary[] = []
      for (const id of ids) {
        const path = (await exists(transcriptOf(id)))
          ? transcriptOf(id)
          : flatOf(id)
        const file = await readAt(path)
        if (!file) continue
        summaries.push(
          summarizeSession(
            id,
            isSessionV1(file.lines)
              ? migrateSessionV1(id, file.lines)
              : (file.lines as SessionFileEntry[]),
          ),
        )
      }
      return newestFirst(summaries)
    },
  }
  return storage
}

/** Parses JSONL; lines that are not valid JSON are skipped and logged. */
function parseLines(
  content: string,
  path: string,
  logger: VelaLogger,
): unknown[] {
  const lines: unknown[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      lines.push(JSON.parse(line))
    } catch (error) {
      logger.warn(`[session] Skipped an unparsable line in ${path}: ${error}`)
    }
  }
  return lines
}

/** Writes a whole file through a synced temp file and rename, so a crash never leaves it half-written. */
async function replaceFile(
  path: string,
  entries: SessionFileEntry[],
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
      )
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
