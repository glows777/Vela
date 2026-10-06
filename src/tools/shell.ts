import z from 'zod'
import { ToolResultStore } from '../session/tool-results'
import type { ToolDefinition } from './registry'
import type { ExecutionMetadata } from '../session/tool-history'

const bashToolParamSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
})

export const createBashTool = (cwd?: string): ToolDefinition => ({
  name: 'bash',
  description:
    '执行 shell 命令（10 秒超时），保存完整 stdout/stderr，返回退出状态和日志尾部预览。可用 read_file 分页读取完整结果。',
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
      const proc = Bun.spawn({
        cmd: ['bash', '-lc', command],
        cwd,
        stdin: 'ignore',
        stdout: file.fd,
        stderr: file.fd,
        // POSIX process group lets timeout/cancellation stop pipelines and descendants.
        detached: process.platform !== 'win32',
      })
      const terminate = () => {
        try {
          if (process.platform === 'win32') proc.kill('SIGKILL')
          else process.kill(-proc.pid, 'SIGKILL')
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
      }, 10000)
      context?.signal?.addEventListener('abort', terminate, { once: true })
      if (context?.signal?.aborted) terminate()
      let exitCode: number
      try {
        exitCode = await proc.exited
      } finally {
        clearTimeout(timer)
        context?.signal?.removeEventListener('abort', terminate)
      }
      execution.exitCode = exitCode
      execution.signal = proc.signalCode ?? null
      execution.isError = exitCode !== 0 || !!execution.timedOut
      status = `exit=${exitCode}${proc.signalCode ? `, signal=${proc.signalCode}` : ''}`
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
    const output = Bun.file(path)
    const start = Math.max(0, output.size - 6000)
    const bytes = new Uint8Array(await output.slice(start).arrayBuffer())
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
    const preview = `${status}; stdout/stderr combined, ${output.size} bytes total; showing last ${tail.length} UTF-16 code units.\n${tail || '(无输出)'}`
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
