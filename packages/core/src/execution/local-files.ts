import { constants } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LineScanner } from './line-scan.ts'
import type {
  BinaryReader,
  FileError,
  FileErrorCode,
  FileInfo,
  LineScan,
  Result,
} from './types.ts'

const ok = <T>(value: T): Result<T, FileError> => ({ ok: true, value })
function failure(error: unknown, path?: string): FileError {
  if (error instanceof Error && error.name === 'FileError' && 'code' in error)
    return error as FileError
  const cause = error instanceof Error ? error : new Error(String(error))
  const code = (cause as NodeJS.ErrnoException).code
  const mapped: Record<string, FileErrorCode> = {
    ABORT_ERR: 'aborted',
    ENOENT: 'not_found',
    EACCES: 'permission_denied',
    EPERM: 'permission_denied',
    ENOTDIR: 'not_directory',
    EISDIR: 'is_directory',
    EINVAL: 'invalid',
  }
  return Object.assign(new Error(cause.message, { cause }), {
    name: 'FileError',
    code: mapped[code ?? ''] ?? 'unknown',
    path,
  }) as FileError
}
function invalid(message: string, path?: string): FileError {
  return Object.assign(new Error(message), {
    name: 'FileError',
    code: 'invalid' as const,
    path,
  })
}
async function attempt<T>(
  path: string | undefined,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<Result<T, FileError>> {
  try {
    signal?.throwIfAborted()
    return ok(await fn())
  } catch (error) {
    return {
      ok: false,
      error: signal?.aborted
        ? Object.assign(new Error('aborted'), {
            name: 'FileError',
            code: 'aborted' as const,
            path,
          })
        : failure(error, path),
    }
  }
}
function info(
  path: string,
  stat: {
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
    size: number
    mtimeMs: number
  },
): FileInfo {
  const kind = stat.isFile()
    ? 'file'
    : stat.isDirectory()
      ? 'directory'
      : stat.isSymbolicLink()
        ? 'symlink'
        : undefined
  if (!kind) throw invalid('Unsupported file type', path)
  return {
    name: basename(path),
    path,
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}
class Reader implements BinaryReader {
  private closed = false
  constructor(
    private file: FileHandle,
    private path: string,
  ) {}
  info(signal?: AbortSignal) {
    return attempt(this.path, signal, async () => {
      if (this.closed) throw invalid('Binary reader closed', this.path)
      return info(this.path, await this.file.stat())
    })
  }
  read(offset: number, length: number, signal?: AbortSignal) {
    return attempt(this.path, signal, async () => {
      if (this.closed) throw invalid('Binary reader closed', this.path)
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        throw invalid('Invalid range', this.path)
      const chunks: Buffer[] = []
      let total = 0
      while (total < length) {
        signal?.throwIfAborted()
        const b = Buffer.allocUnsafe(Math.min(length - total, 1024 * 1024))
        const { bytesRead } = await this.file.read(
          b,
          0,
          b.length,
          offset + total,
        )
        signal?.throwIfAborted()
        if (!bytesRead) break
        chunks.push(b.subarray(0, bytesRead))
        total += bytesRead
      }
      return new Uint8Array(Buffer.concat(chunks, total))
    })
  }
  scanLines(
    options: { startLine: number; endLine?: number },
    signal?: AbortSignal,
  ): Promise<Result<LineScan, FileError>> {
    return attempt(this.path, signal, async () => {
      if (this.closed) throw invalid('Binary reader closed', this.path)
      let scanner: LineScanner
      try {
        scanner = new LineScanner(options.startLine, options.endLine)
      } catch {
        throw invalid('Invalid line range', this.path)
      }
      const b = Buffer.allocUnsafe(65536)
      let offset = 0
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await this.file.read(b, 0, b.length, offset)
        signal?.throwIfAborted()
        if (!bytesRead) return scanner.finish()
        scanner.push(b.subarray(0, bytesRead))
        offset += bytesRead
      }
    })
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.file.close()
  }
}
export class LocalFiles {
  readonly id = 'node:local'
  constructor(
    public cwd: string,
    private readonly tempRoot?: string,
  ) {}
  private path(path: string) {
    let value = path
    if (value === '~') value = homedir()
    else if (
      value.startsWith('~/') ||
      (process.platform === 'win32' && value.startsWith('~\\'))
    )
      value = join(homedir(), value.slice(2))
    else if (value.startsWith('file://')) {
      try {
        value = fileURLToPath(value)
      } catch {}
    }
    return resolve(this.cwd, value)
  }
  absolutePath(path: string, signal?: AbortSignal) {
    return attempt(path, signal, async () => this.path(path))
  }
  joinPath(parts: string[], signal?: AbortSignal) {
    return attempt(undefined, signal, async () => join(...parts))
  }
  canonicalPath(path: string, signal?: AbortSignal) {
    const p = this.path(path)
    return attempt(p, signal, () => realpath(p))
  }
  async exists(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, signal)
    if (result.ok) return ok(true)
    if (result.error.code === 'not_found') return ok(false)
    return result
  }
  readTextFile(path: string, signal?: AbortSignal) {
    const p = this.path(path)
    return attempt(p, signal, () => readFile(p, { encoding: 'utf8', signal }))
  }
  readBinaryFile(path: string, signal?: AbortSignal) {
    const p = this.path(path)
    return attempt(
      p,
      signal,
      async () => new Uint8Array(await readFile(p, { signal })),
    )
  }
  openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    signal?: AbortSignal,
  ) {
    const p = this.path(path)
    return attempt(p, signal, async () => {
      if (
        process.platform === 'win32' &&
        options?.noFollow &&
        (await lstat(p)).isSymbolicLink()
      )
        throw invalid('Refusing to follow a symbolic link', p)
      let file: FileHandle
      try {
        file = await open(
          p,
          constants.O_RDONLY |
            (process.platform === 'win32' ? 0 : constants.O_NONBLOCK) |
            (options?.noFollow && process.platform !== 'win32'
              ? constants.O_NOFOLLOW
              : 0),
        )
      } catch (e) {
        if (
          options?.noFollow &&
          ['ELOOP', 'EMLINK'].includes((e as NodeJS.ErrnoException).code ?? '')
        )
          throw invalid('Refusing to follow a symbolic link', p)
        throw e
      }
      try {
        const stat = await file.stat()
        if (stat.isDirectory())
          throw Object.assign(new Error('Is a directory'), {
            name: 'FileError',
            code: 'is_directory' as const,
            path: p,
          })
        if (!stat.isFile()) throw invalid('Not a regular file', p)
        signal?.throwIfAborted()
        return new Reader(file, p)
      } catch (e) {
        await file.close()
        throw e
      }
    })
  }
  writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal) {
    const p = this.path(path)
    return attempt(p, signal, async () => {
      await mkdir(dirname(p), { recursive: true })
      signal?.throwIfAborted()
      await writeFile(p, content, { signal })
    })
  }
  fileInfo(path: string, signal?: AbortSignal) {
    const p = this.path(path)
    return attempt(p, signal, async () => info(p, await lstat(p)))
  }
  listDir(path: string, signal?: AbortSignal) {
    const p = this.path(path)
    return attempt(p, signal, async () => {
      const names = await readdir(p)
      const entries: FileInfo[] = []
      for (const name of names) {
        signal?.throwIfAborted()
        const item = join(p, name)
        try {
          entries.push(info(item, await lstat(item)))
        } catch (e) {
          if (
            (e as NodeJS.ErrnoException).code === 'ENOENT' ||
            (e as FileError).code === 'invalid'
          )
            continue
          throw e
        }
      }
      return entries
    })
  }
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    signal?: AbortSignal,
  ) {
    const p = this.path(path)
    return attempt(p, signal, async () => {
      await mkdir(p, { recursive: options?.recursive ?? true })
    })
  }
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    signal?: AbortSignal,
  ) {
    return attempt(undefined, signal, async () => {
      const dir = this.tempRoot ?? (await mkdtemp(join(tmpdir(), 'vela-')))
      if (this.tempRoot) await mkdir(dir, { recursive: true, mode: 0o700 })
      const p = join(
        dir,
        `${options?.prefix ?? ''}${crypto.randomUUID()}${options?.suffix ?? ''}`,
      )
      await writeFile(p, '', { flag: 'wx' })
      return p
    })
  }
}
