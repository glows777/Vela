import type { ProviderToolSpec } from '../../providers/index.ts'
import {
  type ToolInputSchema,
  toJsonSchema,
  toJsonSchemaSync,
} from '../../shared/tool-schema.ts'
import { estimateTextTokens } from '../messages.ts'
import { createToolSearchDocument, rankTools } from './tool-ranker.ts'
import type { ToolNamespace } from './types.ts'

interface RegistryTool {
  name: string
  description: string
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
  inputSchema: ToolInputSchema<any>
  hostedOnly?: true
  exposure?: string
  namespace?: ToolNamespace
  searchHint?: string
}

export async function matchDeferredTools<T extends RegistryTool>(
  loadable: T[],
  query: string,
  limit: number,
): Promise<T[]> {
  const names = query
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const exact = names.map((name) => loadable.find((t) => t.name === name))
  if (names.length > 0 && exact.every((tool) => tool !== undefined)) {
    return exact as T[]
  }
  const docs = await Promise.all(
    loadable.map(async (tool) =>
      createToolSearchDocument({
        ...tool,
        jsonSchema: await toJsonSchema(tool.inputSchema),
      }),
    ),
  )
  return rankTools(query, docs, limit).flatMap(
    (m) => loadable.find((t) => t.name === m.name) ?? [],
  )
}

export function toProviderTools<T extends RegistryTool>(
  tools: T[],
): ProviderToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    hostedOnly: tool.hostedOnly,
  }))
}

export function orderActiveTools<T extends RegistryTool>(
  all: T[],
  isAvailable: (name: string) => boolean,
  discovered: ReadonlySet<string>,
): T[] {
  const active: T[] = []
  const byName = new Map<string, T>()
  for (const tool of all) {
    if (!isAvailable(tool.name)) continue
    const exposure = tool.exposure ?? 'direct'
    if (exposure === 'deferred') {
      if (discovered.has(tool.name)) byName.set(tool.name, tool)
    } else if (exposure === 'direct' || exposure === 'model-only') {
      active.push(tool)
    }
  }
  for (const name of discovered) {
    const tool = byName.get(name)
    if (tool) active.push(tool)
  }
  return active
}

export function countToolTokens(tools: RegistryTool[], declared: Set<string>) {
  let active = 0,
    deferred = 0
  for (const tool of tools) {
    if (tool.exposure === 'hidden') continue
    const tokens = estimateTextTokens(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: toJsonSchemaSync(tool.inputSchema) ?? {},
      }),
    )
    if (declared.has(tool.name)) active += tokens
    else deferred += tokens
  }
  return { active, deferred, total: active + deferred }
}
