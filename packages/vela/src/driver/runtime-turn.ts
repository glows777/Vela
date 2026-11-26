import type { VelaDatabase } from '../db/index.ts'
import type { ResolvedModel } from '../providers/models/index.ts'
import type { DriverInboxItem, DriverTurnRequest } from '../runtime/driver.ts'
import type { BlobStore } from '../runtime/index.ts'
import type { MemoryStore } from '../runtime/memory/index.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { VelaEvent } from './agent/events.ts'
import type { ExecutionEnv } from './execution/types.ts'
import { type DreamScope, dreamKvKey, MemoryDream } from './memory/dream.ts'
import type { AssistantModelMessage, ModelMessage } from './messages.ts'
import {
  expandPromptTemplate,
  type PromptTemplate,
} from './prompt/templates.ts'
import {
  formatRuntimeMemoryContent,
  lastActiveCustomMessageText,
} from './runtime-resources.ts'
import type { SessionStore } from './session/index.ts'
import { expandEnvironmentSkill } from './skills/environment-skills.ts'
import type { SkillDefinition } from './skills/loader.ts'
import type { TokenTracker } from './usage/tracker.ts'

export function assistantText(msg: AssistantModelMessage | undefined): string {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

async function expandHumanText(
  text: string,
  skills: readonly SkillDefinition[] | undefined,
  promptTemplates: readonly PromptTemplate[] | undefined,
  resolveEnv: () => Promise<ExecutionEnv>,
  signal: AbortSignal,
): Promise<string> {
  if (skills?.length && text.startsWith('/skill:')) {
    const expanded = await expandEnvironmentSkill(
      text,
      skills,
      await resolveEnv(),
      signal,
    )
    if (expanded !== undefined) return expanded
  }
  if (promptTemplates?.length && text.startsWith('/')) {
    const expanded = expandPromptTemplate(text, promptTemplates)
    if (expanded !== undefined) return expanded
  }
  return text
}

async function formatInboxItemText(
  item: DriverInboxItem,
  options: {
    skills?: readonly SkillDefinition[]
    promptTemplates?: readonly PromptTemplate[]
    resolveEnv: () => Promise<ExecutionEnv>
    signal: AbortSignal
  },
): Promise<{ text: string; humanText?: string }> {
  const p = item.payload
  if (item.source === 'timer') {
    const kind = p.kind === 'followup' ? 'Follow-up timer' : 'Scheduled routine'
    return { text: `[${kind}] ${String(p.message ?? '')}` }
  }
  if (item.source === 'webhook') {
    const header = `[Event ${String(p.eventSource ?? 'webhook')}:${String(p.eventKey ?? '')}] ${String(p.summary ?? '')}`
    return { text: p.details ? `${header}\n${String(p.details)}` : header }
  }
  if (item.source === 'job') {
    return { text: String(p.text ?? '') }
  }
  if (item.source === 'approval' && p.waitForInput === true) {
    const reason =
      typeof p.reason === 'string' && p.reason.trim()
        ? p.reason.trim()
        : typeof p.comment === 'string' && p.comment.trim()
          ? p.comment.trim()
          : ''
    const decision =
      typeof p.decision === 'string' && p.decision.trim()
        ? p.decision.trim()
        : ''
    const combined =
      reason && decision && reason !== decision
        ? `[User decision: ${decision}]\n${reason}`
        : reason || decision
    return { text: combined, humanText: combined || undefined }
  }
  if (item.source === 'channel') {
    const sender = typeof p.senderName === 'string' ? p.senderName : 'User'
    if (item.passive) {
      return {
        text: `[Passive group message from ${sender}] ${String(p.text ?? '')}`,
      }
    }
    if (p.type === 'session_forward') {
      return { text: `${sender}: ${String(p.text ?? '')}` }
    }
    const rawBody = String(p.text ?? '')
    const body = await expandHumanText(
      rawBody,
      options.skills,
      options.promptTemplates,
      options.resolveEnv,
      options.signal,
    )
    return { text: `${sender}: ${body}`, humanText: `${sender}: ${rawBody}` }
  }
  if (item.source === 'user') {
    const rawBody = String(p.text ?? '')
    const expanded = await expandHumanText(
      rawBody,
      options.skills,
      options.promptTemplates,
      options.resolveEnv,
      options.signal,
    )
    return { text: expanded, humanText: rawBody || undefined }
  }
  if (!item.wake) {
    return { text: `[Background note] ${String(p.text ?? '')}` }
  }
  return { text: String(p.text ?? '') }
}

interface ExtractedInputMeta {
  replyToMessageId?: string
  handoffDepth?: number
  channelTarget?: { channel: string; externalChatId: string; threadId?: string }
  humanProvenance?: { inboxEventId: string; senderName?: string }
  attachments?: Array<{ blobId: string; name: string; mimeType?: string }>
}

function resolvePrimaryChannelRoute(inputs: readonly DriverInboxItem[]):
  | {
      channel: string
      externalChatId: string
      threadId?: string
    }
  | undefined {
  for (const requireWake of [true, false]) {
    for (let i = inputs.length - 1; i >= 0; i--) {
      const item = inputs[i]!
      const isRouteSource =
        item.source === 'channel' ||
        item.source === 'timer' ||
        (item.source === 'approval' && item.payload.waitForInput === true)
      if (!isRouteSource || item.passive) {
        continue
      }
      if (requireWake && !item.wake) continue
      const p = item.payload
      if (
        typeof p.channel === 'string' &&
        typeof p.externalChatId === 'string'
      ) {
        return {
          channel: p.channel,
          externalChatId: p.externalChatId,
          ...(typeof p.threadId === 'string' ? { threadId: p.threadId } : {}),
        }
      }
    }
  }
  return undefined
}

function extractInputMeta(
  inputs: readonly DriverInboxItem[],
): ExtractedInputMeta {
  const channelTarget = resolvePrimaryChannelRoute(inputs)
  let replyToMessageId: string | undefined
  let handoffDepth = 0
  let humanProvenance: { inboxEventId: string; senderName?: string } | undefined
  const attachments: Array<{
    blobId: string
    name: string
    mimeType?: string
  }> = []
  for (const item of inputs) {
    if (item.passive) continue
    const p = item.payload
    if (item.source === 'channel' && channelTarget) {
      if (
        p.channel !== channelTarget.channel ||
        p.externalChatId !== channelTarget.externalChatId ||
        (typeof p.threadId === 'string' ? p.threadId : undefined) !==
          channelTarget.threadId
      ) {
        continue
      }
    }
    if (typeof p.replyToMessageId === 'string') {
      replyToMessageId = p.replyToMessageId
    } else if (typeof p.messageId === 'string') {
      replyToMessageId = p.messageId
    }
    if (
      item.source === 'user' ||
      (item.source === 'channel' && p.type !== 'session_forward')
    ) {
      humanProvenance = {
        inboxEventId: item.id,
        ...(typeof p.senderName === 'string' && p.senderName
          ? { senderName: p.senderName }
          : {}),
      }
    }
    const depth = Number(p.depth ?? p.handoffDepth ?? 0)
    if (Number.isFinite(depth) && depth > handoffDepth) {
      handoffDepth = depth
    }
    if (Array.isArray(p.attachments)) {
      for (const att of p.attachments) {
        if (
          att &&
          typeof att === 'object' &&
          typeof (att as { blobId?: unknown }).blobId === 'string' &&
          typeof (att as { name?: unknown }).name === 'string'
        ) {
          attachments.push(
            att as { blobId: string; name: string; mimeType?: string },
          )
        }
      }
    }
  }
  return {
    replyToMessageId,
    handoffDepth,
    channelTarget,
    humanProvenance,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}

/** Resolves and persists originating turn metadata so approval/crash resumptions keep provenance, target, and attachments. */
export function resolveRunInputMeta(
  db: VelaDatabase,
  request: DriverTurnRequest,
): ExtractedInputMeta {
  const kvKey = `run_input_meta:${request.runId}`
  const savedRow = db.get<{ value_json: string }>(
    'SELECT value_json FROM kv_meta WHERE key = ?',
    kvKey,
  )
  let savedMeta: ExtractedInputMeta | undefined
  if (savedRow) {
    try {
      savedMeta = JSON.parse(savedRow.value_json) as ExtractedInputMeta
    } catch {
      savedMeta = undefined
    }
  }

  let baseMeta = extractInputMeta(request.inputs)
  const hasOnlyApprovalInputs =
    request.inputs.length > 0 &&
    request.inputs.every((item) => item.source === 'approval')
  if (!savedMeta && hasOnlyApprovalInputs) {
    const dbRows = db.all<{
      id: string
      source: string
      wake: number
      passive: number
      payload_json: string
      created_at: string
    }>(
      `SELECT id, source, wake, passive, payload_json, created_at FROM inbox_events
       WHERE session_id = ? AND run_id = ? AND source != 'approval'
       ORDER BY created_at ASC, rowid ASC`,
      request.sessionId,
      request.runId,
    )
    if (dbRows.length > 0) {
      const reconstructed: DriverInboxItem[] = dbRows.map((r) => ({
        id: r.id,
        source: r.source,
        wake: r.wake === 1,
        passive: r.passive === 1,
        payload: JSON.parse(r.payload_json) as Record<string, unknown>,
        createdAt: r.created_at,
      }))
      baseMeta = extractInputMeta(reconstructed)
    }
  }

  const merged: ExtractedInputMeta = {
    replyToMessageId: baseMeta.replyToMessageId ?? savedMeta?.replyToMessageId,
    handoffDepth: Math.max(
      baseMeta.handoffDepth ?? 0,
      savedMeta?.handoffDepth ?? 0,
    ),
    channelTarget: baseMeta.channelTarget ?? savedMeta?.channelTarget,
    humanProvenance: baseMeta.humanProvenance ?? savedMeta?.humanProvenance,
    attachments: baseMeta.attachments?.length
      ? baseMeta.attachments
      : savedMeta?.attachments,
  }
  if (
    !savedRow &&
    (merged.replyToMessageId ||
      merged.handoffDepth ||
      merged.channelTarget ||
      merged.humanProvenance ||
      merged.attachments?.length)
  ) {
    db.run(
      'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      kvKey,
      JSON.stringify(merged),
      new Date().toISOString(),
    )
  }
  return merged
}

/** Loads persisted silent disposition and handoff depth for a run (preserving them across approvals). */
export function resolveRunSilenceAndDepth(
  db: VelaDatabase,
  runId: string,
  initialHandoffDepth: number,
): {
  isSilent: boolean
  handoffDepth: number
  markSilent: () => void
} {
  const silentKvKey = `run_silent:${runId}`
  const depthKvKey = `run_handoff_depth:${runId}`
  const savedSilent = db.get<{ value_json: string }>(
    'SELECT value_json FROM kv_meta WHERE key = ?',
    silentKvKey,
  )
  let isSilent = false
  if (savedSilent) {
    try {
      isSilent = JSON.parse(savedSilent.value_json) === true
    } catch {
      isSilent = false
    }
  }
  let handoffDepth = initialHandoffDepth
  const savedDepth = db.get<{ value_json: string }>(
    'SELECT value_json FROM kv_meta WHERE key = ?',
    depthKvKey,
  )
  if (savedDepth) {
    try {
      const parsedDepth = Number(JSON.parse(savedDepth.value_json))
      if (Number.isFinite(parsedDepth) && parsedDepth > handoffDepth) {
        handoffDepth = parsedDepth
      }
    } catch {
      /* ignore malformed depth */
    }
  } else if (handoffDepth > 0) {
    db.run(
      'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      depthKvKey,
      JSON.stringify(handoffDepth),
      new Date().toISOString(),
    )
  }
  return {
    isSilent,
    handoffDepth,
    markSilent: () => {
      db.run(
        'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
        silentKvKey,
        'true',
        new Date().toISOString(),
      )
    },
  }
}

/** Commits pre-user `[memory]` custom message (if active/changed) and incoming turn user message. */
export async function prepareRuntimeTurnMessages(options: {
  db: VelaDatabase
  blobs: BlobStore
  store: SessionStore
  tracker: TokenTracker
  request: DriverTurnRequest
  messages: ModelMessage[]
  memoryActive: boolean
  memoryStores: {
    local: MemoryStore
    global: MemoryStore
    dirs: { isProject: boolean }
  }
  resolveEnv: () => Promise<ExecutionEnv>
  signal: AbortSignal
  skills?: readonly SkillDefinition[]
  promptTemplates?: readonly PromptTemplate[]
}): Promise<{ userEntryId?: string; hasHumanText: boolean }> {
  const {
    db,
    blobs,
    store,
    tracker,
    request,
    messages,
    memoryActive,
    memoryStores,
    resolveEnv,
    signal,
    skills,
    promptTemplates,
  } = options

  if (memoryActive) {
    const previousMemoryText = lastActiveCustomMessageText({
      db,
      sessionId: request.sessionId,
      messages,
      store,
      customType: 'memory',
    })
    const nextMemoryContent = formatRuntimeMemoryContent({
      local: memoryStores.local,
      global: memoryStores.global,
      isProject: memoryStores.dirs.isProject,
      hadPreviousMemoryMessage: previousMemoryText !== undefined,
    })
    if (
      nextMemoryContent !== null &&
      nextMemoryContent !== previousMemoryText
    ) {
      const memoryMsg: ModelMessage & { role: 'user' } = {
        role: 'user',
        content: nextMemoryContent,
      }
      store.runInTransaction(() => {
        const entry = store.appendCustomMessage(memoryMsg, {
          customType: 'memory',
          display: false,
        })
        request.onEvent({
          type: 'message_committed',
          runId: request.runId,
          messageId: entry.id,
          message: memoryMsg,
        })
      })
      messages.push(memoryMsg)
      tracker.addMessage(memoryMsg)
    }
  }

  const usableInputs = request.inputs.filter(
    (item) => item.source !== 'approval' || item.payload.waitForInput === true,
  )
  if (usableInputs.length === 0) return { hasHumanText: false }

  const lines: string[] = []
  const humanLines: string[] = []
  for (const item of usableInputs) {
    const formatted = await formatInboxItemText(item, {
      skills,
      promptTemplates,
      resolveEnv,
      signal,
    })
    let line = formatted.text
    const atts = item.payload.attachments as
      | Array<{ blobId: string; name: string }>
      | undefined
    if (atts?.length) {
      const env = await resolveEnv()
      const attachmentLines: string[] = []
      for (const att of atts) {
        const matPath = await blobs.materializeIntoEnv(
          att.blobId,
          env,
          request.sessionId,
          signal,
        )
        attachmentLines.push(`[file: ${att.name}, saved at ${matPath}]`)
      }
      line = line
        ? `${line}\n${attachmentLines.join('\n')}`
        : attachmentLines.join('\n')
    }
    if (line) lines.push(line)
    if (formatted.humanText) humanLines.push(formatted.humanText)
  }
  if (lines.length === 0) return { hasHumanText: false }

  const dreamHumanText = humanLines.join('\n\n')
  const userMsg: ModelMessage = {
    role: 'user',
    content: lines.join('\n\n'),
  }
  let userEntryId: string | undefined
  store.runInTransaction(() => {
    const entry = store.appendMessage(userMsg, {
      runId: request.runId,
      ...(dreamHumanText ? { details: { dreamHumanText } } : {}),
    })
    userEntryId = entry.id
    request.onEvent({
      type: 'message_committed',
      runId: request.runId,
      messageId: entry.id,
      message: userMsg,
    })
  })
  messages.push(userMsg)
  tracker.addMessage(userMsg)
  return { userEntryId, hasHumanText: Boolean(dreamHumanText) }
}

export function createRuntimeEventForwarder(
  request: DriverTurnRequest,
  onAssistantMessage: (message: AssistantModelMessage) => void,
): (event: VelaEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (inner.type === 'text_delta' || inner.type === 'thinking_delta') {
          request.onDelta({
            type: inner.type,
            sessionId: request.sessionId,
            runId: request.runId,
            contentIndex: inner.contentIndex,
            delta: inner.delta,
          })
        }
        break
      }
      case 'tool_execution_update': {
        const delta =
          typeof event.partialResult === 'string'
            ? event.partialResult
            : JSON.stringify(event.partialResult ?? '')
        request.onDelta({
          type: 'tool_output_delta',
          sessionId: request.sessionId,
          runId: request.runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          delta,
        })
        break
      }
      case 'tool_execution_start':
        request.onEvent({
          type: 'tool_started',
          runId: request.runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
        })
        break
      case 'tool_execution_end':
        request.onEvent({
          type: 'tool_finished',
          runId: request.runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          durationMs: event.durationMs,
          details: event.details,
        })
        break
      case 'approval_requested':
        request.onEvent({
          type: 'approval_requested',
          runId: request.runId,
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: event.summary,
          input: {},
        })
        break
      case 'message_end':
        if (event.message.role === 'assistant') {
          onAssistantMessage(event.message)
        }
        break
      case 'compaction_end':
        if (event.result) {
          request.onEvent({
            type: 'compaction_finished',
            runId: request.runId,
            reason: event.reason,
            tokensBefore: event.result.tokensBefore,
            tokensAfter: event.result.tokensAfter,
            messages: event.result.messages,
          })
        }
        break
    }
  }
}

function resolveRuntimeDream(options: {
  db: VelaDatabase
  activeDreams: Map<string, MemoryDream>
  localStore: MemoryStore
  projectId: string | null
}): MemoryDream {
  const dreamScope: DreamScope = options.projectId
    ? { kind: 'project', projectId: options.projectId }
    : { kind: 'global' }
  const key = dreamKvKey(dreamScope)
  let dream = options.activeDreams.get(key)
  if (!dream) {
    dream = new MemoryDream(options.localStore, options.db, dreamScope)
    options.activeDreams.set(key, dream)
  }
  return dream
}

export function recordRuntimeDreamTurn(options: {
  db: VelaDatabase
  activeDreams: Map<string, MemoryDream>
  localStore: MemoryStore
  projectId: string | null
  sessionId: string
  userEntryId?: string
  hasHumanText?: boolean
}): void {
  if (!options.hasHumanText || !options.userEntryId) return
  resolveRuntimeDream(options).recordMessages(options.sessionId, [
    { messageId: options.userEntryId, time: Date.now() },
  ])
}

export function scheduleRuntimeAutoDream(options: {
  db: VelaDatabase
  activeDreams: Map<string, MemoryDream>
  localStore: MemoryStore
  projectId: string | null
  sessionId: string
  dreamEnabled?: boolean
  resolved: ResolvedModel
  tracker: TokenTracker
  resolveEnv: () => Promise<ExecutionEnv>
  signal: AbortSignal
  logger: VelaLogger
}): void {
  const dream = resolveRuntimeDream(options)
  if (options.dreamEnabled === false || !dream.due()) return
  void dream
    .run({
      sessionId: options.sessionId,
      model: options.resolved.model,
      pricing: options.resolved.info.cost,
      checkPath: async (candidate) => {
        const env = await options.resolveEnv()
        const abs = await env.absolutePath(candidate, options.signal)
        if (!abs.ok) return false
        const exists = await env.exists(abs.value, options.signal)
        return exists.ok && exists.value
      },
      recordUsage: (modelId, usage, meta, pricing) =>
        options.tracker.record(modelId, usage, meta, pricing),
    })
    .catch((error) => {
      options.logger.warn(
        `[dream] ${error instanceof Error ? error.message : String(error)}`,
      )
    })
}
