import { withProviderHooks } from '../providers/index.ts'
import type { DriverInboxItem, DriverTurnRequest } from '../runtime/driver.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type {
  ExtensionRunner,
  RuntimeExtensionSession,
} from './extensions/runner.ts'
import type { ExtensionSession } from './extensions/types.ts'
import { type ModelMessage, normalizeUserMessage } from './messages.ts'
import type { PreparedSessionEnv } from './runtime-session-setup.ts'
import type { VelaAgentDriverOptions } from './runtime-types.ts'
import type { SessionStore } from './session/index.ts'
import type { ToolRegistry } from './tools/registry.ts'
import type { TokenTracker } from './usage/tracker.ts'

/** Configures tool interception with MCP discovery readiness, extension `tool_call`/`tool_result` hooks, and approvals. */
export function wireRuntimeToolInterception(params: {
  registry: ToolRegistry
  prepared: PreparedSessionEnv
  extensionRunner: ExtensionRunner
  extView: ExtensionSession
  sessionId: string
  signal: AbortSignal
  toolApprovalCheck?: VelaAgentDriverOptions['toolApprovalCheck']
}): void {
  const {
    registry,
    prepared,
    extensionRunner,
    extView,
    sessionId,
    signal,
    toolApprovalCheck,
  } = params

  registry.setInterception({
    resolveEnv: () => prepared.resolveEnv(),
    before: async (toolName, input, ctx) => {
      if (toolName === 'tool_search' && prepared.mcpLease) {
        await prepared.mcpLease.waitForAll(signal)
      }
      let nextInput = input
      let approval: { required: true; summary: string } | undefined
      if (extensionRunner.hasHandlers('tool_call', toolName)) {
        const extDecision = await extensionRunner.toolCall(
          extView,
          ctx.toolCallId,
          toolName,
          nextInput,
        )
        if (extDecision.block) {
          return {
            input: extDecision.input,
            block: true,
            reason: extDecision.reason,
          }
        }
        nextInput = extDecision.input
        if (extDecision.approval) {
          approval = {
            required: true,
            summary: extDecision.approval.summary,
          }
        }
      }
      if (!approval && toolApprovalCheck) {
        const decision = await toolApprovalCheck(
          toolName,
          nextInput,
          ctx.sessionId ?? sessionId,
        )
        if (decision?.requireApproval) {
          approval = {
            required: true,
            summary: decision.summary ?? `Approve ${toolName} execution`,
          }
        }
      }
      return {
        input: nextInput,
        ...(approval ? { approval } : {}),
      }
    },
    after: async (toolName, input, output, ctx, isError) => {
      if (!extensionRunner.hasHandlers('tool_result', toolName)) {
        return output
      }
      return extensionRunner.toolResult(
        extView,
        ctx.toolCallId,
        toolName,
        input,
        output,
        isError,
      )
    },
  })
}

/** Runs `input` extension hooks against user inbox inputs, returning `handled: true` if every input was consumed. */
export async function applyInputExtensionHooks(params: {
  extensionRunner: ExtensionRunner
  extView: ExtensionSession
  request: DriverTurnRequest
}): Promise<{ request: DriverTurnRequest; handledAll: boolean }> {
  const { extensionRunner, extView, request } = params
  if (!extensionRunner.hasHandlers('input')) {
    return { request, handledAll: false }
  }
  const filteredInputs: DriverInboxItem[] = []
  let changed = false
  for (const item of request.inputs) {
    if (item.source === 'user' && typeof item.payload.text === 'string') {
      changed = true
      const res = await extensionRunner.input(
        extView,
        item.payload.text,
        'interactive',
      )
      if (!res) continue
      filteredInputs.push({
        ...item,
        payload: { ...item.payload, text: res.text },
      })
    } else {
      filteredInputs.push(item)
    }
  }
  if (!changed) {
    return { request, handledAll: false }
  }
  return {
    request: { ...request, inputs: filteredInputs },
    handledAll: filteredInputs.length === 0,
  }
}

/** Runs `before_agent_start` extension hooks, updating prompt sections/overrides and committing custom messages. */
export async function applyBeforeAgentStartHooks(params: {
  extensionRunner: ExtensionRunner
  extView: RuntimeExtensionSession
  prepared: PreparedSessionEnv
  request: DriverTurnRequest
  activeStore: SessionStore
  messages: ModelMessage[]
  tracker: TokenTracker
  alreadyHasRunMessages: boolean
}): Promise<{
  systemPrompt?: string
  sections?: Record<string, string>
}> {
  const {
    extensionRunner,
    extView,
    request,
    activeStore,
    messages,
    tracker,
    alreadyHasRunMessages,
  } = params
  if (!extensionRunner.hasHandlers('before_agent_start')) {
    return {}
  }
  const hookInputText = request.inputs
    .map((i) => (typeof i.payload.text === 'string' ? i.payload.text : ''))
    .filter(Boolean)
    .join('\n\n')
  const started = await extensionRunner.beforeAgentStart(extView, hookInputText)
  if (!alreadyHasRunMessages && started.messages.length > 0) {
    for (const cm of started.messages) {
      const msg = (await normalizeUserMessage({
        role: 'user',
        content: cm.content,
      })) as ModelMessage & { role: 'user' }
      activeStore.runInTransaction(() => {
        const entry = activeStore.appendCustomMessage(msg, {
          customType: cm.customType,
          display: cm.display === true,
          details: cm.details,
        })
        request.onEvent({
          type: 'message_committed',
          runId: request.runId,
          messageId: entry.id,
          message: msg,
          customType: cm.customType,
          display: cm.display === true,
        })
      })
      messages.push(msg)
      tracker.addMessage(msg)
    }
  }
  return {
    ...(started.systemPrompt !== undefined
      ? { systemPrompt: started.systemPrompt }
      : {}),
    ...(Object.keys(started.sections).length > 0
      ? { sections: started.sections }
      : {}),
  }
}

/** Wraps the resolved model with `before_provider_request`/`after_provider_response`/`provider_stream_event` hooks when needed. */
export function wrapModelWithExtensionHooks(
  model: ModelInput,
  extensionRunner: ExtensionRunner,
  extView: ExtensionSession,
): ModelInput {
  const hasProviderHooks =
    extensionRunner.hasHandlers('before_provider_request') ||
    extensionRunner.hasHandlers('after_provider_response') ||
    extensionRunner.hasHandlers('provider_stream_event')
  if (!hasProviderHooks) return model
  return withProviderHooks(model, {
    has: (event, toolName, opts) =>
      extensionRunner.hasHandlers(event, toolName, opts),
    beforeRequest: (hookParams) =>
      extensionRunner.beforeProviderRequest(extView, hookParams),
    afterResponse: (headers) =>
      extensionRunner.afterProviderResponse(extView, headers),
    streamEvent: (event) =>
      extensionRunner.providerStreamEvent(extView, {
        type: 'provider_stream_event',
        ...event,
      }),
  })
}
