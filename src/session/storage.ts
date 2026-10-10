import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
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

export {
  migrateSessionV1,
  SESSION_FORMAT_VERSION,
  type SessionSummary,
  summarizeSession,
} from './entries.ts'

/**
 * Session storage (injectable, like pi's SessionManager): file and memory are built in, or plug in a database.
 * A session is an append-only list of entries (pi's format): a header, then one entry per message,
 * compaction, setting change, … Entries are never rewritten.
 */
export interface SessionStorage {
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

/** Memory storage: gone when the process exits (the CLI's --no-session; the SDK default without dataDir). */
export function memorySessionStorage(): SessionStorage {
  const sessions = new Map<string, SessionFileEntry[]>()
  return {
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
}

/**
 * File storage: `<dir>/<id>.jsonl`, one entry per line, appended (like pi), mode 0600.
 * A version-1 file (one checkpoint) is converted and rewritten by atomic replace when loaded.
 */
export function fileSessionStorage(
  dir: string,
  logger: VelaLogger = silentLogger,
): SessionStorage {
  const pathOf = (id: string) => join(dir, `${id}.jsonl`)
  const read = async (id: string) => {
    const path = pathOf(id)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    return { path, text, lines: parseLines(text, path, logger) }
  }
  return {
    async load(id) {
      const file = await read(id)
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
      await appendFile(
        pathOf(id),
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        { mode: 0o600 },
      )
    },
    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const summaries: SessionSummary[] = []
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const id = name.slice(0, -'.jsonl'.length)
        const file = await read(id)
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
