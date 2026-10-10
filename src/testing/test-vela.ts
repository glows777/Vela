import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import type { VelaEvent } from '../agent/events.ts'
import { memory } from '../extensions/memory/index.ts'
import type { EmbeddingFn } from '../extensions/rag/embedder.ts'
import { rag } from '../extensions/rag/index.ts'
import type { VelaExtension } from '../extensions/types.ts'
import type { VelaLimits } from '../limits.ts'
import type { VelaLogger } from '../logger.ts'
import type { ProviderDefinition, ThinkingLevel } from '../models/index.ts'
import { createVela, type Vela } from '../vela.ts'
import type {
  PromptOptions,
  SessionOptions,
  VelaSession,
} from '../vela-session.ts'
import {
  createFauxModel,
  type FauxModel,
  type FauxModelOptions,
  type FauxStep,
} from './faux.ts'
import { createFauxEmbedder } from './faux-embedder.ts'

export interface FixtureSkill {
  name: string
  description: string
  body: string
  /** `disable-model-invocation: true`: only `/skill:<name>` runs it */
  disableModelInvocation?: boolean
}

export interface TestVelaOptions {
  /** Main faux queue (streamText) */
  responses?: FauxStep[]
  /** Faux generate queue (generateText for summary compaction) */
  generate?: FauxStep[]
  /** Other faux options (chunkSize, cache, ...) */
  faux?: Omit<FauxModelOptions, 'responses' | 'generate'>
  /** Use this model instead of faux, or a `provider/id` (with `providers`); `t.model` is then unavailable */
  model?: LanguageModel | string
  /** Model providers, same as createVela's `providers` */
  providers?: Record<string, ProviderDefinition>
  /** Default thinking level for new sessions (default medium) */
  thinkingLevel?: ThinkingLevel
  /** Reuse an existing directory (e.g. to test session resume); a new temp directory if omitted */
  cwd?: string
  /** Data directory relative to cwd, default `.vela-data` (persistent: a new TestVela on the same cwd resumes sessions) */
  dataDir?: string
  /** Id of the default session (`t.session`), default 'default' */
  sessionId?: string
  /** Files to create in cwd: relative path → content */
  files?: Record<string, string>
  /** Skills to create in cwd/.skills (`<name>/SKILL.md`) */
  skills?: FixtureSkill[]
  /** Load the rag extension: true uses the deterministic faux embedder, or pass an embedder */
  embedder?: boolean | EmbeddingFn
  /** Limit overrides; tests default to retryBaseMs=0 so retries don't wait */
  limits?: Partial<VelaLimits>
  logger?: VelaLogger
  /** Per-extension config sections (`vela.config`), keyed by extension name */
  extensionConfig?: Record<string, Record<string, unknown>>
  /** Extensions to load (the ones under test), after the built-in memory (and rag, with embedder) */
  extensions?: VelaExtension[]
  /** Options for the default session (role, permissions, tool selection, ui) */
  session?: SessionOptions
  /** Skip checking on cleanup that the faux script was fully used */
  allowPendingResponses?: boolean
}

const live = new Set<{ cleanup(): Promise<void> }>()

/**
 * Assembles a Vela with the real createVela(), swapping in the faux model and a temp
 * cwd/data directory, and collects events from all sessions. `t.session` is the default
 * session; `t.run()` is `t.session.prompt()`. Extension authors can use it to test their
 * tools and hooks offline.
 */
export function createTestVela(options: TestVelaOptions = {}) {
  const ownsDir = !options.cwd
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'vela-test-'))
  for (const [path, content] of Object.entries(options.files ?? {}))
    writeFile(join(cwd, path), content)
  for (const skill of options.skills ?? []) writeSkill(cwd, skill)

  const faux = options.model
    ? undefined
    : createFauxModel({
        ...options.faux,
        responses: options.responses,
        generate: options.generate,
      })
  const embedder =
    options.embedder === true
      ? createFauxEmbedder()
      : options.embedder || undefined

  const vela: Vela = createVela({
    model: options.model ?? (faux as FauxModel),
    cwd,
    dataDir: options.dataDir ?? '.vela-data',
    providers: options.providers,
    thinkingLevel: options.thinkingLevel,
    limits: { retryBaseMs: 0, ...options.limits },
    logger: options.logger,
    extensionConfig: options.extensionConfig,
    // Include the built-in memory and knowledge-base extensions like the CLI (web tools need the network, so not here)
    extensions: [
      memory(),
      ...(embedder ? [rag({ embedder })] : []),
      ...(options.extensions ?? []),
    ],
  })
  const events: VelaEvent[] = []
  const sessionIds: string[] = []
  vela.subscribe((event, sessionId) => {
    events.push(event)
    sessionIds.push(sessionId)
  })
  const session: VelaSession = vela.session(
    options.sessionId ?? 'default',
    options.session,
  )

  const t = {
    vela,
    session,
    cwd,
    dataDir: vela.dataDir,
    /** Events from all sessions, in order */
    events,
    get model(): FauxModel {
      if (!faux) throw new Error('createTestVela: a custom model was passed')
      return faux
    },
    get messages(): ModelMessage[] {
      return session.messages
    },

    /** Runs one turn in the default session */
    run: (input: string, runOptions?: PromptOptions) =>
      session.prompt(input, runOptions),
    tracker: () => session.tracker,

    /** Sequence of event types, for asserting on flow */
    eventTypes: (): VelaEvent['type'][] => events.map((e) => e.type),
    eventsOf: <T extends VelaEvent['type']>(type: T) =>
      events.filter(
        (e): e is Extract<VelaEvent, { type: T }> => e.type === type,
      ),
    /** Events of one session */
    eventsIn: (sessionId: string): VelaEvent[] =>
      events.filter((_, i) => sessionIds[i] === sessionId),
    clearEvents: () => {
      events.length = 0
      sessionIds.length = 0
    },
    /** All streamed text (message_update text_delta) joined */
    streamedText: () =>
      events
        .flatMap((e) =>
          e.type === 'message_update' &&
          e.assistantMessageEvent.type === 'text_delta'
            ? [e.assistantMessageEvent.delta]
            : [],
        )
        .join(''),
    /** Text of the default session's last assistant message */
    lastAssistantText: () => lastAssistantText(session.messages),

    path: (relative: string) => join(cwd, relative),
    dataPath: (relative: string) => join(vela.dataDir, relative),
    exists: (relative: string) => existsSync(join(vela.dataDir, relative)),
    readData: (relative: string) =>
      readFile(join(vela.dataDir, relative), 'utf8'),
    readFile: (relative: string) => readFile(join(cwd, relative), 'utf8'),
    writeFile: (relative: string, content: string) =>
      writeFile(join(cwd, relative), content),

    /** Disposes and removes the temp directory it created; by default checks the faux script was fully used */
    async cleanup({ keepDir = false } = {}) {
      live.delete(t)
      await vela.dispose()
      if (ownsDir && !keepDir) rmSync(cwd, { recursive: true, force: true })
      if (faux && !options.allowPendingResponses && faux.pending() > 0)
        throw new Error(
          `faux script has ${faux.pending()} unused response(s) after ${faux.calls.length} request(s)`,
        )
    },
  }
  live.add(t)
  return t
}

export type TestVela = ReturnType<typeof createTestVela>

/** Call in afterEach: cleans up any TestVela not yet cleaned up. */
export async function cleanupTestVelas(): Promise<void> {
  const errors: unknown[] = []
  for (const t of [...live]) await t.cleanup().catch((e) => errors.push(e))
  if (errors.length) throw errors[0]
}

/** Creates a temp directory not owned by a TestVela, for tests where several Velas share a directory */
export function tempDir(prefix = 'vela-test-'): {
  path: string
  cleanup(): void
} {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

export function lastAssistantText(messages: readonly ModelMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function writeSkill(cwd: string, skill: FixtureSkill) {
  const meta = [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
  ]
  if (skill.disableModelInvocation) meta.push('disable-model-invocation: true')
  writeFile(
    join(cwd, '.skills', skill.name, 'SKILL.md'),
    `${meta.join('\n')}\n---\n\n${skill.body}\n`,
  )
}
