import { spawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import z from 'zod'
import { DEFAULT_LIMITS } from '../limits.ts'
import { ToolResultStore } from '../session/tool-results.ts'
import type { ToolDefinition } from './registry.ts'
import type { ExecutionMetadata } from '../session/tool-history.ts'

const bashToolParamSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
})

export const createBashTool = (
  cwd?: string,
  { timeoutMs = DEFAULT_LIMITS.bashTimeoutMs }: { timeoutMs?: number } = {},
): ToolDefinition => ({
  name: 'bash',
  description:
    `执行 shell 命令（${Math.round(timeoutMs / 1000)} 秒超时），保存完整 stdout/stderr，返回退出状态和日志尾部预览。可用 read_file 分页读取完整结果。`,
  inputSchema: bashToolParamSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }, context) => {
    const results = context?.results ?? new ToolResultStore()
    // Open before executing: storage failure must not lead to rerunning a command.
    const { path, file } = await results.createFile(context?.callId)
    let status: string
    const execution: ExecutionMetadata = {}
    try {
      const proc = spawn('bash', ['-lc', command], {
        cwd,
        stdio: ['ignore', file.fd, file.fd],
        // POSIX process group lets timeout/cancellation stop pipelines and descendants.
        detached: process.platform !== 'win32',
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          proc.once('error', reject)
          proc.once('exit', (code, signal) => resolve({ code, signal }))
        },
      )
      const terminate = () => {
        try {
          if (process.platform === 'win32') proc.kill('SIGKILL')
          else if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL')
        } catch (error) {
          if (
            !(
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            throw error
        }
      }
      const timer = setTimeout(() => {
        execution.timedOut = true
        terminate()
      }, timeoutMs)
      context?.signal?.addEventListener('abort', terminate, { once: true })
      if (context?.signal?.aborted) terminate()
      let exitCode: number
      let signal: NodeJS.Signals | null
      try {
        const result = await exited
        signal = result.signal
        // 被信号结束时同 shell 的约定：128 + 信号编号
        exitCode =
          result.code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)
      } finally {
        clearTimeout(timer)
        context?.signal?.removeEventListener('abort', terminate)
      }
      execution.exitCode = exitCode
      execution.signal = signal
      execution.isError = exitCode !== 0 || !!execution.timedOut
      status = `exit=${exitCode}${signal ? `, signal=${signal}` : ''}`
    } catch (error) {
      execution.isError = true
      execution.error = error instanceof Error ? error.message : String(error)
      status = `命令执行失败: ${error}`
    } finally {
      try {
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const { size } = await stat(path)
    const start = Math.max(0, size - 6000)
    const bytes = await readRange(path, start, size - start)
    let skip = 0
    while (skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip++
    let tail = new TextDecoder().decode(bytes.subarray(skip))
    if (tail.length > 3000) {
      let offset = tail.length - 3000
      if (
        tail.charCodeAt(offset) >= 0xdc00 &&
        tail.charCodeAt(offset) <= 0xdfff
      )
        offset++
      tail = tail.slice(offset)
    }
    const preview = `${status}; stdout/stderr combined, ${size} bytes total; showing last ${tail.length} UTF-16 code units.\n${tail || '(无输出)'}`
    return results.reference(
      path,
      'bash',
      preview,
      context?.toolCallId,
      execution,
      context?.callId,
    )
  },
})

export const bashTool = createBashTool()

async function readRange(
  path: string,
  position: number,
  length: number,
): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
