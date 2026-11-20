import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ExecutionEnv, FileError, Result } from '../execution/types.ts'
import { messageText, type SessionEntry } from './entries.ts'

interface Upload {
  name: string
  hostPath: string
}
interface Source extends Upload {
  path: string
  environment: string
}
function value<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw result.error
  return result.value
}

async function canonicalBytes(path: string, signal?: AbortSignal) {
  const host = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await host.stat()).isFile())
      throw Error('Upload source is not a regular file')
    return await host.readFile({ signal })
  } finally {
    await host.close()
  }
}

/** Fork the visible file when the parent cache is still in the selected environment. */
async function copyBytes(env: ExecutionEnv, source: Source) {
  if (env.id === source.environment) {
    const opened = await env.openBinaryReader(source.path, { noFollow: true })
    if (opened.ok) {
      const reader = opened.value
      try {
        const { size } = value(await reader.info())
        // A chat upload may have been edited since admission. Keep the Lark transfer bound.
        if (size > 20 * 1024 * 1024)
          throw Error('Cached upload exceeds the 20 MiB attachment limit')
        return value(await reader.read(0, size))
      } finally {
        await reader.close()
      }
    }
    if (opened.error.code !== 'not_found') throw opened.error
  }
  return canonicalBytes(source.hostPath)
}

/** Private provenance for fork: only paths recorded by the receiving host can source a copy. */
export class SessionUploads {
  constructor(
    private readonly sessionId: string,
    private readonly directory: string,
  ) {}
  async materialize(
    env: ExecutionEnv,
    file: Upload,
    signal?: AbortSignal,
    read = (): Promise<Uint8Array> => canonicalBytes(file.hostPath, signal),
  ): Promise<string> {
    const path =
      env.id === 'node:local'
        ? file.hostPath
        : await this.cache(env, file.hostPath, read, signal)
    const key = createHash('sha256')
      .update(JSON.stringify([file.name, path]))
      .digest('hex')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const record = join(this.directory, key + '.json'),
      temporary = join(this.directory, randomUUID() + '.part')
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          name: file.name,
          hostPath: file.hostPath,
          path,
          environment: env.id,
        } satisfies Source),
        {
          flag: 'wx',
          mode: 0o600,
          signal,
        },
      )
      await rename(temporary, record)
    } finally {
      await rm(temporary, { force: true })
    }
    return path
  }

  private async cache(
    env: ExecutionEnv,
    source: string,
    read: () => Promise<Uint8Array>,
    signal?: AbortSignal,
  ) {
    const root = value(
      await env.absolutePath('~/.vela/uploads/' + this.sessionId, signal),
    )
    const path = value(await env.joinPath([root, basename(source)], signal))
    const existing = await env.fileInfo(path, signal)
    if (existing.ok) {
      if (existing.value.kind !== 'file')
        throw Error('Upload destination is not a regular file')
      return path
    }
    if (existing.error.code !== 'not_found') throw existing.error
    const bytes = await read()
    value(await env.createDir(root, { recursive: true }, signal))
    const tmp = value(
      await env.joinPath([root, randomUUID() + '.part'], signal),
    )
    try {
      value(await env.writeFile(tmp, bytes, signal))
      value(await env.renameFile(tmp, path, signal))
    } catch (error) {
      value(await env.remove(tmp, { force: true }))
      throw error
    }
    return path
  }

  async inherit(
    parent: SessionUploads,
    branch: SessionEntry[],
    resolve: () => Promise<ExecutionEnv>,
  ) {
    const texts = branch.flatMap((e) =>
      e.type === 'message' && e.message.role === 'user'
        ? [messageText(e.message.content)]
        : [],
    )
    const pairs: [string, string][] = []
    if (!texts.some((text) => text.includes(', saved at '))) return pairs
    let records: string[]
    try {
      records = await readdir(parent.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pairs
      throw error
    }
    let env: ExecutionEnv | undefined
    for (const record of records) {
      if (!record.endsWith('.json')) continue
      const source: Source = JSON.parse(
        await readFile(join(parent.directory, record), 'utf8'),
      )
      const { name, path } = source
      if (
        !texts.some((text) =>
          text.includes(`[file: ${name}, saved at ${path}]`),
        )
      )
        continue
      env ??= await resolve()
      const current = env
      const dest = await this.materialize(current, source, undefined, () =>
        copyBytes(current, source),
      )
      if (dest !== path) pairs.push([path, dest])
    }
    return pairs
  }
}
