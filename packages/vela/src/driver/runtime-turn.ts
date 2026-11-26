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
    const formatted = `${sender}: ${body}`
    return { text: formatted, humanText: formatted }
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
    return { text: expanded, humanText: expanded || undefined }
  }
  if (!item.wake) {
    return { text: `[Background note] ${String(p.text ?? '')}` }
  }
  return { text: String(p.text ?? '') }
}

export function extractInputMeta(inputs: readonly DriverInboxItem[]): {
  replyToMessageId?: string
  handoffDepth?: number
  humanProvenance?: { inboxEventId: string; senderName?: string }
  attachments?: Array<{ blobId: string; name: string; mimeType?: string }>
} {
  let replyToMessageId: string | undefined
  let handoffDepth = 0
  let humanProvenance: { inboxEventId: string; senderName?: string } | undefined
  const attachments: Array<{
    blobId: string
    name: string
    mimeType?: string
  }> = []
  for (const item of inputs) {
    const p = item.payload
    if (typeof p.replyToMessageId === 'string') {
      replyToMessageId = p.replyToMessageId
    } else if (typeof p.messageId === 'string') {
      replyToMessageId = p.messageId
    }
    if (
      item.source === 'user' ||
      (item.source === 'channel' &&
        !item.passive &&
        p.type !== 'session_forward')
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
    humanProvenance,
    attachments: attachments.length > 0 ? attachments : undefined,
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

export function scheduleRuntimeAutoDream(options: {
  db: VelaDatabase
  activeDreams: Map<string, MemoryDream>
  localStore: MemoryStore
  projectId: string | null
  sessionId: string
  userEntryId?: string
  hasHumanText?: boolean
  dreamEnabled?: boolean
  resolved: ResolvedModel
  tracker: TokenTracker
  logger: VelaLogger
}): void {
  const dreamScope: DreamScope = options.projectId
    ? { kind: 'project', projectId: options.projectId }
    : { kind: 'global' }
  const key = dreamKvKey(dreamScope)
  let dream = options.activeDreams.get(key)
  if (!dream) {
    dream = new MemoryDream(options.localStore, options.db, dreamScope)
    options.activeDreams.set(key, dream)
  }
  if (options.hasHumanText && options.userEntryId) {
    dream.recordMessages(options.sessionId, [
      { messageId: options.userEntryId, time: Date.now() },
    ])
  }
  if (options.dreamEnabled === false || !dream.due()) return
  void dream
    .run({
      sessionId: options.sessionId,
      model: options.resolved.model,
      pricing: options.resolved.info.cost,
      recordUsage: (modelId, usage, meta, pricing) =>
        options.tracker.record(modelId, usage, meta, pricing),
    })
    .catch((error) => {
      options.logger.warn(
        `[dream] ${error instanceof Error ? error.message : String(error)}`,
      )
    })
}
