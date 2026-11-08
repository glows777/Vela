import { randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { writeAtomicJson } from './atomic-json.ts'
import type { LocalMessage, LocalProject } from './local-protocol.ts'
import { channelSessionId } from './session-id.ts'

const projectSchema = z
  .object({
    id: z.uuid(),
    cwd: z.string().refine(isAbsolute, 'Project cwd must be absolute'),
    name: z.string(),
    sessionId: z.string().min(1),
    channel: z.literal('local'),
  })
  .strict()
  .refine(
    (project) => project.sessionId === channelSessionId('local', project.id),
    'Invalid local session identity',
  )
const messageSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.string().min(1),
    role: z.enum(['user', 'assistant', 'system']),
    text: z.string(),
    createdAt: z.iso.datetime(),
    clientMessageId: z.string().optional(),
  })
  .strict()
const registrySchema = z
  .object({
    version: z.literal(1),
    deploymentId: z.uuid(),
    projects: z.array(projectSchema),
  })
  .strict()

/** Visible Local history only; the core session transcript remains separate. */
export class LocalStore {
  private readonly directory: string
  private readonly registryPath: string
  private identity?: string
  private records: LocalProject[] = []
  private logs = new Map<string, LocalMessage[]>()
  private loading?: Promise<void>
  private writing: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'local')
    this.registryPath = join(this.directory, 'projects.json')
  }

  get deploymentId(): string {
    if (!this.identity) throw new Error('Local store is not loaded')
    return this.identity
  }

  load(): Promise<void> {
    this.loading ??= this.read()
    return this.loading
  }

  private async read(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.registryPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const files = await readdir(this.directory).catch(
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return []
          throw cause
        },
      )
      if (files.length)
        throw new Error('Missing Local registry in nonempty storage')
      const deploymentId = randomUUID()
      await writeAtomicJson(this.registryPath, {
        version: 1,
        deploymentId,
        projects: [],
      })
      this.identity = deploymentId
      return
    }
    const registry = registrySchema.parse(JSON.parse(text))
    if (
      new Set(registry.projects.map((project) => project.id)).size !==
        registry.projects.length ||
      new Set(registry.projects.map((project) => project.cwd)).size !==
        registry.projects.length
    )
      throw new Error('Duplicate Local project identity')
    const logs = new Map<string, LocalMessage[]>()
    for (const project of registry.projects) {
      const messages = z
        .array(messageSchema)
        .parse(JSON.parse(await readFile(this.logPath(project.id), 'utf8')))
      if (
        new Set(messages.map((message) => message.id)).size !== messages.length
      )
        throw new Error('Duplicate Local message identity')
      logs.set(project.id, messages)
    }
    this.identity = registry.deploymentId
    this.records = registry.projects
    this.logs = logs
  }

  projects(): LocalProject[] {
    return structuredClone(this.records)
  }

  project(id: string): LocalProject | undefined {
    return structuredClone(this.records.find((project) => project.id === id))
  }

  messages(projectId: string, sessionId: string): LocalMessage[] {
    return structuredClone(
      (this.logs.get(projectId) ?? []).filter(
        (message) => message.sessionId === sessionId,
      ),
    )
  }

  async openProject(cwd: string, name?: string): Promise<LocalProject> {
    await this.load()
    const canonical = await realpath(cwd)
    if (!(await stat(canonical)).isDirectory())
      throw new Error('Local project cwd must be a directory')
    return this.change(async () => {
      const existing = this.records.find((project) => project.cwd === canonical)
      if (existing) return structuredClone(existing)
      const id = randomUUID()
      const project: LocalProject = {
        id,
        cwd: canonical,
        name: name ?? basename(canonical),
        sessionId: channelSessionId('local', id),
        channel: 'local',
      }
      const projects = [...this.records, project]
      await writeAtomicJson(this.logPath(id), [])
      await writeAtomicJson(this.registryPath, {
        version: 1,
        deploymentId: this.deploymentId,
        projects,
      })
      this.records = projects
      this.logs.set(id, [])
      return structuredClone(project)
    })
  }

  async append(
    projectId: string,
    input: Omit<LocalMessage, 'id' | 'createdAt'>,
  ): Promise<LocalMessage> {
    await this.load()
    const message = messageSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    return this.change(async () => {
      const previous = this.requireLog(projectId)
      const next = [...previous, message]
      await writeAtomicJson(this.logPath(projectId), next)
      this.logs.set(projectId, next)
      return structuredClone(message)
    })
  }

  async remove(projectId: string, messageId: string): Promise<void> {
    await this.load()
    return this.change(async () => {
      const previous = this.requireLog(projectId)
      const next = previous.filter((message) => message.id !== messageId)
      if (next.length === previous.length) return
      await writeAtomicJson(this.logPath(projectId), next)
      this.logs.set(projectId, next)
    })
  }

  private requireLog(projectId: string): LocalMessage[] {
    const log = this.logs.get(projectId)
    if (!log) throw new Error('Unknown Local project')
    return log
  }

  private logPath(id: string): string {
    return join(this.directory, `${z.uuid().parse(id)}.json`)
  }

  private change<T>(mutate: () => Promise<T>): Promise<T> {
    const next = this.writing.catch(() => {}).then(mutate)
    this.writing = next
    return next
  }
}
