import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
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

export interface LarkChatMigrationConfig {
  defaultModel: string | null
  defaultThinkingLevel: string | null
  defaultToolsJson: string | null
  configJson: string | null
}

export interface DeferredPendingMessages {
  sessionId: string
  projectId: string | null
  channel: string
  chatId: string
  channelKey: string
  updatedAt: string
  entries: { id: string; passive: boolean }[]
}

export interface MigrationOps {
  agentDir: string
  db: VelaDatabase
  env?: Record<string, string | undefined>
  now: string
  summary: LegacyMigrationSummary
  warnings: string[]
  incompleteRef: { incomplete: boolean }
  createdBlobPaths: string[]
  localProjectIds: Set<string>
  configuredLarkChats: Set<string>
  configuredLarkOwners: Set<string>
  larkChatConfigById: Map<string, LarkChatMigrationConfig>
  boundLarkChats: Set<string>
  channelTimezones: Map<string, string>
  unresolvedTimezoneChannels: Set<string>
  projectByChat: Map<string, string>
  channelSessionByKey: Map<
    string,
    {
      sessionId: string
      projectId: string | null
      channel: string
      chatId: string
    }
  >
  channelSessionDataDirs: Map<string, string>
  consumedInputMessageIdsBySession: Map<string, Set<string>>
  deferredPendingMessages: DeferredPendingMessages[]
  fallbackLocalMessages: Map<
    string,
    { projectId: string; messages: LegacyLocalMessage[] }
  >
  resolveSessionId(dataDir: string, legacySessionId: string): string
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
    discoveredToolsJson?: string | null
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
    kind: 'group' | 'direct'
    projectId: string | null
    sessionId: string | null
    enabled?: boolean
    configJson?: string | null
  }): void
}

const PLAIN_ID = /^[A-Za-z0-9_]+$/
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/

export function isSafeSegment(value: string): boolean {
  return value !== '.' && value !== '..' && SAFE_SEGMENT.test(value)
}

export function isStrictlyInside(candidate: string, baseDir: string): boolean {
  const base = resolve(baseDir)
  const target = resolve(candidate)
  return target.startsWith(base + sep)
}

export function legacyChannelSessionId(
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

function sha256File(filePath: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(filePath)
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  }
}

function hasUnsafeSymlinkAttachment(
  localRoot: string,
  segments: string[],
): boolean {
  const realRoot = realpathSync(localRoot)
  let current = localRoot
  for (const seg of segments) {
    current = join(current, seg)
    if (!existsSync(current)) return true
    if (lstatSync(current).isSymbolicLink()) return true
  }
  const realTarget = realpathSync(current)
  return !isStrictlyInside(realTarget, realRoot)
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
    if (!isAbsolute(dirPath)) {
      ops.warnings.push(`Skipped non-absolute trust.json key "${dirPath}"`)
      continue
    }
    const resolvedPath = resolve(dirPath)
    const existed = ops.db.get<{ path: string }>(
      'SELECT path FROM trusted_paths WHERE path = ?',
      resolvedPath,
    )
    ops.db.run(
      `INSERT INTO trusted_paths (path, trusted, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET trusted = excluded.trusted, updated_at = excluded.updated_at`,
      resolvedPath,
      trusted ? 1 : 0,
      ops.now,
    )
    if (!existed) ops.summary.trustedPaths += 1
  }
}

export function migrateLocalProjects(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  for (const dataDir of dataDirs) {
    const localRoot = join(dataDir, 'local')
    const projectsFile = join(localRoot, 'projects.json')
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
      if (!isSafeSegment(proj.id)) {
        ops.warnings.push(`Skipped Local project with unsafe id "${proj.id}"`)
        continue
      }
      ops.localProjectIds.add(proj.id)
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

      const logFile = join(localRoot, `${proj.id}.json`)
      if (!isStrictlyInside(logFile, localRoot) || !existsSync(logFile))
        continue
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
        const canonicalSessionId = ops.resolveSessionId(dataDir, msg.sessionId)
        const bucket = ops.fallbackLocalMessages.get(canonicalSessionId) ?? {
          projectId: proj.id,
          messages: [],
        }
        bucket.messages.push(msg)
        ops.fallbackLocalMessages.set(canonicalSessionId, bucket)

        if (!msg.file || typeof msg.file.name !== 'string') continue
        if (!isSafeSegment(msg.sessionId) || !isSafeSegment(msg.id)) {
          ops.warnings.push(
            `Skipped Local attachment with unsafe path segment for project ${proj.id}`,
          )
          continue
        }
        const srcAttachment = join(localRoot, proj.id, msg.sessionId, msg.id)
        if (!isStrictlyInside(srcAttachment, localRoot)) {
          ops.warnings.push(
            `Skipped local attachment outside root for message ${msg.id}`,
          )
          continue
        }
        if (!existsSync(srcAttachment)) {
          ops.warnings.push(
            `Missing local attachment file ${srcAttachment} for message ${msg.id}`,
          )
          continue
        }
        if (
          hasUnsafeSymlinkAttachment(localRoot, [
            proj.id,
            msg.sessionId,
            msg.id,
          ]) ||
          !statSync(srcAttachment).isFile()
        ) {
          ops.warnings.push(
            `Skipped symlinked or non-file local attachment ${srcAttachment} for message ${msg.id}`,
          )
          continue
        }
        const { sha256, sizeBytes } = sha256File(srcAttachment)
        const existingBlob = ops.db.get<{ id: string }>(
          `SELECT id FROM blobs
           WHERE project_id = ? AND message_id = ? AND filename = ? AND sha256 = ?`,
          proj.id,
          msg.id,
          msg.file.name,
          sha256,
        )
        if (existingBlob) continue

        const blobsDir = join(ops.agentDir, 'blobs')
        mkdirSync(blobsDir, { recursive: true, mode: 0o700 })
        const blobId = randomUUID()
        const rawExt = extname(msg.file.name)
        const safeExt = /^\.[A-Za-z0-9]{1,16}$/.test(rawExt) ? rawExt : ''
        const storagePath = `${blobId}${safeExt}`
        const dstBlob = join(blobsDir, storagePath)
        ops.createdBlobPaths.push(dstBlob)
        copyFileSync(srcAttachment, dstBlob)
        chmodSync(dstBlob, 0o600)
        const direction = msg.role === 'assistant' ? 'outbound' : 'inbound'
        ops.db.run(
          `INSERT INTO blobs (
            id, session_id, project_id, message_id, direction,
            filename, size_bytes, sha256, storage_path, created_at
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
          blobId,
          proj.id,
          msg.id,
          direction,
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
