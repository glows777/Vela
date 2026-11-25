import { createHash, randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { ExecutionEnv, FileError, Result } from '../shared/execution.ts'

export interface ChannelUploadMeta {
  blobId: string
  name: string
  path: string
  environment: string
}

function unwrap<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw result.error
  return result.value
}

function channelUploadMetaKey(
  sessionId: string,
  name: string,
  path: string,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([name, path]))
    .digest('hex')
  return `channel_upload:${sessionId}:${hash}`
}

export function saveChannelUploadMeta(
  db: VelaDatabase,
  meta: ChannelUploadMeta & { sessionId: string },
): void {
  db.run(
    `INSERT INTO kv_meta (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    channelUploadMetaKey(meta.sessionId, meta.name, meta.path),
    JSON.stringify({
      blobId: meta.blobId,
      name: meta.name,
      path: meta.path,
      environment: meta.environment,
    }),
    new Date().toISOString(),
  )
}

export function getChannelUploadMeta(
  db: VelaDatabase,
  sessionId: string,
  name: string,
  path: string,
): ChannelUploadMeta | undefined {
  const row = db.get<{ value_json: string }>(
    'SELECT value_json FROM kv_meta WHERE key = ?',
    channelUploadMetaKey(sessionId, name, path),
  )
  if (!row) return undefined
  try {
    const parsed = JSON.parse(row.value_json) as {
      blobId?: unknown
      name?: unknown
      path?: unknown
      environment?: unknown
    }
    if (
      typeof parsed.blobId === 'string' &&
      typeof parsed.name === 'string' &&
      typeof parsed.path === 'string' &&
      typeof parsed.environment === 'string'
    ) {
      return {
        blobId: parsed.blobId,
        name: parsed.name,
        path: parsed.path,
        environment: parsed.environment,
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function writeRemoteChannelUploadFile(
  env: ExecutionEnv,
  sessionId: string,
  safeName: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const root = unwrap(
    await env.absolutePath(`~/.vela/uploads/${sessionId}`, signal),
  )
  const dest = unwrap(await env.joinPath([root, safeName], signal))
  const existing = await env.fileInfo(dest, signal)
  if (existing.ok) {
    if (existing.value.kind !== 'file') {
      throw new Error('Upload destination is not a regular file')
    }
    return dest
  }
  if (existing.error.code !== 'not_found') throw existing.error
  unwrap(await env.createDir(root, { recursive: true }, signal))
  const tmp = unwrap(await env.joinPath([root, `${randomUUID()}.part`], signal))
  try {
    unwrap(await env.writeFile(tmp, bytes, signal))
    unwrap(await env.renameFile(tmp, dest, signal))
  } catch (error) {
    await env.remove(tmp, { force: true }).catch(() => {})
    throw error
  }
  return dest
}
