/**
 * MCP tools as Vela tools (like pi's `extensions/mcp/tools.ts`). Vela's tool results are text, so
 * images, audio and binary resources become one-line placeholders; long text goes through Vela's
 * usual "save the full output, show a head and tail preview" with pi's 20KB limit.
 */

import { createHash } from 'node:crypto'
import type {
  CallToolResult,
  Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js'
import { jsonSchema } from 'ai'
import type {
  ToolAnnotations,
  ToolDefinition,
  ToolNamespace,
} from '../../tools/registry.ts'
import { ToolExecutionResult } from '../../tools/registry.ts'
import type { McpExposure } from './config.ts'

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64
/** Model-facing text beyond this is saved to a file and previewed (pi cuts MCP text at 20KB). */
export const MCP_MAX_RESULT_CHARS = 20_000

type ContentBlock = CallToolResult['content'][number]

/**
 * `mcp__<server>__<tool>`, with everything but `[A-Za-z0-9_]` replaced by `_` (like pi and Codex),
 * and shortened with a hash suffix when too long or when `isTaken` reports the name is used by
 * another MCP tool (`a-b` and `a_b` map to the same name).
 */
export function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name
  const hash = createHash('sha256')
    .update(`${server}\0${tool}`)
    .digest('hex')
    .slice(0, 8)
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`
}

/** `mcp__<server>`: the namespace of a server's tools. */
export function namespaceName(server: string): string {
  return `mcp__${server}`.replace(/[^A-Za-z0-9_]/g, '_')
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Decoded size of base64 data. */
const base64Bytes = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.match(/=+$/)?.[0].length ?? 0)

/** Blobs of these types are shown as text. */
function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  const type = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  )
}

/** Model-facing text of one content block. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
    case 'audio':
      return `[${block.type === 'image' ? 'Image' : 'Audio'}: ${block.mimeType}, ${size(base64Bytes(block.data))} (not shown: Vela tool results are text only)]`
    case 'resource': {
      const { resource } = block
      if ('text' in resource) return resource.text
      if (isTextMimeType(resource.mimeType))
        return Buffer.from(resource.blob, 'base64').toString('utf8')
      return `[Binary resource ${resource.uri} (${resource.mimeType ?? 'unknown type'}, ${size(base64Bytes(resource.blob))}) not shown]`
    }
    case 'resource_link': {
      const details = [
        block.mimeType,
        block.size === undefined ? undefined : size(block.size),
      ].filter(Boolean)
      return `[Resource ${block.uri} "${block.title ?? block.name}"${details.length ? ` (${details.join(', ')})` : ''}${block.description ? `: ${block.description}` : ''}]`
    }
    default:
      return `[Unsupported content: ${(block as { type: string }).type}]`
  }
}

/** The text the model sees for an MCP result. Without content blocks, the structured content as JSON (like pi-mcp). */
export function mcpResultText(
  server: string,
  tool: string,
  result: CallToolResult,
): string {
  const text =
    result.content.length > 0
      ? result.content.map(blockText).join('\n')
      : result.structuredContent === undefined
        ? ''
        : JSON.stringify(result.structuredContent, null, 2)
  if (result.isError && text.trim() === '')
    return `MCP tool ${server}/${tool} returned an error`
  return text
}

/**
 * The result for Vela: the text for the model, and the whole `CallToolResult` without `_meta` as
 * the native value (kept in tool history; what codemode scripts will receive). `isError` results
 * are error results for the model.
 */
export function convertMcpResult(
  server: string,
  tool: string,
  result: CallToolResult,
): ToolExecutionResult {
  const { _meta: _ignored, ...value } = result
  const text = mcpResultText(server, tool, result)
  return new ToolExecutionResult(
    value,
    text,
    result.isError ? { isError: true } : {},
  )
}

/**
 * Tool input schemas must be objects. Servers may omit `type`, and some providers reject object
 * schemas without `properties` (like pi).
 */
function toParameters(schema: McpTool['inputSchema']): Record<string, unknown> {
  return {
    ...schema,
    type: schema.type ?? 'object',
    ...(schema.properties === undefined ? { properties: {} } : {}),
  }
}

const ANNOTATION_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const

/** The boolean hints of an MCP tool's annotations, or undefined when it has none. */
function toAnnotations(tool: McpTool): ToolAnnotations | undefined {
  const annotations: ToolAnnotations = {}
  for (const hint of ANNOTATION_HINTS) {
    const value = tool.annotations?.[hint]
    if (typeof value === 'boolean') annotations[hint] = value
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined
}

/** What a tool needs from its server's connection. */
export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: {
      signal?: AbortSignal
      onProgress?: (progress: {
        progress: number
        total?: number
        message?: string
      }) => void
    },
  ): Promise<CallToolResult>
}

export function createMcpTool(options: {
  server: string
  tool: McpTool
  name: string
  exposure: McpExposure
  namespace: ToolNamespace
  caller: McpToolCaller
}): ToolDefinition {
  const { server, tool } = options
  const title = tool.title ?? tool.annotations?.title
  const annotations = toAnnotations(tool)
  return {
    name: options.name,
    description:
      tool.description?.trim() ||
      title ||
      `MCP tool ${tool.name} from server ${server}`,
    inputSchema: jsonSchema(toParameters(tool.inputSchema)),
    exposure: options.exposure,
    namespace: options.namespace,
    ...(annotations ? { annotations } : {}),
    maxResultChars: MCP_MAX_RESULT_CHARS,
    async execute(input: Record<string, unknown> | undefined, context) {
      const result = await options.caller.callTool(tool.name, input ?? {}, {
        signal: context?.signal,
        onProgress: (progress) => {
          const total = progress.total === undefined ? '' : `/${progress.total}`
          context?.onUpdate?.(
            progress.message ?? `Progress ${progress.progress}${total}`,
          )
        },
      })
      return convertMcpResult(server, tool.name, result)
    },
  }
}
