import z from 'zod'
import { followFileInfo } from '../execution/file-info.ts'
import { createLocalExecutionEnv } from '../execution/local.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import { type BinaryResolver, createBinaryResolver } from './binaries.ts'
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
  const root = searchPath.replaceAll('\\', '/').replace(/\/$/, '')
  const candidate = path.replaceAll('\\', '/')
  if (candidate.startsWith(`${root}/`)) return candidate.slice(root.length + 1)
  if (candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate))
    return candidate.split('/').filter(Boolean).at(-1) ?? ''
  return candidate
}

/**
 * Run a search program and hand each stdout line to onLine; onLine returns false to stop early
 * (the process is killed). Resolves with the exit code, or null when it was stopped.
 */
async function runLines(
  env: ExecutionEnv,
  command: string,
  args: string[],
  onLine: (line: string) => boolean,
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let pending = '',
    stderr = '',
    stopped = false
  const consume = (line: string) => {
    if (!stopped && !onLine(line)) {
      stopped = true
      controller.abort()
    }
  }
  try {
    const result = await env.exec(
      [command, ...args],
      {
        onOutput: (text, _signal, info) => {
          if (info.stream === 'stderr') {
            stderr += text
            return
          }
          pending += text
          let end = pending.indexOf('\n')
          while (end >= 0) {
            consume(pending.slice(0, end))
            pending = pending.slice(end + 1)
            end = pending.indexOf('\n')
          }
        },
      },
      controller.signal,
    )
    if (signal?.aborted) throw signal.reason
    if (pending && !stopped) consume(pending)
    if (stopped) return { code: null, stderr }
    if (!result.ok) throw result.error
    return { code: result.value.exitCode, stderr }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
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

async function isDirectory(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await followFileInfo(env, path, signal)
  if (!result.ok)
    throw new Error(`Path not found: ${path}`, { cause: result.error })
  return result.value.kind === 'directory'
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
  replay: 'safe',
  executionMode: 'parallel',
  activeByDefault: false,
  description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is limited to ${GREP_DEFAULT_LIMIT} matches by default. Long lines are truncated to ${MAX_LINE_LENGTH} chars.`,
  inputSchema: grepToolParamSchema,
  annotations: { readOnlyHint: true },
  promptSnippet: 'Search file contents for a pattern (respects .gitignore)',
  maxResultChars: 12000,
  execute: async (input: z.infer<typeof grepToolParamSchema>, context) => {
    const { pattern, path = '.', glob, ignoreCase, literal } = input
    const env =
      context?.execution ??
      (context?.requireEnv
        ? await context.requireEnv(context?.signal)
        : createLocalExecutionEnv({ cwd: cwd ?? process.cwd() }))
    const rg =
      env.id === 'node:local'
        ? await binary(resolveBinary, 'rg', context?.signal)
        : 'rg'
    const absolute = await env.absolutePath(path, context?.signal)
    if (!absolute.ok) throw absolute.error
    const searchPath = absolute.value
    const directory = await isDirectory(env, searchPath, context?.signal)
    const contextLines = input.context && input.context > 0 ? input.context : 0
    const limit = Math.max(1, input.limit ?? GREP_DEFAULT_LIMIT)
    const formatPath = (file: string) => {
      if (directory) {
        const rel = relativeTo(searchPath, file)
        if (rel && !rel.startsWith('..')) return rel
      }
      return (
        file.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? file
      )
    }

    const args = ['--json', '--line-number', '--color=never', '--hidden']
    if (contextLines > 0) args.push('-C', String(contextLines))
    if (ignoreCase) args.push('--ignore-case')
    if (literal) args.push('--fixed-strings')
    if (glob) args.push('--glob', glob)
    // Like find: outside a git repo rg ignores .gitignore unless told otherwise (pi's grep misses this)
    const gitRoot = directory
      ? { ok: true as const, value: searchPath }
      : await env.joinPath([searchPath, '..'], context?.signal)
    if (!gitRoot.ok) throw gitRoot.error
    if (!(await insideGitRepo(env, gitRoot.value, context?.signal)))
      args.push('--no-require-git')
    // --hidden would also search git's own files (logs, config); pi doesn't exclude them, Vela does
    args.push('--glob', '!.git', '--', pattern, searchPath)

    const entries: {
      file: string
      line: number
      text: string
      isMatch: boolean
    }[] = []
    let matchCount = 0
    let hasMore = false
    let lastMatchFile: string | undefined
    let lastMatchLine: number | undefined
    const { code, stderr } = await runLines(
      env,
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
        if (event.type !== 'match' && event.type !== 'context') return true
        const file = event.data?.path?.text
        const lineNumber = event.data?.line_number
        if (!file || typeof lineNumber !== 'number') return true
        if (event.type === 'match') {
          if (matchCount >= limit) {
            hasMore = true
            return false
          }
          matchCount++
          lastMatchFile = file
          lastMatchLine = lineNumber
        } else if (
          matchCount >= limit &&
          (file !== lastMatchFile ||
            lastMatchLine === undefined ||
            lineNumber <= lastMatchLine ||
            lineNumber > lastMatchLine + contextLines)
        ) {
          return true
        }
        entries.push({
          file,
          line: lineNumber,
          text: event.data?.lines?.text ?? '',
          isMatch: event.type === 'match',
        })
        return true
      },
      context?.signal,
    )
    // rg exits 1 when nothing matched; anything else is an error (bad regex, unreadable path)
    if (code !== null && code !== 0 && code !== 1)
      throw new Error(stderr.trim() || `ripgrep exited with code ${code}`)
    if (matchCount === 0) return 'No matches found'

    let linesTruncated = false
    const out: string[] = []
    for (const entry of entries) {
      const shown = formatPath(entry.file)
      const { text, truncated } = truncateLine(
        entry.text.replace(/\r?\n$/, '').replace(/\r/g, ''),
      )
      linesTruncated ||= truncated
      out.push(
        entry.isMatch
          ? `${shown}:${entry.line}: ${text}`
          : `${shown}-${entry.line}- ${text}`,
      )
    }

    const notices: string[] = []
    if (hasMore)
      notices.push(
        `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
      )
    if (linesTruncated)
      notices.push(
        `Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read to see full lines`,
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

async function insideGitRepo(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let current = path; ; ) {
    const git = await env.joinPath([current, '.git'], signal)
    if (!git.ok) throw git.error
    const exists = await env.exists(git.value, signal)
    if (!exists.ok) throw exists.error
    if (exists.value) return true
    const parent = await env.joinPath([current, '..'], signal)
    if (!parent.ok) throw parent.error
    if (parent.value === current) return false
    current = parent.value
  }
}

export const createFindTool = (
  cwd?: string,
  resolveBinary: BinaryResolver = createBinaryResolver(),
): ToolDefinition => ({
  name: 'find',
  replay: 'safe',
  executionMode: 'parallel',
  activeByDefault: false,
  description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is limited to ${FIND_DEFAULT_LIMIT} results by default.`,
  inputSchema: findToolParamSchema,
  annotations: { readOnlyHint: true },
  promptSnippet: 'Find files by glob pattern (respects .gitignore)',
  maxResultChars: 12000,
  execute: async (input: z.infer<typeof findToolParamSchema>, context) => {
    const { pattern, path = '.' } = input
    const env =
      context?.execution ??
      (context?.requireEnv
        ? await context.requireEnv(context?.signal)
        : createLocalExecutionEnv({ cwd: cwd ?? process.cwd() }))
    const fd =
      env.id === 'node:local'
        ? await binary(resolveBinary, 'fd', context?.signal)
        : 'fd'
    const absolute = await env.absolutePath(path, context?.signal)
    if (!absolute.ok) throw absolute.error
    const searchPath = absolute.value
    if (!(await isDirectory(env, searchPath, context?.signal)))
      throw new Error(`Not a directory: ${searchPath}`)
    const limit = Math.max(1, input.limit ?? FIND_DEFAULT_LIMIT)

    const args = ['--glob', '--color=never', '--hidden']
    // Outside a git repo fd ignores .gitignore unless told otherwise; inside one, its default
    // git-aware behavior keeps parent .gitignore rules from crossing nested repos (same as pi)
    if (!(await insideGitRepo(env, searchPath, context?.signal)))
      args.push('--no-require-git')
    args.push('--max-results', String(limit + 1))
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
      if (/^[A-Za-z]:[\\/]/.test(env.cwd))
        effective = effective.replaceAll('/', String.raw`[/\\]`)
    }
    args.push('--', effective, searchPath)

    const collect = async (cmd: string) => {
      const found: string[] = []
      const run = await runLines(
        env,
        cmd,
        args,
        (line) => {
          const trimmed = line.replace(/\r$/, '').trim()
          if (trimmed) found.push(relativeTo(searchPath, trimmed))
          return true
        },
        context?.signal,
      )
      return { ...run, found }
    }

    let outcome: { code: number | null; stderr: string; found: string[] }
    try {
      outcome = await collect(fd)
    } catch (error) {
      if (env.id === 'node:local') throw error
      outcome = await collect('fdfind').catch(() => {
        throw error
      })
    }
    if (
      outcome.code !== 0 &&
      outcome.found.length === 0 &&
      env.id !== 'node:local' &&
      /(?:not found|no such file|ENOENT)/i.test(outcome.stderr)
    ) {
      const retry = await collect('fdfind').catch(() => outcome)
      if (retry.code === 0 || retry.found.length > 0) outcome = retry
    }
    const { code, stderr, found } = outcome
    if (code !== 0 && found.length === 0)
      throw new Error(stderr.trim() || `fd exited with code ${code}`)
    if (found.length === 0) return 'No files found matching pattern'
    const hasMore = found.length > limit
    const shown = hasMore ? found.slice(0, limit) : found
    return hasMore
      ? `${shown.join('\n')}\n\n[${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern]`
      : shown.join('\n')
  },
})
