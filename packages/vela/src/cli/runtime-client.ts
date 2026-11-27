import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { connectRuntime } from '../daemon/index.ts'
import { canonicalLocalPath } from '../db/trust.ts'
import type { ImageContent } from '../driver/index.ts'
import type { RuntimeSessionOverride } from '../driver/runtime-types.ts'
import type { ModelInfo, ThinkingLevel } from '../providers/models/index.ts'
import type {
  RuntimeEvent,
  RuntimeSessionInspection,
  VelaRuntime,
} from '../runtime-sdk-types.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { CliArgs } from './setup.ts'

const TRANSIENT_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_BASE_URL',
  'OPENAI_API_MODEL_NAME',
  'VELA_OFFLINE',
] as const

function readPromptInput(input: string): string {
  return existsSync(input) && statSync(input).isFile()
    ? readFileSync(input, 'utf-8')
    : input
}

export function pickTransientEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const overlayEnv: Record<string, string> = {}
  for (const key of TRANSIENT_ENV_KEYS) {
    const val = env[key]
    if (val !== undefined && val !== '') overlayEnv[key] = val
  }
  return overlayEnv
}

/** Looks up or creates the owner-DB project entry matching `cwd` so CLI sessions isolate project memory. */
export async function ensureCliProject(
  runtime: VelaRuntime,
  cwd: string,
): Promise<string> {
  const canonicalCwd = canonicalLocalPath(cwd)
  const existing =
    (await runtime.projects.getByCwd(cwd)) ??
    (canonicalCwd !== cwd
      ? await runtime.projects.getByCwd(canonicalCwd)
      : undefined)
  if (existing) return existing.id
  const name = basename(canonicalCwd) || 'project'
  const created = await runtime.projects.create({ name, cwd })
  return created.id
}

/**
 * Extracts per-session transient env overlay and CLI flags passed to `runtime.sessions.configure()`
 * without mutating resident daemon state or `vela.db`.
 */
export function buildCliSessionOverride(
  args: CliArgs,
  env: Record<string, string | undefined>,
  cwd: string,
  trusted?: boolean,
): RuntimeSessionOverride {
  const overlayEnv = pickTransientEnv(env)
  const rawModel =
    args.model ??
    (env.VELA_MODEL === 'mock' || env.VELA_MODEL?.startsWith('faux:')
      ? env.VELA_MODEL
      : undefined)
  const explicitModel = rawModel?.startsWith('faux:')
    ? `faux:${resolve(cwd, rawModel.slice('faux:'.length))}`
    : rawModel
  const resolvedApprove =
    trusted !== undefined
      ? trusted
      : args.approve !== undefined
        ? args.approve
        : undefined
  const resolvedExtensions = args.extensions.map((ext) =>
    /^[+-]?builtin:/.test(ext) ? ext : resolve(cwd, ext),
  )
  return {
    cwd,
    ...(Object.keys(overlayEnv).length > 0 ? { env: overlayEnv } : {}),
    ...(explicitModel !== undefined
      ? { model: explicitModel }
      : env.OPENAI_API_MODEL_NAME
        ? { model: `openai/${env.OPENAI_API_MODEL_NAME}` }
        : {}),
    ...(args.thinking ? { thinkingLevel: args.thinking } : {}),
    ...(args.tools ? { tools: args.tools } : {}),
    ...(args.noTools ? { noTools: true } : {}),
    ...(args.excludeTools.length ? { excludeTools: args.excludeTools } : {}),
    ...(args.systemPrompt.length
      ? { systemPrompt: args.systemPrompt.map(readPromptInput).join('\n\n') }
      : {}),
    ...(args.appendSystemPrompt.length
      ? {
          appendSystemPrompt: args.appendSystemPrompt
            .map(readPromptInput)
            .join('\n\n'),
        }
      : {}),
    ...(args.noContextFiles
      ? { noContextFiles: true }
      : { loadUntrustedContextFiles: true }),
    ...(resolvedApprove !== undefined
      ? { approve: resolvedApprove, approveLocation: resolve(cwd) }
      : {}),
    ...(resolvedExtensions.length ? { extensions: resolvedExtensions } : {}),
    ...(args.noExtensions ? { noExtensions: true } : {}),
    ...(env.VELA_RECORD ? { recordPath: resolve(cwd, env.VELA_RECORD) } : {}),
  }
}

/** Opens either an isolated ephemeral runtime (`--no-session`) or connects to the resident daemon (`connectRuntime`). */
export async function openCliRuntime(options: {
  agentDir: string
  hostEnv: Record<string, string | undefined>
  noSession?: boolean
  logger?: VelaLogger
}): Promise<VelaRuntime> {
  if (options.noSession) {
    const { createRuntime } = await import('../runtime-sdk.ts')
    return createRuntime({
      agentDir: options.agentDir,
      ephemeralSessions: true,
      hostEnv: options.hostEnv,
      logger: options.logger,
    })
  }
  return connectRuntime({
    agentDir: options.agentDir,
    hostEnv: options.hostEnv,
  })
}

/**
 * Thin CLI wrapper over one session on `VelaRuntime`, caching the latest `inspect()` snapshot
 * and routing prompt / command / control calls over IPC or in-process RPC.
 */
export class CliSessionClient {
  private _snapshot?: RuntimeSessionInspection
  private _isRunning = false
  private _isBashRunning = false
  private readonly unsubEvents: () => void

  constructor(
    readonly runtime: VelaRuntime,
    readonly id: string,
    initialSnapshot?: RuntimeSessionInspection,
    readonly modelEnv?: Record<string, string>,
  ) {
    this._snapshot = initialSnapshot
    this._isRunning = initialSnapshot?.isRunning ?? false
    this._isBashRunning = initialSnapshot?.isBashRunning ?? false
    this.unsubEvents = runtime.events.subscribe((event: RuntimeEvent) => {
      if (event.sessionId !== this.id) return
      if (event.type === 'run_started') {
        this._isRunning = true
      } else if (event.type === 'run_finished') {
        this._isRunning = false
      }
    })
  }

  get snapshot(): RuntimeSessionInspection | undefined {
    return this._snapshot
  }

  get cwd(): string {
    return this._snapshot?.cwd ?? process.cwd()
  }

  get name(): string | undefined {
    return this._snapshot?.name
  }

  get channel(): string | undefined {
    return this._snapshot?.channel
  }

  get parentSession(): string | undefined {
    return this._snapshot?.parentSession
  }

  get modelInfo(): ModelInfo | undefined {
    return this._snapshot?.modelInfo
  }

  get thinkingLevel(): ThinkingLevel {
    return this._snapshot?.thinkingLevel ?? 'medium'
  }

  get availableThinkingLevels(): ThinkingLevel[] {
    return (
      this._snapshot?.availableThinkingLevels ?? [
        'off',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
      ]
    )
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  get isBashRunning(): boolean {
    return this._isBashRunning
  }

  async refresh(options?: {
    previewPrompt?: boolean
    includeEntries?: boolean
  }): Promise<RuntimeSessionInspection> {
    const snap = await this.runtime.sessions.inspect(this.id, {
      ...options,
      includeEntries: options?.includeEntries ?? false,
    })
    this._snapshot = snap
    this._isRunning = snap.isRunning
    this._isBashRunning = snap.isBashRunning
    return snap
  }

  async configure(override: RuntimeSessionOverride): Promise<void> {
    await this.runtime.sessions.configure(this.id, override)
  }

  async prompt(
    text: string,
    options?: { images?: ImageContent[]; steer?: boolean },
  ): Promise<{ handledCommand?: boolean; eventId?: string }> {
    const trimmed = text.trim()
    if (trimmed.startsWith('/')) {
      const cmd = await this.runtime.sessions.runCommand(this.id, trimmed)
      if (cmd.handled) return { handledCommand: true }
    }
    if (options?.steer && this._isRunning) {
      await this.runtime.steer(this.id, text)
      return {}
    }
    const attachments: Array<{
      blobId: string
      name: string
      mimeType?: string
      inlineOnly?: boolean
    }> = []
    if (options?.images?.length) {
      for (let i = 0; i < options.images.length; i++) {
        const img = options.images[i]!
        const bytes = new Uint8Array(Buffer.from(img.data, 'base64'))
        const ext = img.mimeType.split('/')[1] || 'png'
        const blob = await this.runtime.blobs.storeInbound({
          sessionId: this.id,
          filename: `attachment-${i + 1}.${ext}`,
          mimeType: img.mimeType,
          bytes,
        })
        attachments.push({
          blobId: blob.id,
          name: blob.filename,
          mimeType: blob.mimeType ?? undefined,
          inlineOnly: true,
        })
      }
    }
    const res = await this.runtime.prompt(this.id, {
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    return { eventId: res.eventId }
  }

  async waitForSettled(): Promise<void> {
    for (;;) {
      await this.runtime.waitForIdle(this.id)
      const [jobs, status] = await Promise.all([
        this.runtime.jobs.list(this.id),
        this.runtime.sessions.status(this.id).catch(() => undefined),
      ])
      const runningJob = jobs.some((j) => j.snapshot.state === 'running')
      const activeRun =
        status !== undefined &&
        (status.session.state === 'running' || status.activeRunId !== null)
      if (!runningJob && !activeRun) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        await this.runtime.waitForIdle(this.id)
        const [jobsAfter, statusAfter] = await Promise.all([
          this.runtime.jobs.list(this.id),
          this.runtime.sessions.status(this.id).catch(() => undefined),
        ])
        const stillRunningJob = jobsAfter.some(
          (j) => j.snapshot.state === 'running',
        )
        const stillActiveRun =
          statusAfter !== undefined &&
          (statusAfter.session.state === 'running' ||
            statusAfter.activeRunId !== null)
        if (!stillRunningJob && !stillActiveRun) return
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }

  async setModel(ref: string): Promise<ModelInfo> {
    const info = await this.runtime.sessions.setModel(this.id, ref)
    await this.refresh()
    return info
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const next = await this.runtime.sessions.setThinkingLevel(this.id, level)
    await this.refresh()
    return next
  }

  async rename(name: string | null): Promise<void> {
    await this.runtime.sessions.rename(this.id, name)
    await this.refresh()
  }

  async execBash(
    command: string,
    options?: { excludeFromContext?: boolean; id?: string },
  ) {
    this._isBashRunning = true
    try {
      const res = await this.runtime.sessions.execBash(this.id, command, {
        ...options,
        id: options?.id ?? randomUUID(),
      })
      await this.refresh().catch(() => {})
      return res
    } finally {
      this._isBashRunning = false
    }
  }

  dispose(): void {
    this.unsubEvents()
  }
}
