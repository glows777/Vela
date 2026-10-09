import { createReadStream, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import z from 'zod'
import type { ToolDefinition } from './registry.ts'

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
    .describe('Maximum number of lines to read. Default 200'),
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
  description:
    'Reads a text file or a saved tool result file, one page at a time. Returns the range shown and the offset/column for the next page. The file is fully read only when the result says EOF.',
  inputSchema: readFileParamSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 12000,
  execute: async (input: z.infer<typeof readFileParamSchema>) => {
    const {
      path,
      offset = 1,
      limit = 200,
      column = 0,
    } = readFileParamSchema.parse(input)
    const file = resolveIn(cwd, path)
    const decoder = new TextDecoder()
    let line = 1
    let col = 0
    let body = ''
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
          if (body.length + char.length > 8000 || line >= offset + limit) {
            more = true
            return false
          }
          body += char
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
    const next = more
      ? `More content exists. Continue read_file with path=${JSON.stringify(path)}, offset=${line}, column=${col}, limit=${limit}.`
      : 'EOF: no more content.'
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

  isConcurrencySafe: false, // writes must not run in parallel
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    await writeText(resolveIn(cwd, path), content)
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
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = '.' }: { path?: string }) => {
    const resolved = resolveIn(cwd, path)
    return readdirSync(resolved, { withFileTypes: true })
      .map(
        (entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`,
      )
      .join('\n')
  },
})

const editFileToolParamSchema = z.object({
  path: z
    .string()
    .describe('File path, absolute or relative to the working directory'),
  old_string: z
    .string()
    .describe(
      'Exact text to replace; must match the file exactly, including whitespace and newlines',
    ),
  new_string: z.string().describe('Replacement text'),
})
export const createEditFileTool = (cwd?: string): ToolDefinition => ({
  name: 'edit_file',
  description:
    'Replaces exact text in a file: old_string locates the text, new_string replaces it. Not a full rewrite; only the matched part changes. old_string must occur exactly once.',
  inputSchema: editFileToolParamSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({
    path,
    old_string,
    new_string,
  }: {
    path: string
    old_string: string
    new_string: string
  }) => {
    const resolved = resolveIn(cwd, path)
    let content: string
    try {
      content = await readFile(resolved, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return `File not found: ${path}`
      throw error
    }
    const count = content.split(old_string).length - 1

    if (count === 0) {
      return `No match found. Check that old_string matches the file text exactly, including whitespace and newlines`
    }
    if (count > 1) {
      return `Found ${count} matches. Add more context so old_string is unique`
    }

    // Slice instead of String.replace: replace would interpret $&, $$, $1 ... in new_string
    const at = content.indexOf(old_string)
    const updated =
      content.slice(0, at) + new_string + content.slice(at + old_string.length)
    await writeText(resolved, updated)
    return `Replaced text in ${path} (${old_string.length} → ${new_string.length} characters)`
  },
})

export const readFileTool = createReadFileTool()
export const writeFileTool = createWriteFileTool()
export const listDirectoryTool = createListDirectoryTool()
export const editFileTool = createEditFileTool()
