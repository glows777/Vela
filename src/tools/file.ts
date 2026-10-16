import { constants, createReadStream, readdirSync } from 'node:fs'
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import z from 'zod'
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
import { type ToolDefinition, ToolExecutionResult } from './registry.ts'

/** Default page of read_file, same as pi: 2000 lines or 50KB, whichever comes first */
export const READ_MAX_LINES = 2000
export const READ_MAX_BYTES = 50 * 1024

// 96 MiB of bytes encode to the normalizer's 128 MiB base64 input limit.
const READ_MAX_IMAGE_BYTES = 96 * 1024 * 1024
const IMAGE_HEADER_BYTES = 18

/** Recognize image signatures without trying to decode possibly incomplete bytes. */
function imageMimeType(header: Buffer): string | undefined {
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png'
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6)))
    return 'image/gif'
  if (
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  // "BM" also starts ordinary prose. Require the binary BMP file header and a
  // recognized DIB header size before treating text as an image.
  if (
    header.length >= 18 &&
    header.toString('ascii', 0, 2) === 'BM' &&
    header.readUInt32LE(6) === 0
  ) {
    const dibSize = header.readUInt32LE(14)
    const pixelOffset = header.readUInt32LE(10)
    if (
      [12, 16, 40, 52, 56, 64, 108, 124].includes(dibSize) &&
      pixelOffset >= 14 + dibSize &&
      header.readUInt32LE(2) >= pixelOffset
    )
      return 'image/bmp'
  }
  return undefined
}

/** Bound image reads before allocating base64; text files still use the existing pager. */
async function readImage(
  file: string,
  path: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult | undefined> {
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(IMAGE_HEADER_BYTES)
    let headerLength = 0
    while (headerLength < header.length) {
      const { bytesRead } = await handle.read(
        header,
        headerLength,
        header.length - headerLength,
        headerLength,
      )
      if (!bytesRead) break
      headerLength += bytesRead
    }
    const mimeType = imageMimeType(header.subarray(0, headerLength))
    if (!mimeType) return undefined
    const tooLarge = () =>
      new Error('Cannot read image: image exceeds the safe decoding size limit')
    if ((await handle.stat()).size > READ_MAX_IMAGE_BYTES) throw tooLarge()
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
      signal,
    })) {
      length += chunk.length
      // Also bound a file that grows after stat, or a stream with an unknown size.
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

/** Writes a text file, creating missing parent directories (like Bun.write). */
async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** Resolves relative paths against cwd, or the process working directory when cwd is unset. */
export const resolveIn = (cwd: string | undefined, path: string) =>
  cwd ? resolve(cwd, path) : resolve(path)

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
  // A full page plus the footer must fit, so pages are never saved to a file again
  maxResultChars: READ_MAX_BYTES + 1024,
  execute: async (input: z.infer<typeof readFileParamSchema>, context) => {
    const {
      path,
      offset = 1,
      limit = READ_MAX_LINES,
      column = 0,
    } = readFileParamSchema.parse(input)
    const file = resolveIn(cwd, path)
    const image = await readImage(file, path, context?.signal)
    if (image) return image
    const decoder = new TextDecoder()
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
    for await (const chunk of createReadStream(file)) {
      if (!consume(decoder.decode(chunk, { stream: true }))) break
    }
    if (!more) consume(decoder.decode())
    if (!reachedStart && !(line === offset && col === column))
      throw new Error('offset/column is past the end of the file')
    if (!more) return body
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

  annotations: { destructiveHint: true, idempotentHint: true },
  execute: async ({ path, content }: { path: string; content: string }) => {
    const resolved = resolveIn(cwd, path)
    // Writes to the same file queue up; different files are written in parallel (like pi)
    await withFileMutationQueue(resolved, () => writeText(resolved, content))
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
  execute: async ({ path = '.' }: { path?: string }) => {
    const resolved = resolveIn(cwd, path)
    return readdirSync(resolved, { withFileTypes: true })
      .map(
        (entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`,
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
  execute: async (input: EditInput, context) => {
    const { path, edits } = input
    const resolved = resolveIn(cwd, path)
    const signal = context?.signal
    return withFileMutationQueue(resolved, async () => {
      // Check the signal after each await instead of rejecting from an abort listener, so the
      // queue stays locked until an in-flight filesystem operation has settled (like pi)
      const throwIfAborted = () => {
        if (signal?.aborted) throw new Error('Operation aborted')
      }
      throwIfAborted()
      try {
        await access(resolved, constants.R_OK | constants.W_OK)
      } catch (error) {
        throwIfAborted()
        const code =
          error instanceof Error && 'code' in error
            ? `Error code: ${error.code}`
            : String(error)
        throw new Error(`Could not edit file: ${path}. ${code}.`)
      }
      const raw = await readFile(resolved, 'utf8')
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
      await writeFile(resolved, bom + restoreLineEndings(newContent, ending))
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
    })
  },
})

export const readFileTool = createReadFileTool()
export const writeFileTool = createWriteFileTool()
export const listDirectoryTool = createListDirectoryTool()
export const editFileTool = createEditFileTool()
