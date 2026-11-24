import type { ThinkingLevel } from '../../providers/models/index.ts'
import type { VelaLimits } from '../../shared/limits.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import {
  readLocalSystemFile,
  type SystemFile,
} from '../config/runtime-resources.ts'
import { abortable } from '../execution/location.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import type { ContextFile } from '../prompt/context-files.ts'
import type { PromptTemplate } from '../prompt/templates.ts'
import type { SkillDefinition } from '../skills/loader.ts'

/** Internal snapshot for Vela's own CLI. */
export interface SessionResources {
  systemPrompt?: string
  appendSystemPrompt?: string
  contextFiles: readonly ContextFile[]
  skills: readonly SkillDefinition[]
  promptTemplates: readonly PromptTemplate[]
  /** Pinned settings for CLI model cycling, not a model availability filter. */
  enabledModels?: readonly string[]
  defaultTools?: readonly string[]
}

/** Internal effective defaults after user/project/explicit-host precedence has been applied. */
export interface SessionDefaults {
  model?: ModelInput
  thinkingLevel?: ThinkingLevel
  limits?: Partial<VelaLimits>
  autoCompaction?: boolean
}

/** Assembly-only metadata; the public resource inventory does not expose configuration. */
export interface PreparedSessionResources extends SessionResources {
  defaults?: SessionDefaults
}

/** One load per location, shared by previews, commands and the session's first model request. */
export class WorkspaceResources {
  private readonly snapshots = new Map<string, PreparedSessionResources>()
  private readonly loading = new Map<
    string,
    {
      promise: Promise<void>
      controller: AbortController
      callers: number
    }
  >()

  constructor(private readonly host: PreparedSessionResources) {}

  get(id: string): PreparedSessionResources {
    return this.snapshots.get(id) ?? this.host
  }

  clear(id: string): void {
    this.snapshots.delete(id)
    this.loading.get(id)?.controller.abort()
    this.loading.delete(id)
  }

  async prepare(
    id: string,
    load: (signal: AbortSignal) => Promise<PreparedSessionResources>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (this.snapshots.has(id)) return
    let entry = this.loading.get(id)
    if (!entry) {
      const controller = new AbortController()
      const promise = load(controller.signal).then((resources) => {
        controller.signal.throwIfAborted()
        this.snapshots.set(id, resources)
      })
      entry = { promise, controller, callers: 0 }
      this.loading.set(id, entry)
    }
    entry.callers++
    try {
      await abortable(entry.promise, signal)
    } finally {
      if (--entry.callers === 0 && this.loading.get(id) === entry) {
        this.loading.delete(id)
        if (!this.snapshots.has(id)) entry.controller.abort()
      }
    }
  }
}

/** Each file independently overrides its user-level counterpart in a trusted workspace. */
export async function sessionSystemFile(
  env: ExecutionEnv,
  name: SystemFile,
  trusted: boolean,
  agentDir: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (trusted) {
    const path = await env.joinPath([env.cwd, '.vela', name], signal)
    if (!path.ok) throw path.error
    const file = await env.readTextFile(path.value, signal)
    if (file.ok) return file.value
    if (file.error.code !== 'not_found') throw file.error
  }
  if (agentDir) return readLocalSystemFile([agentDir], name)
}
