import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import z from 'zod'
import { type BinaryResolver, createBinaryResolver } from './binaries.ts'
import { resolveIn } from './file.ts'
import type { ToolDefinition } from './registry.ts'

// Same tools, parameters and output as pi: grep runs ripgrep, find runs fd. Both respect .gitignore
// and include hidden files.

const GREP_DEFAULT_LIMIT = 100
const FIND_DEFAULT_LIMIT = 1000
const MAX_LINE_LENGTH = 500

const truncateLine = (line: string) =>
  line.length <= MAX_LINE_LENGTH
    ? { text: line, truncated: false }
    : {
        text: `${line.slice(0, MAX_LINE_LENGTH)}... [truncated]`,
        truncated: true,
      }

/** Paths in the output: relative to the search directory, with forward slashes. */
const relativeTo = (searchPath: string, path: string) => {
  const posix = (isAbsolute(path) ? relative(searchPath, path) : path)
    .split(sep)
    .join('/')
  // fd prints directories with a trailing separator; keep it so they read as directories
  return /[\\/]$/.test(path) && !posix.endsWith('/') ? `${posix}/` : posix
}

/**
 * Run a search program and hand each stdout line to onLine; onLine returns false to stop early
 * (the process is killed). Resolves with the exit code, or null when it was stopped.
 */
function runLines(
  command: string,
  args: string[],
  onLine: (line: string) => boolean,
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const decoder = new TextDecoder()
    let pending = ''
    let stderr = ''
    let stopped = false
    const stop = () => {
      stopped = true
      child.kill()
    }
    signal?.addEventListener('abort', stop, { once: true })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const consume = (line: string) => {
      if (!stopped && !onLine(line)) stop()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      pending += decoder.decode(chunk, { stream: true })
      let end = pending.indexOf('\n')
      while (end >= 0) {
        consume(pending.slice(0, end))
        pending = pending.slice(end + 1)
        end = pending.indexOf('\n')
      }
    })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', stop)
      reject(new Error(`Failed to run ${command}: ${error.message}`))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop)
      pending += decoder.decode()
      if (pending) consume(pending)
      if (signal?.aborted) reject(signal.reason)
      else resolve({ code: stopped ? null : code, stderr })
    })
  })
}

/** Wait for rg / fd, but stop waiting when the tool call is aborted (a first download can take a while). */
function binary(
  resolveBinary: BinaryResolver,
  tool: 'rg' | 'fd',
  signal?: AbortSignal,
): Promise<string> {
  if (!signal) return resolveBinary(tool)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    resolveBinary(tool)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    throw new Error(`Path not found: ${path}`)
  }
}

const grepToolParamSchema = z.object({
  pattern: z.string().describe('Search pattern (regex or literal string)'),
  path: z
    .string()
    .optional()
    .describe('Directory or file to search (default: current directory)'),
  glob: z
    .string()
    .optional()
    .describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"),
  ignoreCase: z
    .boolean()
    .optional()
    .describe('Case-insensitive search (default: false)'),
  literal: z
    .boolean()
    .optional()
    .describe(
      'Treat pattern as literal string instead of regex (default: false)',
    ),
  context: z
    .number()
    .int()
    .optional()
    .describe(
      'Number of lines to show before and after each match (default: 0)',
    ),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})`,
    ),
})

export const createGrepTool = (
  cwd?: string,
  resolveBinary: BinaryResolver = createBinaryResolver(),
): ToolDefinition => ({
  name: 'grep',
  description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is limited to ${GREP_DEFAULT_LIMIT} matches by default. Long lines are truncated to ${MAX_LINE_LENGTH} chars.`,
  inputSchema: grepToolParamSchema,
  isReadOnly: true,
  maxResultChars: 12000,
  execute: async (input: z.infer<typeof grepToolParamSchema>, context) => {
    const { pattern, path = '.', glob, ignoreCase, literal } = input
    const rg = await binary(resolveBinary, 'rg', context?.signal)
    const searchPath = resolveIn(cwd, path)
    const directory = await isDirectory(searchPath)
    const contextLines = input.context && input.context > 0 ? input.context : 0
    const limit = Math.max(1, input.limit ?? GREP_DEFAULT_LIMIT)
    const formatPath = (file: string) => {
      if (directory) {
        const rel = relativeTo(searchPath, file)
        if (rel && !rel.startsWith('..')) return rel
      }
      return basename(file)
    }

    const args = ['--json', '--line-number', '--color=never', '--hidden']
    if (ignoreCase) args.push('--ignore-case')
    if (literal) args.push('--fixed-strings')
    if (glob) args.push('--glob', glob)
    // Like find: outside a git repo rg ignores .gitignore unless told otherwise (pi's grep misses this)
    if (!(await insideGitRepo(directory ? searchPath : dirname(searchPath))))
      args.push('--no-require-git')
    // --hidden would also search git's own files (logs, config); pi doesn't exclude them, Vela does
    args.push('--glob', '!.git', '--', pattern, searchPath)

    const matches: { file: string; line: number; text?: string }[] = []
    const { code, stderr } = await runLines(
      rg,
      args,
      (line) => {
        let event: {
          type?: string
          data?: {
            path?: { text?: string }
            line_number?: number
            lines?: { text?: string }
          }
        }
        try {
          event = JSON.parse(line)
        } catch {
          return true
        }
        if (event.type !== 'match') return true
        const file = event.data?.path?.text
        const lineNumber = event.data?.line_number
        if (file && typeof lineNumber === 'number')
          matches.push({
            file,
            line: lineNumber,
            text: event.data?.lines?.text,
          })
        return matches.length < limit
      },
      context?.signal,
    )
    // rg exits 1 when nothing matched; anything else is an error (bad regex, unreadable path)
    if (code !== null && code !== 0 && code !== 1)
      throw new Error(stderr.trim() || `ripgrep exited with code ${code}`)
    if (matches.length === 0) return 'No matches found'

    const fileLines = new Map<string, string[]>()
    const linesOf = async (file: string) => {
      let lines = fileLines.get(file)
      if (!lines) {
        lines = await readFile(file, 'utf8')
          .then((text) => text.replace(/\r\n?/g, '\n').split('\n'))
          .catch(() => [])
        fileLines.set(file, lines)
      }
      return lines
    }
    let linesTruncated = false
    const out: string[] = []
    for (const match of matches) {
      const shown = formatPath(match.file)
      if (contextLines === 0 && match.text !== undefined) {
        const { text, truncated } = truncateLine(
          match.text.replace(/\r?\n$/, '').replace(/\r/g, ''),
        )
        linesTruncated ||= truncated
        out.push(`${shown}:${match.line}: ${text}`)
        continue
      }
      const lines = await linesOf(match.file)
      if (!lines.length) {
        out.push(`${shown}:${match.line}: (unable to read file)`)
        continue
      }
      const start = Math.max(1, match.line - contextLines)
      const end = Math.min(lines.length, match.line + contextLines)
      for (let current = start; current <= end; current++) {
        const { text, truncated } = truncateLine(
          (lines[current - 1] ?? '').replace(/\r/g, ''),
        )
        linesTruncated ||= truncated
        out.push(
          current === match.line
            ? `${shown}:${current}: ${text}`
            : `${shown}-${current}- ${text}`,
        )
      }
    }

    const notices: string[] = []
    if (matches.length >= limit)
      notices.push(
        `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
      )
    if (linesTruncated)
      notices.push(
        `Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read_file to see full lines`,
      )
    return notices.length
      ? `${out.join('\n')}\n\n[${notices.join('. ')}]`
      : out.join('\n')
  },
})

const findToolParamSchema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    ),
  path: z
    .string()
    .optional()
    .describe('Directory to search in (default: current directory)'),
  limit: z
    .number()
    .int()
    .optional()
    .describe(`Maximum number of results (default: ${FIND_DEFAULT_LIMIT})`),
})

async function insideGitRepo(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    if (
      await stat(join(current, '.git')).then(
        () => true,
        () => false,
      )
    )
      return true
    if (dirname(current) === current) return false
  }
}

export const createFindTool = (
  cwd?: string,
  resolveBinary: BinaryResolver = createBinaryResolver(),
): ToolDefinition => ({
  name: 'find',
  description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is limited to ${FIND_DEFAULT_LIMIT} results by default.`,
  inputSchema: findToolParamSchema,
  isReadOnly: true,
  maxResultChars: 12000,
  execute: async (input: z.infer<typeof findToolParamSchema>, context) => {
    const { pattern, path = '.' } = input
    const fd = await binary(resolveBinary, 'fd', context?.signal)
    const searchPath = resolveIn(cwd, path)
    if (!(await isDirectory(searchPath)))
      throw new Error(`Not a directory: ${searchPath}`)
    const limit = Math.max(1, input.limit ?? FIND_DEFAULT_LIMIT)

    const args = ['--glob', '--color=never', '--hidden']
    // Outside a git repo fd ignores .gitignore unless told otherwise; inside one, its default
    // git-aware behavior keeps parent .gitignore rules from crossing nested repos (same as pi)
    if (!(await insideGitRepo(searchPath))) args.push('--no-require-git')
    args.push('--max-results', String(limit))
    // fd matches the basename unless --full-path; then it matches the absolute path, so a
    // pattern with a slash needs a leading **/ to match anything
    let effective = pattern
    if (pattern.includes('/')) {
      args.push('--full-path')
      if (
        !pattern.startsWith('/') &&
        !pattern.startsWith('**/') &&
        pattern !== '**'
      )
        effective = `**/${pattern}`
      if (process.platform === 'win32')
        effective = effective.replaceAll('/', String.raw`[/\\]`)
    }
    args.push('--', effective, searchPath)

    const results: string[] = []
    const { code, stderr } = await runLines(
      fd,
      args,
      (line) => {
        const trimmed = line.replace(/\r$/, '').trim()
        if (trimmed) results.push(relativeTo(searchPath, trimmed))
        return true
      },
      context?.signal,
    )
    if (code !== 0 && results.length === 0)
      throw new Error(stderr.trim() || `fd exited with code ${code}`)
    if (results.length === 0) return 'No files found matching pattern'
    return results.length >= limit
      ? `${results.join('\n')}\n\n[${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern]`
      : results.join('\n')
  },
})
