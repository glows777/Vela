import z from 'zod'
import { createLocalExecutionEnv } from '../execution/local.ts'
import type { ExecutionEnv, FileError, Result } from '../execution/types.ts'
import { imageMimeType, isBinaryFile } from '../images/metadata.ts'
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
} from './edit-diff.ts'
import { withFileMutationQueue } from './file-mutation-queue.ts'
import { stateFor } from './file-write-guard.ts'
import type { ToolDefinition } from './registry.ts'
import { ToolExecutionResult } from './types.ts'

/** Default page of read_file, same as pi: 2000 lines or 50KB, whichever comes first */
const READ_MAX_LINES = 2000
const READ_MAX_BYTES = 50 * 1024

// 96 MiB of bytes encode to the normalizer's 128 MiB base64 input limit.
const READ_MAX_IMAGE_BYTES = 96 * 1024 * 1024
const FILE_HEADER_BYTES = 8192

const binaryFileError = (path: string) =>
  new Error(
    `Cannot read ${path}: binary file. Use bash tools such as pdftotext or unzip -l to inspect it.`,
  )

function unwrap<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** Inspect the environment's file header and return supported images whole. */
async function readSpecialFile(
  env: ExecutionEnv,
  file: string,
  path: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult | undefined> {
  const handle = unwrap(await env.openBinaryReader(file, undefined, signal))
  try {
    const bytes = Buffer.from(
      unwrap(await handle.read(0, FILE_HEADER_BYTES, signal)),
    )
    const mimeType = imageMimeType(bytes)
    if (!mimeType) {
      if (isBinaryFile(bytes, true)) throw binaryFileError(path)
      return undefined
    }
    const tooLarge = () =>
      new Error('Cannot read image: image exceeds the safe decoding size limit')
    if (unwrap(await handle.info(signal)).size > READ_MAX_IMAGE_BYTES)
      throw tooLarge()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const chunk = unwrap(await handle.read(length, 64 * 1024, signal))
      if (!chunk.length) break
      length += chunk.length
      if (length > READ_MAX_IMAGE_BYTES) throw tooLarge()
      chunks.push(chunk)
    }
    return new ToolExecutionResult({ path, mimeType, bytes: length }, [
      {
        type: 'image',
        data: Buffer.concat(chunks, length).toString('base64'),
        mimeType,
      },
    ])
  } finally {
    await handle.close()
  }
}

/** UTF-8 size of one code point (a string from iterating a string) */
const utf8Bytes = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

export const readFileParamSchema = z.object({
  path: z
    .string()
    .describe('File path, absolute or relative to the working directory'),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Line to start from, 1-based. Default 1'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of lines to read. Default ${READ_MAX_LINES}`),
  column: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'UTF-16 offset within the start line. Default 0. To continue a very long line, pass the column from the previous result',
    ),
})
export const createReadFileTool = (cwd?: string): ToolDefinition => ({
  name: 'read_file',
  description: `Reads a text file, a saved tool result file, or a JPEG, PNG, GIF, WebP or BMP image detected by its contents. Images are returned whole as image content; offset, limit and column are ignored for images and only paginate text. A text page is at most ${READ_MAX_LINES} lines or ${READ_MAX_BYTES / 1024}KB, whichever comes first. When more content remains, appends a footer with the range shown and the offset/column for the next page. At EOF, returns only the file content with no added footer.`,
  inputSchema: readFileParamSchema,
  annotations: { readOnlyHint: true },
  promptSnippet: 'Read file contents (text, or an image by path)',
  promptGuidelines: ['Use read_file instead of `cat` or `sed` to read a file.'],
  // A full page plus the footer must fit, so pages are never saved to a file again
  maxResultChars: READ_MAX_BYTES + 1024,
  execute: async (input: z.infer<typeof readFileParamSchema>, context) => {
    const {
      path,
      offset = 1,
      limit = READ_MAX_LINES,
      column = 0,
    } = readFileParamSchema.parse(input)
    const env =
      context?.execution ??
      createLocalExecutionEnv({ cwd: cwd ?? process.cwd() })
    const file = unwrap(await env.absolutePath(path, context?.signal))
    const image = await readSpecialFile(env, file, path, context?.signal)
    if (image) return image
    const state = stateFor(context)
    const guardKey = `${env.id}:${file}`
    const snapshot = unwrap(await env.fileInfo(file, context?.signal))
    const decoder = new TextDecoder('utf-8', { fatal: true })
    // Validate every chunk the pager reads, including bytes past the header.
    // Streaming preserves UTF-8 characters split across chunks.
    const decodeText = (bytes?: Buffer): string => {
      if (bytes?.includes(0)) throw binaryFileError(path)
      try {
        return decoder.decode(bytes, { stream: bytes !== undefined })
      } catch {
        throw binaryFileError(path)
      }
    }
    let line = 1
    let col = 0
    let body = ''
    let bodyBytes = 0
    let more = false
    let reachedStart = offset === 1 && column === 0
    let lastLine = offset
    const consume = (text: string): boolean => {
      for (const char of text) {
        if (line === offset && col < column && col + char.length > column)
          throw new Error(
            'column falls inside a Unicode character; use the column from the previous result',
          )
        if (line >= offset && (line > offset || col >= column)) {
          reachedStart = true
          if (
            bodyBytes + utf8Bytes(char) > READ_MAX_BYTES ||
            line >= offset + limit
          ) {
            more = true
            return false
          }
          body += char
          bodyBytes += utf8Bytes(char)
          lastLine = line
        }
        if (char === '\n') {
          if (line === offset && col < column)
            throw new Error('column is past the end of the start line')
          line++
          col = 0
        } else {
          col += char.length
        }
      }
      return true
    }
    const reader = unwrap(
      await env.openBinaryReader(file, undefined, context?.signal),
    )
    try {
      let position = 0
      while (true) {
        const chunk = unwrap(
          await reader.read(position, 64 * 1024, context?.signal),
        )
        if (!chunk.length) break
        position += chunk.length
        if (!consume(decodeText(Buffer.from(chunk)))) break
      }
    } finally {
      await reader.close()
    }
    if (!more) consume(decodeText())
    if (!reachedStart && !(line === offset && col === column))
      throw new Error('offset/column is past the end of the file')
    if (!more) {
      state?.noteRead(guardKey, offset, column, undefined, snapshot)
      return body
    }
    state?.noteRead(guardKey, offset, column, { line, col }, snapshot)
    const next = `More content exists. Continue read_file with path=${JSON.stringify(path)}, offset=${line}, column=${col}, limit=${limit}.`
    return `${body}\n\n[read_file: lines ${offset}-${lastLine}, starting column=${column}; ${body.length} UTF-16 code units shown. ${next}]`
  },
})

const writeFileToolParamSchema = z.object({
  path: z
    .string()
    .describe('File path, absolute or relative to the working directory'),
  content: z.string().describe('Full content to write'),
})
export const createWriteFileTool = (cwd?: string): ToolDefinition => ({
  name: 'write_file',
  description:
    'Writes content to a file, replacing the whole file. Creates the file and missing parent directories.',
  inputSchema: writeFileToolParamSchema,
  promptSnippet: 'Create or overwrite a file',
  promptGuidelines: [
    'Use write_file only for new files or complete rewrites; read a file before you replace it.',
  ],
  annotations: { destructiveHint: true, idempotentHint: true },
  execute: async (
    { path, content }: { path: string; content: string },
    context,
  ) => {
    const env =
      context?.execution ??
      createLocalExecutionEnv({ cwd: cwd ?? process.cwd() })
    const signal = context?.signal
    const resolved = unwrap(await env.absolutePath(path, signal))
    const guardKey = `${env.id}:${resolved}`
    const state = stateFor(context)
    await withFileMutationQueue(
      resolved,
      async () => {
        if (state) {
          const info = await env.fileInfo(resolved, signal)
          if (!info.ok && info.error.code !== 'not_found') throw info.error
          const refusal = state.refusal(
            guardKey,
            path,
            info.ok ? info.value : undefined,
          )
          if (refusal) throw new Error(refusal)
        }
        const parent = unwrap(await env.joinPath([resolved, '..'], signal))
        unwrap(await env.createDir(parent, { recursive: true }, signal))
        unwrap(await env.writeFile(resolved, content, signal))
        if (state)
          state.noteWritten(
            guardKey,
            unwrap(await env.fileInfo(resolved, signal)),
          )
      },
      env,
      signal,
    )
    return `Wrote ${content.length} characters to ${path}`
  },
})

const listDirectoryToolParamSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('Directory path. Defaults to the working directory'),
})
export const createListDirectoryTool = (cwd?: string): ToolDefinition => ({
  name: 'list_directory',
  description: 'Lists the files and subdirectories in a directory.',
  inputSchema: listDirectoryToolParamSchema,
  annotations: { readOnlyHint: true },
  promptSnippet: 'List directory contents',
  activeByDefault: false,
  execute: async ({ path = '.' }: { path?: string }, context) => {
    const env =
      context?.execution ??
      createLocalExecutionEnv({ cwd: cwd ?? process.cwd() })
    const resolved = unwrap(await env.absolutePath(path, context?.signal))
    return unwrap(await env.listDir(resolved, context?.signal))
      .map(
        (entry) =>
          `${entry.kind === 'directory' ? '[DIR]' : '[FILE]'} ${entry.name}`,
      )
      .join('\n')
  },
})

const editSchema = z.object({
  path: z
    .string()
    .describe('File path, absolute or relative to the working directory'),
  edits: z
    .array(
      z.object({
        oldText: z
          .string()
          .describe(
            'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
          ),
        newText: z
          .string()
          .describe('Replacement text for this targeted edit.'),
      }),
    )
    .min(1)
    .describe(
      'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
    ),
})
type EditInput = z.infer<typeof editSchema>

const isSingleEdit = (
  value: unknown,
): value is { oldText: string; newText: string } =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).oldText === 'string' &&
  typeof (value as Record<string, unknown>).newText === 'string'

/**
 * Same as pi's prepareArguments: some models send edits as a JSON string, a single edit object,
 * or a top-level oldText/newText. Rewrite those into edits[] before validation.
 */
function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const args = { ...(input as Record<string, unknown>) }
  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
      else if (isSingleEdit(parsed)) args.edits = [parsed]
    } catch {}
  } else if (isSingleEdit(args.edits)) {
    args.edits = [args.edits]
  }
  if (typeof args.oldText !== 'string' || typeof args.newText !== 'string')
    return args
  const { oldText, newText, ...rest } = args
  return {
    ...rest,
    edits: [
      ...(Array.isArray(args.edits) ? args.edits : []),
      { oldText, newText },
    ],
  }
}

export const editFileToolParamSchema = z.preprocess(
  prepareEditArguments,
  editSchema,
)

/** Structured result of edit_file (kept in the tool history; the model only gets the summary line) */
export interface EditFileDetails {
  /** Display diff with line numbers and a few lines of context */
  diff: string
  /** Standard unified patch */
  patch: string
  /** First changed line in the new file */
  firstChangedLine?: number
}

export const createEditFileTool = (cwd?: string): ToolDefinition => ({
  name: 'edit_file',
  description:
    'Edits a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
  inputSchema: editFileToolParamSchema,
  annotations: { destructiveHint: true },
  promptSnippet: 'Make precise file edits by replacing exact text',
  promptGuidelines: [
    'Read a file before you change it.',
    'Use edit_file for targeted changes, and batch the changes to one file in a single call.',
  ],
  execute: async (input: EditInput, context) => {
    const { path, edits } = input
    const env =
      context?.execution ??
      createLocalExecutionEnv({ cwd: cwd ?? process.cwd() })
    const signal = context?.signal
    const resolved = unwrap(await env.absolutePath(path, signal))
    const guardKey = `${env.id}:${resolved}`
    const state = stateFor(context)
    return withFileMutationQueue(
      resolved,
      async () => {
        const throwIfAborted = () => {
          if (signal?.aborted) throw new Error('Operation aborted')
        }
        throwIfAborted()
        const raw = unwrap(await env.readTextFile(resolved, signal))
        throwIfAborted()
        // The model never includes an invisible BOM in oldText; match without it and restore it on write
        const { bom, text } = splitBom(raw)
        const ending = detectLineEnding(text)
        const { baseContent, newContent } = applyEditsToNormalizedContent(
          normalizeToLF(text),
          edits,
          path,
        )
        throwIfAborted()
        unwrap(
          await env.writeFile(
            resolved,
            bom + restoreLineEndings(newContent, ending),
            signal,
          ),
        )
        if (state)
          state.noteWritten(
            guardKey,
            unwrap(await env.fileInfo(resolved, signal)),
          )
        throwIfAborted()
        const { diff, firstChangedLine } = generateDiffString(
          baseContent,
          newContent,
        )
        const details: EditFileDetails = {
          diff,
          patch: generateUnifiedPatch(path, baseContent, newContent),
          ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
        }
        return new ToolExecutionResult(
          details,
          `Successfully replaced ${edits.length} block(s) in ${path}.`,
        )
      },
      env,
      signal,
    )
  },
})

export const readFileTool = createReadFileTool()
