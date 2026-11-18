import { abortable } from '../execution/location.ts'
import type { ContextFile } from '../prompt/context-files.ts'
import type { PromptTemplate } from '../prompt/templates.ts'
import type { SkillDefinition } from '../skills/loader.ts'

/** Internal snapshot for Vela's own CLI. */
export interface SessionResources {
  contextFiles: readonly ContextFile[]
  skills: readonly SkillDefinition[]
  promptTemplates: readonly PromptTemplate[]
}

/** One load per location, shared by previews, commands and the session's first model request. */
export class WorkspaceResources {
  private readonly snapshots = new Map<string, SessionResources>()
  private readonly loading = new Map<
    string,
    {
      promise: Promise<void>
      controller: AbortController
      callers: number
    }
  >()

  constructor(private readonly host: SessionResources) {}

  get(id: string): SessionResources {
    return this.snapshots.get(id) ?? this.host
  }

  clear(id: string): void {
    this.snapshots.delete(id)
    this.loading.get(id)?.controller.abort()
    this.loading.delete(id)
  }

  async prepare(
    id: string,
    load: (signal: AbortSignal) => Promise<SessionResources>,
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
