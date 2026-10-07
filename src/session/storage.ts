import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { silentLogger, type VelaLogger } from '../logger.ts'
import type { ThinkingLevel } from '../models/index.ts'

/** 一次保存的会话内容（压缩后的完整历史）。 */
export interface SessionCheckpoint {
  type: 'checkpoint'
  timestamp: string
  /** 上下文摘要（没压缩过时为空串） */
  summary: string
  messages: { timestamp: string; message: ModelMessage }[]
  /** @internal 工具调用历史的标识和进度（恢复时校验工具历史文件） */
  toolHistoryId?: string
  /** @internal */
  toolHistorySeq?: number
  /** @internal */
  toolHistoryViewSeq?: number
  /** 会话用的模型 `provider/id`（用 setModel 选过、能按名字找回时才有），恢复时还原 */
  model?: string
  /** 会话的 thinking 级别，恢复时还原 */
  thinkingLevel?: ThinkingLevel
  /** 会话的显示名（`session.setName()`、CLI 的 /name） */
  name?: string
}

/** `SessionStorage.list()` 的一项：会话选择器、`vela.listSessions()` 用。 */
export interface SessionSummary {
  id: string
  name?: string
  /** 最近一次保存的时间（ISO） */
  updatedAt: string
  messageCount: number
  /** 第一条用户消息的开头（没有时为空串） */
  firstMessage: string
}

/**
 * 会话存储（同 pi 的 SessionManager 可注入）：内置文件和内存两种，也可以接数据库。
 * 每次保存都是完整的 checkpoint，load 返回最近一次保存的内容。
 */
export interface SessionStorage {
  load(id: string): Promise<SessionCheckpoint | undefined>
  save(id: string, checkpoint: SessionCheckpoint): Promise<void>
  /** 列出保存过的会话，最近的在前（同 pi 的 SessionManager.list）。自定义存储可以不实现，列表就是空的。 */
  list?(): Promise<SessionSummary[]>
}

/** 按最近保存时间排序（新的在前）；没有消息的会话不列（没东西可接着聊，同 pi 不写空会话文件）。 */
function newestFirst(summaries: SessionSummary[]): SessionSummary[] {
  return summaries
    .filter((s) => s.messageCount > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** checkpoint → 列表项 */
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

/** 内存存储：进程结束就没了（CLI 的 --no-session，SDK 不给 dataDir 时的默认）。 */
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

/** 文件存储：`<dir>/<id>.jsonl`，原子替换写入，权限 0600。 */
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
        // 旧格式（一行一条消息）没有 checkpoint 时间：用文件修改时间
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
 * 解析会话文件：最后一个 checkpoint 之后的 message 行接在它后面（旧格式是一行一条消息）。
 * 坏行跳过并记日志。
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
      logger.warn(`[session] ${path} 有一行无法解析，已跳过: ${error}`)
    }
  }
  return checkpoint
}
