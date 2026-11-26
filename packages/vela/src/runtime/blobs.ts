import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, constants, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import type { ExecutionEnv, FileError, Result } from '../shared/execution.ts'
import {
  getChannelUploadMeta,
  saveChannelUploadMeta,
  writeRemoteChannelUploadFile,
} from './blob-channel-uploads.ts'
import { assertSafePathSegment } from './driver.ts'

const MAX_BLOB_BYTES = 20 * 1024 * 1024

export type BlobDirection = 'inbound' | 'outbound'

export interface BlobRecord {
  id: string
  sessionId: string | null
  projectId: string | null
  messageId: string | null
  direction: BlobDirection
  filename: string
  mimeType: string | null
  sizeBytes: number
  sha256: string
  storagePath: string
  createdAt: string
}

interface BlobRow {
  id: string
  session_id: string | null
  project_id: string | null
  message_id: string | null
  direction: string
  filename: string
  mime_type: string | null
  size_bytes: number
  sha256: string
  storage_path: string
  created_at: string
}

function unwrap<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw result.error
  return result.value
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (used + chBytes > maxBytes) break
    out += ch
    used += chBytes
  }
  return out.trimEnd() || 'file'
}

function sanitizeBlobFilename(name: string, maxBytes = 200): string {
  const leaf = basename(name.replaceAll('\\', '/')).trim()
  if (!leaf || leaf === '.' || leaf === '..') return 'file'
  let cleaned = ''
  let prevUnderscore = false
  for (const ch of leaf) {
    const code = ch.codePointAt(0) ?? 0
    const bad = code <= 0x1f || code === 0x7f || ch === '/' || ch === '\\'
    if (bad) {
      if (!prevUnderscore) {
        cleaned += '_'
        prevUnderscore = true
      }
    } else {
      cleaned += ch
      prevUnderscore = false
    }
  }
  return truncateUtf8Bytes(cleaned || 'file', maxBytes)
}

function ensurePrivateDirSync(dir: string): void {
  const resolved = resolve(dir)
  if (existsSync(resolved)) {
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Blob root directory must not be a symlink: ${resolved}`)
    }
    return
  }
  const missing: string[] = []
  let cur = resolved
  while (!existsSync(cur)) {
    missing.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  mkdirSync(resolved, { recursive: true, mode: 0o700 })
  for (const created of missing) {
    if (lstatSync(created).isSymbolicLink()) {
      throw new Error(
        `Blob directory path must not traverse a symlink: ${created}`,
      )
    }
    chmodSync(created, 0o700)
  }
}

async function readCanonicalHostBytes(
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new Error('Blob source is not a regular file')
    }
    if (stat.size > MAX_BLOB_BYTES) {
      throw new Error('Attachment exceeds the 20 MiB limit')
    }
    return await handle.readFile({ signal })
  } finally {
    await handle.close()
  }
}

function rowToRecord(row: BlobRow): BlobRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    messageId: row.message_id,
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  }
}

/**
 * Host-side content-addressed blob store (`<agentDir>/blobs/`) backed by `vela.db` `blobs`.
 * Each stored artifact gets a unique immutable path `<sha256[0..2]>/<blobId>-<filename>` so
 * duplicate uploads with identical filenames never overwrite earlier files.
 */
export class BlobStore {
  constructor(
    private readonly db: VelaDatabase,
    readonly rootDir: string,
  ) {}

  async storeInbound(options: {
    id?: string
    sessionId?: string | null
    projectId?: string | null
    messageId?: string | null
    filename: string
    mimeType?: string
    bytes?: Uint8Array
    hostPath?: string
    signal?: AbortSignal
  }): Promise<BlobRecord> {
    const bytes = options.bytes
      ? options.bytes
      : options.hostPath
        ? await readCanonicalHostBytes(options.hostPath, options.signal)
        : (() => {
            throw new Error('BlobStore.storeInbound requires bytes or hostPath')
          })()
    return this.writeAndInsert({
      id: options.id,
      sessionId: options.sessionId ?? null,
      projectId: options.projectId ?? null,
      messageId: options.messageId ?? null,
      direction: 'inbound',
      filename: options.filename,
      mimeType: options.mimeType ?? null,
      bytes,
      signal: options.signal,
    })
  }

  async storeOutboundFromEnv(options: {
    id?: string
    sessionId?: string | null
    projectId?: string | null
    messageId?: string | null
    env: ExecutionEnv
    sourcePath: string
    filename?: string
    mimeType?: string
    signal?: AbortSignal
  }): Promise<BlobRecord> {
    const opened = await options.env.openBinaryReader(
      options.sourcePath,
      { noFollow: true },
      options.signal,
    )
    const reader = unwrap(opened)
    let bytes: Uint8Array
    try {
      const info = unwrap(await reader.info(options.signal))
      if (info.kind !== 'file') {
        throw new Error('Outbound artifact source is not a regular file')
      }
      if (info.size > MAX_BLOB_BYTES) {
        throw new Error('Outbound artifact exceeds the 20 MiB limit')
      }
      bytes = unwrap(await reader.read(0, info.size, options.signal))
    } finally {
      await reader.close(options.signal)
    }
    return this.writeAndInsert({
      id: options.id,
      sessionId: options.sessionId ?? null,
      projectId: options.projectId ?? null,
      messageId: options.messageId ?? null,
      direction: 'outbound',
      filename: options.filename ?? basename(options.sourcePath),
      mimeType: options.mimeType ?? null,
      bytes,
      signal: options.signal,
    })
  }

  async materializeIntoEnv(
    blobOrId: BlobRecord | string,
    env: ExecutionEnv,
    sessionId: string,
    signal?: AbortSignal,
    allowUnbound = false,
  ): Promise<string> {
    assertSafePathSegment(sessionId, 'sessionId')
    const blob = typeof blobOrId === 'string' ? this.get(blobOrId) : blobOrId
    if (!blob) {
      throw new Error(`Blob ${String(blobOrId)} not found`)
    }
    assertSafePathSegment(blob.id, 'blobId')
    if (blob.sessionId !== null && blob.sessionId !== sessionId) {
      throw new Error(
        `Blob ${blob.id} belongs to session ${blob.sessionId}, not ${sessionId}`,
      )
    }
    if (blob.sessionId === null && !allowUnbound) {
      throw new Error(`Blob ${blob.id} is not bound to session ${sessionId}`)
    }
    if (env.id === 'node:local') {
      return blob.storagePath
    }
    const safeName = sanitizeBlobFilename(blob.filename)
    const root = unwrap(
      await env.absolutePath(`~/.vela/uploads/${sessionId}`, signal),
    )
    const dest = unwrap(
      await env.joinPath([root, `${blob.id}-${safeName}`], signal),
    )
    const existing = await env.fileInfo(dest, signal)
    if (existing.ok) {
      if (existing.value.kind !== 'file') {
        throw new Error('Upload destination is not a regular file')
      }
      return dest
    }
    if (existing.error.code !== 'not_found') throw existing.error

    const bytes = await readCanonicalHostBytes(blob.storagePath, signal)
    unwrap(await env.createDir(root, { recursive: true }, signal))
    const tmp = unwrap(
      await env.joinPath([root, `${randomUUID()}.part`], signal),
    )
    try {
      unwrap(await env.writeFile(tmp, bytes, signal))
      unwrap(await env.renameFile(tmp, dest, signal))
    } catch (error) {
      await env.remove(tmp, { force: true }).catch(() => {})
      throw error
    }
    return dest
  }

  async materializeChannelUpload(
    env: ExecutionEnv,
    options: {
      sessionId: string
      projectId?: string | null
      name: string
      hostPath: string
      mimeType?: string
    },
    signal?: AbortSignal,
  ): Promise<{ blob: BlobRecord; path: string }> {
    assertSafePathSegment(options.sessionId, 'sessionId')
    const bytes = await readCanonicalHostBytes(options.hostPath, signal)
    const leaf = sanitizeBlobFilename(
      basename(options.hostPath.replaceAll('\\', '/')),
      255,
    )
    const dest =
      env.id === 'node:local'
        ? options.hostPath
        : await writeRemoteChannelUploadFile(
            env,
            options.sessionId,
            leaf,
            bytes,
            signal,
          )
    const existingMeta = getChannelUploadMeta(
      this.db,
      options.sessionId,
      options.name,
      dest,
    )
    if (existingMeta) {
      const existingBlob = this.get(existingMeta.blobId)
      if (existingBlob && existsSync(existingBlob.storagePath)) {
        return { blob: existingBlob, path: dest }
      }
    }
    const blob = await this.storeInbound({
      sessionId: options.sessionId,
      projectId: options.projectId,
      filename: options.name,
      mimeType: options.mimeType,
      bytes,
      signal,
    })
    saveChannelUploadMeta(this.db, {
      sessionId: options.sessionId,
      blobId: blob.id,
      name: options.name,
      path: dest,
      environment: env.id,
    })
    return { blob, path: dest }
  }

  async materializeHostUpload(
    env: ExecutionEnv,
    options: {
      sessionId: string
      projectId?: string | null
      name: string
      hostPath: string
      mimeType?: string
    },
    signal?: AbortSignal,
  ): Promise<{ blob: BlobRecord; path: string }> {
    assertSafePathSegment(options.sessionId, 'sessionId')
    const blob = await this.storeInbound({
      sessionId: options.sessionId,
      projectId: options.projectId,
      filename: options.name,
      mimeType: options.mimeType,
      hostPath: options.hostPath,
      signal,
    })
    try {
      const path = await this.materializeIntoEnv(
        blob,
        env,
        options.sessionId,
        signal,
        true,
      )
      return { blob, path }
    } catch (error) {
      this.deleteRecordIfExists(blob.id)
      await rm(blob.storagePath, { force: true }).catch(() => {})
      throw error
    }
  }

  async deleteBlob(id: string): Promise<void> {
    const existing = this.get(id)
    this.deleteRecordIfExists(id)
    if (existing) {
      await rm(existing.storagePath, { force: true }).catch(() => {})
    }
  }

  get(id: string): BlobRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM blobs WHERE id = ?',
      id,
    ) as BlobRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  async readBytes(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    const record = this.get(id)
    if (!record) {
      throw new Error(`Blob ${id} not found`)
    }
    return readCanonicalHostBytes(record.storagePath, signal)
  }

  /** Creates a child-session-owned inbound copy of an existing blob visible to the caller. */
  async cloneForSession(
    blobId: string,
    targetSessionId: string | null,
    targetProjectId: string | null,
    callerSessionId?: string,
    signal?: AbortSignal,
  ): Promise<BlobRecord> {
    const source = this.get(blobId)
    if (!source) {
      throw new Error(`Blob ${blobId} not found`)
    }
    if (
      callerSessionId &&
      source.sessionId &&
      source.sessionId !== callerSessionId &&
      (!targetProjectId || source.projectId !== targetProjectId)
    ) {
      throw new Error(
        `Blob ${blobId} does not belong to caller session ${callerSessionId}`,
      )
    }
    const bytes = await readCanonicalHostBytes(source.storagePath, signal)
    return this.storeInbound({
      sessionId: targetSessionId,
      projectId: targetProjectId,
      filename: source.filename,
      ...(source.mimeType ? { mimeType: source.mimeType } : {}),
      bytes,
      signal,
    })
  }

  listBySession(sessionId: string, direction?: BlobDirection): BlobRecord[] {
    const rows = direction
      ? (this.db.all<Record<string, unknown>>(
          'SELECT * FROM blobs WHERE session_id = ? AND direction = ? ORDER BY created_at ASC',
          sessionId,
          direction,
        ) as unknown as BlobRow[])
      : (this.db.all<Record<string, unknown>>(
          'SELECT * FROM blobs WHERE session_id = ? ORDER BY created_at ASC',
          sessionId,
        ) as unknown as BlobRow[])
    return rows.map(rowToRecord)
  }

  bindSession(blobIds: readonly string[], sessionId: string): void {
    if (!blobIds.length) return
    const exists = this.db.get<{ id: string }>(
      'SELECT id FROM sessions WHERE id = ?',
      sessionId,
    )
    if (!exists) return
    for (const id of blobIds) {
      this.db.run(
        'UPDATE blobs SET session_id = ? WHERE id = ? AND session_id IS NULL',
        sessionId,
        id,
      )
    }
  }

  async inheritForFork(options: {
    parentSessionId: string
    targetSessionId: string
    targetProjectId?: string | null
    branchTexts: readonly string[]
    resolveEnv: () => Promise<ExecutionEnv>
    signal?: AbortSignal
  }): Promise<{ rewrites: [string, string][]; blobIds: string[] }> {
    assertSafePathSegment(options.parentSessionId, 'parentSessionId')
    assertSafePathSegment(options.targetSessionId, 'targetSessionId')
    const rewrites: [string, string][] = []
    const blobIds: string[] = []
    if (!options.branchTexts.some((t) => t.includes(', saved at '))) {
      return { rewrites, blobIds }
    }

    const parentBlobs = this.listBySession(options.parentSessionId, 'inbound')
    const byId = new Map(parentBlobs.map((b) => [b.id, b]))
    const byStoragePath = new Map(parentBlobs.map((b) => [b.storagePath, b]))

    const markerRe = /\[file: ([^,\]]+), saved at ([^\]]+)\]/g
    let env: ExecutionEnv | undefined
    const seenPaths = new Set<string>()

    for (const text of options.branchTexts) {
      for (const match of text.matchAll(markerRe)) {
        const name = match[1]!
        const savedPath = match[2]!
        if (seenPaths.has(savedPath)) continue
        const channelMeta = getChannelUploadMeta(
          this.db,
          options.parentSessionId,
          name,
          savedPath,
        )
        if (channelMeta) {
          const sourceBlob = byId.get(channelMeta.blobId)
          if (!sourceBlob || !existsSync(sourceBlob.storagePath)) continue
          seenPaths.add(savedPath)
          env ??= await options.resolveEnv()
          let bytes: Uint8Array | undefined
          if (
            channelMeta.environment === 'node:local' &&
            env.id === 'node:local'
          ) {
            if (existsSync(savedPath)) {
              bytes = await readCanonicalHostBytes(savedPath, options.signal)
            }
          } else if (
            env.id === channelMeta.environment &&
            channelMeta.environment !== 'node:local'
          ) {
            const opened = await env.openBinaryReader(
              savedPath,
              { noFollow: true },
              options.signal,
            )
            if (opened.ok) {
              const reader = opened.value
              try {
                const { size } = unwrap(await reader.info(options.signal))
                if (size > MAX_BLOB_BYTES) {
                  throw new Error(
                    'Cached upload exceeds the 20 MiB attachment limit',
                  )
                }
                bytes = unwrap(await reader.read(0, size, options.signal))
              } finally {
                await reader.close(options.signal)
              }
            } else if (opened.error.code !== 'not_found') {
              throw opened.error
            }
          }
          bytes ??= await readCanonicalHostBytes(
            sourceBlob.storagePath,
            options.signal,
          )
          const clonedBlob = await this.storeInbound({
            sessionId: options.targetSessionId,
            projectId: options.targetProjectId,
            filename: name,
            mimeType: sourceBlob.mimeType ?? undefined,
            bytes,
            signal: options.signal,
          })
          let dest: string
          try {
            const safeRemoteLeaf = sanitizeBlobFilename(
              basename(savedPath.replaceAll('\\', '/')),
              255,
            )
            dest =
              env.id === 'node:local'
                ? clonedBlob.storagePath
                : await writeRemoteChannelUploadFile(
                    env,
                    options.targetSessionId,
                    safeRemoteLeaf,
                    bytes,
                    options.signal,
                  )
          } catch (error) {
            this.deleteRecordIfExists(clonedBlob.id)
            await rm(clonedBlob.storagePath, { force: true }).catch(() => {})
            throw error
          }
          saveChannelUploadMeta(this.db, {
            sessionId: options.targetSessionId,
            blobId: clonedBlob.id,
            name,
            path: dest,
            environment: env.id,
          })
          blobIds.push(clonedBlob.id)
          if (dest !== savedPath) {
            rewrites.push([savedPath, dest])
          }
          continue
        }
        const source = this.findMatchingBlob(
          savedPath,
          name,
          parentBlobs,
          byId,
          byStoragePath,
        )
        if (!source || !existsSync(source.storagePath)) continue
        seenPaths.add(savedPath)
        env ??= await options.resolveEnv()
        const bytes = await readCanonicalHostBytes(
          source.storagePath,
          options.signal,
        )
        const clonedBlob = await this.storeInbound({
          sessionId: options.targetSessionId,
          projectId: options.targetProjectId,
          filename: source.filename,
          mimeType: source.mimeType ?? undefined,
          bytes,
          signal: options.signal,
        })
        let dest: string
        try {
          dest = await this.materializeIntoEnv(
            clonedBlob,
            env,
            options.targetSessionId,
            options.signal,
            true,
          )
        } catch (error) {
          this.deleteRecordIfExists(clonedBlob.id)
          await rm(clonedBlob.storagePath, { force: true }).catch(() => {})
          throw error
        }
        blobIds.push(clonedBlob.id)
        if (dest !== savedPath) {
          rewrites.push([savedPath, dest])
        }
      }
    }
    return { rewrites, blobIds }
  }

  private findMatchingBlob(
    savedPath: string,
    filename: string,
    parentBlobs: readonly BlobRecord[],
    byId: ReadonlyMap<string, BlobRecord>,
    byStoragePath: ReadonlyMap<string, BlobRecord>,
  ): BlobRecord | undefined {
    const direct = byStoragePath.get(savedPath)
    if (direct) return direct
    const leaf = basename(savedPath.replaceAll('\\', '/'))
    const dash = leaf.indexOf('-', 35)
    if (dash === 36) {
      const candidateId = leaf.slice(0, 36)
      const hit = byId.get(candidateId)
      if (hit) return hit
    }
    return parentBlobs.find(
      (b) =>
        b.filename === filename ||
        savedPath.endsWith(`${b.id}-${sanitizeBlobFilename(b.filename)}`),
    )
  }

  private deleteRecordIfExists(id: string): void {
    if (!this.db.open) return
    this.db.run('DELETE FROM blobs WHERE id = ?', id)
  }

  private async writeAndInsert(options: {
    id?: string
    sessionId: string | null
    projectId: string | null
    messageId: string | null
    direction: BlobDirection
    filename: string
    mimeType: string | null
    bytes: Uint8Array
    signal?: AbortSignal
  }): Promise<BlobRecord> {
    if (options.bytes.byteLength > MAX_BLOB_BYTES) {
      throw new Error('Attachment exceeds the 20 MiB limit')
    }
    const id = options.id ?? randomUUID()
    assertSafePathSegment(id, 'blobId')
    if (options.sessionId !== null) {
      assertSafePathSegment(options.sessionId, 'sessionId')
    }
    if (this.get(id)) {
      throw new Error(`Blob ${id} already exists`)
    }
    const sha256 = createHash('sha256').update(options.bytes).digest('hex')
    const safeName = sanitizeBlobFilename(options.filename)
    const shardDir = join(resolve(this.rootDir), sha256.slice(0, 2))
    const storagePath = join(shardDir, `${id}-${safeName}`)
    ensurePrivateDirSync(this.rootDir)
    await mkdir(shardDir, { recursive: true, mode: 0o700 })
    const shardStat = await lstat(shardDir)
    if (shardStat.isSymbolicLink() || !shardStat.isDirectory()) {
      throw new Error(`Blob shard path must be a real directory: ${shardDir}`)
    }
    chmodSync(shardDir, 0o700)

    const existingDest = await lstat(storagePath).catch(() => undefined)
    if (existingDest) {
      throw new Error(`Blob file already exists at ${storagePath}`)
    }

    const tempPath = join(shardDir, `.${id}.${randomUUID()}.part`)
    let createdStorageFile = false
    try {
      const handle = await open(tempPath, 'wx', 0o600)
      try {
        await handle.writeFile(options.bytes, { signal: options.signal })
      } finally {
        await handle.close()
      }
      await link(tempPath, storagePath)
      createdStorageFile = true
      await rm(tempPath, { force: true }).catch(() => {})
      chmodSync(storagePath, 0o600)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }

    const createdAt = new Date().toISOString()
    let boundSessionId: string | null = null
    if (options.sessionId) {
      const exists = this.db.get<{ id: string }>(
        'SELECT id FROM sessions WHERE id = ?',
        options.sessionId,
      )
      if (exists) boundSessionId = options.sessionId
    }
    let boundProjectId: string | null = null
    if (options.projectId) {
      const exists = this.db.get<{ id: string }>(
        'SELECT id FROM projects WHERE id = ?',
        options.projectId,
      )
      if (exists) boundProjectId = options.projectId
    }

    try {
      this.db.run(
        `INSERT INTO blobs (
           id, session_id, project_id, message_id, direction, filename,
           mime_type, size_bytes, sha256, storage_path, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        boundSessionId,
        boundProjectId,
        options.messageId,
        options.direction,
        options.filename,
        options.mimeType,
        options.bytes.byteLength,
        sha256,
        storagePath,
        createdAt,
      )
    } catch (error) {
      if (createdStorageFile) {
        await rm(storagePath, { force: true }).catch(() => {})
      }
      throw error
    }

    return {
      id,
      sessionId: boundSessionId,
      projectId: boundProjectId,
      messageId: options.messageId,
      direction: options.direction,
      filename: options.filename,
      mimeType: options.mimeType,
      sizeBytes: options.bytes.byteLength,
      sha256,
      storagePath,
      createdAt,
    }
  }
}
