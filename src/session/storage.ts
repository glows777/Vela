import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { silentLogger, type VelaLogger } from '../logger.ts'
import type { ThinkingLevel } from '../models/index.ts'

/** Session file format version written now. Bump it on incompatible changes and migrate older versions on load (like pi). */
export const SESSION_FORMAT_VERSION = 1

/** Content of one session save (the full history after compaction). */
export interface SessionCheckpoint {
  type: 'checkpoint'
  /** Format version; always written by Vela, older files without it are read as 1 */
  version?: number
  timestamp: string
  /** Context summary (empty string if never compacted) */
  summary: string
  messages: { timestamp: string; message: ModelMessage }[]
  /** @internal Tool call history id and progress (used to verify the tool history file on resume) */
  toolHistoryId?: string
  /** @internal */
  toolHistorySeq?: number
  /** @internal */
  toolHistoryViewSeq?: number
  /** Session model `provider/id` (only when chosen with setModel and resolvable by name); restored on resume */
  model?: string
  /** Session thinking level; restored on resume */
  thinkingLevel?: ThinkingLevel
  /** Session display name (`session.setName()`, the CLI's /name) */
  name?: string
}

/** One `SessionStorage.list()` entry, used by the session picker and `vela.listSessions()`. */
export interface SessionSummary {
  id: string
  name?: string
  /** Time of the last save (ISO) */
  updatedAt: string
  messageCount: number
  /** Start of the first user message (empty string if none) */
  firstMessage: string
}

/**
 * Session storage (injectable, like pi's SessionManager): file and memory are built in, or plug in a database.
 * Every save is a full checkpoint; load returns the most recent save.
 */
export interface SessionStorage {
  load(id: string): Promise<SessionCheckpoint | undefined>
  save(id: string, checkpoint: SessionCheckpoint): Promise<void>
  /** Lists saved sessions, newest first (like pi's SessionManager.list). Custom storage may skip it; the list is then empty. */
  list?(): Promise<SessionSummary[]>
}

/** Sorts by last save, newest first. Sessions without messages are left out (nothing to continue; like pi not writing empty session files). */
function newestFirst(summaries: SessionSummary[]): SessionSummary[] {
  return summaries
    .filter((s) => s.messageCount > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** checkpoint → list entry */
export function summarizeCheckpoint(
  id: string,
  checkpoint: SessionCheckpoint,
): SessionSummary {
  const first = checkpoint.messages.find((m) => m.message.role === 'user')
  const content = first?.message.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => ('text' in part ? String(part.text) : ''))
            .join('')
        : ''
  return {
    id,
    ...(checkpoint.name ? { name: checkpoint.name } : {}),
    updatedAt: checkpoint.timestamp,
    messageCount: checkpoint.messages.length,
    firstMessage: text.replace(/\s+/g, ' ').trim().slice(0, 120),
  }
}

/** Memory storage: gone when the process exits (the CLI's --no-session; the SDK default without dataDir). */
export function memorySessionStorage(): SessionStorage {
  const checkpoints = new Map<string, SessionCheckpoint>()
  return {
    load: async (id) => {
      const found = checkpoints.get(id)
      return found && structuredClone(found)
    },
    save: async (id, checkpoint) => {
      checkpoints.set(id, structuredClone(checkpoint))
    },
    list: async () =>
      newestFirst(
        [...checkpoints].map(([id, checkpoint]) =>
          summarizeCheckpoint(id, checkpoint),
        ),
      ),
  }
}

/** File storage: `<dir>/<id>.jsonl`, written by atomic replace, mode 0600. */
export function fileSessionStorage(
  dir: string,
  logger: VelaLogger = silentLogger,
): SessionStorage {
  const pathOf = (id: string) => join(dir, `${id}.jsonl`)
  return {
    async load(id) {
      const path = pathOf(id)
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      return parseSessionFile(text, path, logger)
    },
    async save(id, checkpoint) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const path = pathOf(id)
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(`${JSON.stringify(checkpoint)}\n`)
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
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
        const path = pathOf(id)
        const checkpoint = parseSessionFile(
          await readFile(path, 'utf8'),
          path,
          logger,
        )
        // The old format (one message per line) has no checkpoint time: use the file mtime
        const summary = summarizeCheckpoint(id, checkpoint)
        if (!checkpoint.saved)
          summary.updatedAt = (await stat(path)).mtime.toISOString()
        summaries.push(summary)
      }
      return newestFirst(summaries)
    },
  }
}

interface MessageEntry {
  type: 'message'
  timestamp: string
  message: ModelMessage
}

/**
 * Parses a session file: message lines after the last checkpoint are appended to it (the old format is one message per line).
 * Bad lines are skipped and logged.
 */
function parseSessionFile(
  content: string,
  path: string,
  logger: VelaLogger,
): SessionCheckpoint & { saved?: true } {
  let checkpoint: SessionCheckpoint & { saved?: true } = {
    type: 'checkpoint',
    timestamp: new Date().toISOString(),
    summary: '',
    messages: [],
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as MessageEntry | SessionCheckpoint
      if (entry.type === 'message')
        checkpoint.messages.push({
          timestamp: entry.timestamp,
          message: entry.message,
        })
      else if (entry.type === 'checkpoint' && Array.isArray(entry.messages))
        checkpoint = { ...entry, summary: entry.summary || '', saved: true }
    } catch (error) {
      logger.warn(`[session] Skipped an unparsable line in ${path}: ${error}`)
    }
  }
  return checkpoint
}
