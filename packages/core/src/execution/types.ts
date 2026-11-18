/* Derived from pi-durable at 0826f9f.
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
export type FileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'not_supported'
  | 'unavailable'
  | 'unknown'
export type ExecutionErrorCode =
  | 'aborted'
  | 'timeout'
  | 'shell_unavailable'
  | 'spawn_error'
  | 'callback_error'
  | 'unavailable'
  | 'unknown'
export interface FileError extends Error {
  code: FileErrorCode
  path?: string
}
export interface ExecutionError extends Error {
  code: ExecutionErrorCode
  spillPath?: string
}
export interface FileInfo {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
  size: number
  mtimeMs: number
}
export interface LineScan {
  newlines: number
  start: number
  end: number
  firstLineEnd: number
  lastLineStart: number
  selectedBytes: number
  firstLineBytes: number
}
export interface BinaryReader {
  info(signal?: AbortSignal): Promise<Result<FileInfo, FileError>>
  read(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>>
  scanLines(
    options: { startLine: number; endLine?: number },
    signal?: AbortSignal,
  ): Promise<Result<LineScan, FileError>>
  close(signal?: AbortSignal): Promise<void>
}
export interface ShellExecOptions {
  cwd?: string
  env?: Record<string, string>
  inheritEnv?: boolean
  timeout?: number
  onOutput?: (
    text: string,
    signal: AbortSignal | undefined,
    info: { stream: 'stdout' | 'stderr' },
  ) => void
  spill?: { afterBytes: number; afterLines: number }
}
export interface ShellExecResult {
  exitCode: number
  spillPath?: string
}
export interface ExecutionEnv {
  readonly id: string
  cwd: string
  absolutePath(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<string, FileError>>
  joinPath(
    parts: string[],
    signal?: AbortSignal,
  ): Promise<Result<string, FileError>>
  canonicalPath(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<string, FileError>>
  exists(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<boolean, FileError>>
  readTextFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<string, FileError>>
  readBinaryFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>>
  openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<BinaryReader, FileError>>
  writeFile(
    path: string,
    content: string | Uint8Array,
    signal?: AbortSignal,
  ): Promise<Result<void, FileError>>
  /** Rename in this environment (pi semantics); reserved for the remote attachment cache in E3. */
  renameFile(
    sourcePath: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<Result<void, FileError>>
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void, FileError>>
  fileInfo(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<FileInfo, FileError>>
  listDir(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<FileInfo[], FileError>>
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void, FileError>>
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<string, FileError>>
  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    signal?: AbortSignal,
  ): Promise<Result<ShellExecResult, ExecutionError>>
  cleanup(signal?: AbortSignal): Promise<void>
}

export interface ExecutionLocation {
  environment: string
  cwd: string
}
