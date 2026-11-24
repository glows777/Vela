import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { formatJsonParseError } from '../config/index.ts'
import { isPlainObject } from '../shared/interpolate.ts'
import type { VelaDatabase } from './sqlite.ts'

export interface LegacyLocalMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string
  file?: { name: string; size: number }
}

interface LegacyLocalProject {
  id: string
  cwd: string
  name: string
  sessionId: string
}

interface LegacyChannelRecord {
  key: string
  channel: string
  storageKey?: string
  chatId: string
  chatKind: 'group' | 'direct'
  rootId?: string
  threadId?: string
  task?: string
  activeSessionId: string
  previousSessionIds?: string[]
  state?: 'running' | 'waiting' | 'done' | 'stopped'
  waitingReason?: string
  createdAt?: string
  updatedAt?: string
}

export interface LegacyMigrationSummary {
  configMigrated: boolean
  trustedPaths: number
  projects: number
  sessions: number
  channelBindings: number
  messages: number
  inboxEvents: number
  timers: number
  subscriptions: number
  blobs: number
}

export interface MigrationOps {
  agentDir: string
  db: VelaDatabase
  now: string
  summary: LegacyMigrationSummary
  warnings: string[]
  createdBlobPaths: string[]
  projectByChat: Map<string, string>
  channelSessionByKey: Map<
    string,
    { sessionId: string; projectId: string | null }
  >
  fallbackLocalMessages: Map<
    string,
    { projectId: string; messages: LegacyLocalMessage[] }
  >
  ensureProject(row: {
    id: string
    name: string
    cwd?: string | null
    dataDir?: string | null
    hubSessionId?: string | null
    defaultModel?: string | null
    defaultThinkingLevel?: string | null
    defaultToolsJson?: string | null
    configJson?: string | null
  }): void
  ensureSession(row: {
    id: string
    projectId: string | null
    kind: 'chat' | 'hub' | 'topic' | 'work'
    name?: string | null
    archived?: boolean
    model?: string | null
    thinkingLevel?: string | null
    locationJson?: string | null
    leafMessageId?: string | null
    parentSessionId?: string | null
    state?: 'idle' | 'running' | 'waiting_human' | 'stopped'
    waitingReason?: string | null
    createdAt?: string
    updatedAt?: string
  }): void
  ensureChannelBinding(row: {
    channel: string
    externalId: string
    threadId?: string | null
    kind: 'group' | 'direct' | 'topic'
    projectId: string | null
    sessionId: string | null
    configJson?: string | null
  }): void
}

const PLAIN_ID = /^[A-Za-z0-9_]+$/

function legacyChannelSessionId(
  channel: string,
  conversationId: string,
  topicRootId?: string,
): string {
  const parts = [channel, conversationId]
  if (topicRootId !== undefined) parts.push(topicRootId)
  const plain = parts.join('-')
  if (parts.every((part) => PLAIN_ID.test(part)) && plain.length <= 128)
    return plain
  const hash = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 16)
  const safe = plain.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128 - 17)
  return `${safe}.${hash}`
}

export function readJsonStrict(file: string): unknown {
  const text = readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(formatJsonParseError(file, text, error))
  }
}

function mapChannelState(
  state: LegacyChannelRecord['state'],
): 'idle' | 'waiting_human' | 'stopped' {
  if (state === 'waiting') return 'waiting_human'
  if (state === 'stopped') return 'stopped'
  return 'idle'
}

function sha256File(filePath: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(filePath)
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  }
}

export function migrateTrustFile(ops: MigrationOps): void {
  const trustFile = join(ops.agentDir, 'trust.json')
  if (!existsSync(trustFile)) return
  const parsed = readJsonStrict(trustFile)
  if (!isPlainObject(parsed)) {
    throw new Error(
      `${trustFile} must be an object mapping directories to true or false`,
    )
  }
  for (const [dirPath, trusted] of Object.entries(parsed)) {
    if (typeof trusted !== 'boolean') continue
    ops.db.run(
      `INSERT INTO trusted_paths (path, trusted, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET trusted = excluded.trusted, updated_at = excluded.updated_at`,
      resolve(dirPath),
      trusted ? 1 : 0,
      ops.now,
    )
    ops.summary.trustedPaths += 1
  }
}

export function migrateLocalProjects(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  for (const dataDir of dataDirs) {
    const projectsFile = join(dataDir, 'local', 'projects.json')
    if (!existsSync(projectsFile)) continue
    const parsed = readJsonStrict(projectsFile)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.projects)) {
      throw new Error(`Invalid Local projects registry ${projectsFile}`)
    }
    if (typeof parsed.deploymentId === 'string') {
      ops.db.run(
        `INSERT OR IGNORE INTO kv_meta (key, value_json, updated_at) VALUES ('deployment_id', ?, ?)`,
        JSON.stringify(parsed.deploymentId),
        ops.now,
      )
    }
    for (const rawProject of parsed.projects) {
      if (
        !isPlainObject(rawProject) ||
        typeof rawProject.id !== 'string' ||
        typeof rawProject.cwd !== 'string'
      ) {
        continue
      }
      const proj = rawProject as unknown as LegacyLocalProject
      ops.ensureProject({
        id: proj.id,
        name:
          typeof proj.name === 'string' && proj.name
            ? proj.name
            : basename(proj.cwd),
        cwd: proj.cwd,
        dataDir,
        hubSessionId: null,
      })

      const logFile = join(dataDir, 'local', `${proj.id}.json`)
      if (!existsSync(logFile)) continue
      const rawMessages = readJsonStrict(logFile)
      if (!Array.isArray(rawMessages)) {
        throw new Error(`Invalid Local log ${logFile}`)
      }
      for (const rawMsg of rawMessages) {
        if (
          !isPlainObject(rawMsg) ||
          typeof rawMsg.id !== 'string' ||
          typeof rawMsg.sessionId !== 'string' ||
          typeof rawMsg.role !== 'string' ||
          typeof rawMsg.text !== 'string'
        ) {
          continue
        }
        const msg = rawMsg as unknown as LegacyLocalMessage
        const bucket = ops.fallbackLocalMessages.get(msg.sessionId) ?? {
          projectId: proj.id,
          messages: [],
        }
        bucket.messages.push(msg)
        ops.fallbackLocalMessages.set(msg.sessionId, bucket)

        if (!msg.file || typeof msg.file.name !== 'string') continue
        const srcAttachment = join(
          dataDir,
          'local',
          proj.id,
          msg.sessionId,
          msg.id,
        )
        if (!existsSync(srcAttachment) || !statSync(srcAttachment).isFile()) {
          ops.warnings.push(
            `Missing local attachment file ${srcAttachment} for message ${msg.id}`,
          )
          continue
        }
        const blobsDir = join(ops.agentDir, 'blobs')
        mkdirSync(blobsDir, { recursive: true, mode: 0o700 })
        chmodSync(blobsDir, 0o700)
        const blobId = randomUUID()
        const rawExt = extname(msg.file.name)
        const safeExt = /^\.[A-Za-z0-9]{1,16}$/.test(rawExt) ? rawExt : ''
        const storagePath = `${blobId}${safeExt}`
        const dstBlob = join(blobsDir, storagePath)
        copyFileSync(srcAttachment, dstBlob)
        chmodSync(dstBlob, 0o600)
        ops.createdBlobPaths.push(dstBlob)
        const { sha256, sizeBytes } = sha256File(dstBlob)
        ops.db.run(
          `INSERT INTO blobs (
            id, session_id, project_id, message_id, direction,
            filename, size_bytes, sha256, storage_path, created_at
          ) VALUES (?, NULL, ?, ?, 'inbound', ?, ?, ?, ?, ?)`,
          blobId,
          proj.id,
          msg.id,
          msg.file.name,
          sizeBytes,
          sha256,
          storagePath,
          msg.createdAt ?? ops.now,
        )
        ops.summary.blobs += 1
      }
    }
  }
}

function readLarkChatsConfig(
  agentDir: string,
  warnings: string[],
): Record<string, unknown>[] {
  let rawChats: unknown
  const configFile = join(agentDir, 'config.json')
  if (existsSync(configFile)) {
    const parsed = readJsonStrict(configFile)
    if (isPlainObject(parsed) && isPlainObject(parsed.lark)) {
      rawChats = parsed.lark.chats
    }
  } else {
    const settingsFile = join(agentDir, 'settings.json')
    if (existsSync(settingsFile)) {
      const parsed = readJsonStrict(settingsFile)
      if (
        isPlainObject(parsed) &&
        isPlainObject(parsed.extensionConfig) &&
        isPlainObject(parsed.extensionConfig.lark)
      ) {
        rawChats = parsed.extensionConfig.lark.chats
      }
    }
  }

  if (rawChats === undefined) return []
  if (typeof rawChats === 'string') {
    if (rawChats.includes('$')) {
      warnings.push(
        'Skipped env-expression lark.chats during offline database migration',
      )
      return []
    }
    return rawChats
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id }))
  }
  if (!Array.isArray(rawChats)) return []
  const chats: Record<string, unknown>[] = []
  for (const item of rawChats) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (!trimmed) continue
      if (trimmed.includes('$')) {
        warnings.push(
          `Skipped env-expression lark.chats entry "${trimmed}" during offline migration`,
        )
        continue
      }
      chats.push({ id: trimmed })
    } else if (isPlainObject(item) && typeof item.id === 'string') {
      chats.push(item)
    }
  }
  return chats
}

export function migrateLarkChats(ops: MigrationOps): void {
  for (const chat of readLarkChatsConfig(ops.agentDir, ops.warnings)) {
    const chatId = String(chat.id)
    const projectId = `lark-group:${chatId}`
    ops.projectByChat.set(`lark\0${chatId}`, projectId)

    const extraConfig: Record<string, unknown> = {}
    for (const key of [
      'environment',
      'readUntagged',
      'topicModel',
      'topicThinkingLevel',
    ] as const) {
      if (chat[key] !== undefined) extraConfig[key] = chat[key]
    }
    const configJson =
      Object.keys(extraConfig).length > 0 ? JSON.stringify(extraConfig) : null

    ops.ensureProject({
      id: projectId,
      name: chatId,
      defaultModel: typeof chat.model === 'string' ? chat.model : null,
      defaultThinkingLevel:
        typeof chat.thinkingLevel === 'string' ? chat.thinkingLevel : null,
      defaultToolsJson: Array.isArray(chat.tools)
        ? JSON.stringify(chat.tools)
        : null,
      configJson,
    })
    ops.ensureChannelBinding({
      channel: 'lark',
      externalId: chatId,
      kind: 'group',
      projectId,
      sessionId: null,
      configJson,
    })
  }
}

export function migrateChannelDirectory(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  for (const dataDir of dataDirs) {
    const indexFile = join(dataDir, 'channels', 'index.json')
    if (!existsSync(indexFile)) continue
    const parsed = readJsonStrict(indexFile)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
      throw new Error(`Invalid channel directory ${indexFile}`)
    }

    for (const rawRecord of parsed.records) {
      if (
        !isPlainObject(rawRecord) ||
        typeof rawRecord.key !== 'string' ||
        typeof rawRecord.channel !== 'string' ||
        typeof rawRecord.chatId !== 'string' ||
        typeof rawRecord.activeSessionId !== 'string'
      ) {
        continue
      }
      const rec = rawRecord as unknown as LegacyChannelRecord
      const isGroup = rec.chatKind === 'group'
      const isTopic = Boolean(rec.rootId && rec.threadId)
      let projectId: string | null = null

      if (isGroup) {
        const chatKey = `${rec.channel}\0${rec.chatId}`
        projectId =
          ops.projectByChat.get(chatKey) ??
          (rec.channel === 'lark'
            ? `lark-group:${rec.chatId}`
            : `channel-group:${rec.channel}:${rec.chatId}`)
        ops.projectByChat.set(chatKey, projectId)
        const storageKey = rec.storageKey ?? `${rec.channel}-${rec.chatId}`
        const channelAssetDir = join(dataDir, 'channels', storageKey)
        ops.ensureProject({
          id: projectId,
          name: rec.chatId,
          dataDir:
            rec.storageKey || existsSync(channelAssetDir)
              ? channelAssetDir
              : null,
          hubSessionId: !isTopic ? rec.activeSessionId : null,
        })
        ops.ensureChannelBinding({
          channel: rec.channel,
          externalId: rec.chatId,
          kind: 'group',
          projectId,
          sessionId: !isTopic ? rec.activeSessionId : null,
        })
      }

      const sessionKind = isTopic ? 'topic' : isGroup ? 'hub' : 'chat'
      ops.ensureSession({
        id: rec.activeSessionId,
        projectId,
        kind: sessionKind,
        name: typeof rec.task === 'string' && rec.task ? rec.task : null,
        state: mapChannelState(rec.state),
        waitingReason: rec.waitingReason ?? null,
        createdAt: rec.createdAt ?? ops.now,
        updatedAt: rec.updatedAt ?? rec.createdAt ?? ops.now,
      })

      if (isTopic && rec.rootId) {
        ops.ensureChannelBinding({
          channel: rec.channel,
          externalId: `${rec.chatId}:${rec.rootId}`,
          threadId: rec.threadId ?? null,
          kind: 'topic',
          projectId,
          sessionId: rec.activeSessionId,
        })
      } else if (!isGroup) {
        ops.ensureChannelBinding({
          channel: rec.channel,
          externalId: rec.chatId,
          kind: 'direct',
          projectId: null,
          sessionId: rec.activeSessionId,
        })
      }

      ops.channelSessionByKey.set(rec.key, {
        sessionId: rec.activeSessionId,
        projectId,
      })

      for (const prevId of rec.previousSessionIds ?? []) {
        if (typeof prevId !== 'string' || !prevId) continue
        ops.ensureSession({
          id: prevId,
          projectId,
          kind: sessionKind,
          archived: true,
          state: 'stopped',
          createdAt: rec.createdAt ?? ops.now,
          updatedAt: rec.updatedAt ?? ops.now,
        })
      }
    }

    if (isPlainObject(parsed.notes)) {
      for (const [groupKey, rawNotes] of Object.entries(parsed.notes)) {
        if (!Array.isArray(rawNotes)) continue
        const target = ops.channelSessionByKey.get(groupKey)
        for (let idx = 0; idx < rawNotes.length; idx++) {
          const note = rawNotes[idx]
          if (typeof note !== 'string') continue
          const dedupeKey = `legacy-note:${groupKey}:${idx}`
          const res = ops.db.run(
            `INSERT OR IGNORE INTO inbox_events (
              id, session_id, project_id, source, dedupe_key, wake, passive, status, payload_json, created_at
            ) VALUES (?, ?, ?, 'handoff', ?, 0, 0, 'pending', ?, ?)`,
            randomUUID(),
            target?.sessionId ?? null,
            target?.projectId ?? null,
            dedupeKey,
            JSON.stringify({ type: 'handoff_note', groupKey, text: note }),
            ops.now,
          )
          if (res.changes > 0) ops.summary.inboxEvents += 1
        }
      }
    }
  }
}

export function migrateRoutinesAndSubscriptions(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  for (const dataDir of dataDirs) {
    const routinesFile = join(dataDir, 'channels', 'routines.json')
    if (existsSync(routinesFile)) {
      const parsed = readJsonStrict(routinesFile)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.routines)) {
        throw new Error(`Invalid channel routines ${routinesFile}`)
      }
      for (const r of parsed.routines) {
        if (
          !isPlainObject(r) ||
          typeof r.id !== 'string' ||
          typeof r.channel !== 'string' ||
          typeof r.chatId !== 'string' ||
          typeof r.message !== 'string' ||
          !isPlainObject(r.schedule)
        ) {
          continue
        }
        const targetKey =
          typeof r.targetKey === 'string'
            ? r.targetKey
            : legacyChannelSessionId(r.channel, r.chatId)
        const resolved = ops.channelSessionByKey.get(targetKey)
        const projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${r.channel}\0${r.chatId}`) ??
          null
        const creator = isPlainObject(r.creator) ? r.creator : undefined
        const createdAt =
          typeof r.createdAt === 'string' ? r.createdAt : ops.now
        const res = ops.db.run(
          `INSERT OR IGNORE INTO timers (
            id, kind, project_id, session_id, channel, creator_id, creator_name,
            message, schedule_json, enabled, last_fired_at, schedule_updated_at,
            created_at, updated_at
          ) VALUES (?, 'routine', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          r.id,
          projectId,
          resolved?.sessionId ?? null,
          r.channel,
          typeof creator?.id === 'string' ? creator.id : null,
          typeof creator?.name === 'string' ? creator.name : null,
          r.message,
          JSON.stringify(r.schedule),
          typeof r.lastFiredAt === 'string' ? r.lastFiredAt : null,
          typeof r.scheduleUpdatedAt === 'string' ? r.scheduleUpdatedAt : null,
          createdAt,
          ops.now,
        )
        if (res.changes > 0) ops.summary.timers += 1
      }
    }

    const subsFile = join(dataDir, 'channels', 'subscriptions.json')
    if (existsSync(subsFile)) {
      const parsed = readJsonStrict(subsFile)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.subscriptions)) {
        throw new Error(`Invalid channel subscriptions ${subsFile}`)
      }
      for (const sub of parsed.subscriptions) {
        if (
          !isPlainObject(sub) ||
          typeof sub.id !== 'string' ||
          typeof sub.source !== 'string' ||
          typeof sub.key !== 'string' ||
          typeof sub.channel !== 'string' ||
          typeof sub.chatId !== 'string'
        ) {
          continue
        }
        const targetKey =
          typeof sub.targetKey === 'string'
            ? sub.targetKey
            : legacyChannelSessionId(sub.channel, sub.chatId)
        const resolved = ops.channelSessionByKey.get(targetKey)
        let projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${sub.channel}\0${sub.chatId}`) ??
          null
        let sessionId = resolved?.sessionId
        if (!sessionId) {
          sessionId = targetKey
          if (!projectId && sub.channel === 'lark') {
            projectId = `lark-group:${sub.chatId}`
            ops.ensureProject({ id: projectId, name: sub.chatId })
          }
          ops.ensureSession({
            id: sessionId,
            projectId,
            kind: projectId ? 'hub' : 'chat',
            state: 'idle',
          })
        }
        const creator = isPlainObject(sub.creator) ? sub.creator : undefined
        const res = ops.db.run(
          `INSERT OR IGNORE INTO subscriptions (
            id, source, event_key, project_id, session_id, creator_id, creator_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sub.id,
          sub.source,
          sub.key,
          projectId,
          sessionId,
          typeof creator?.id === 'string' ? creator.id : null,
          typeof creator?.name === 'string' ? creator.name : null,
          ops.now,
        )
        if (res.changes > 0) ops.summary.subscriptions += 1
      }
    }
  }
}
