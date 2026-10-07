import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { silentLogger, type VelaLogger } from '../logger'

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
}

/**
 * 会话存储（同 pi 的 SessionManager 可注入）：内置文件和内存两种，也可以接数据库。
 * 每次保存都是完整的 checkpoint，load 返回最近一次保存的内容。
 */
export interface SessionStorage {
  load(id: string): Promise<SessionCheckpoint | undefined>
  save(id: string, checkpoint: SessionCheckpoint): Promise<void>
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
      const file = Bun.file(path)
      if (!(await file.exists())) return
      return parseSessionFile(await file.text(), path, logger)
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
): SessionCheckpoint {
  let checkpoint: SessionCheckpoint = {
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
        checkpoint = { ...entry, summary: entry.summary || '' }
    } catch (error) {
      logger.warn(`[session] ${path} 有一行无法解析，已跳过: ${error}`)
    }
  }
  return checkpoint
}
