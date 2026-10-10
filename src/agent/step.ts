import {
  type AssistantContent,
  type AssistantModelMessage,
  type FinishReason,
  type ModelMessage,
  type ProviderMetadata,
  parsePartialJson,
  type ToolCallPart,
  type ToolModelMessage,
  type ToolResultPart,
} from 'ai'
import type { AssistantMessageEvent, StopReason, VelaEvent } from './events.ts'

/** The assistant parts Vela streams */
type ContentPart = Extract<
  Exclude<AssistantContent, string>[number],
  { type: 'text' | 'reasoning' | 'tool-call' }
>

/** Result text for tool calls that did not finish because the run was aborted (pi's wording). */
export const ABORTED_RESULT = 'Operation aborted'

/** Result text for tool calls in a response cut off by the output token limit (pi's wording). */
export const truncatedToolCallResult = (toolName: string) =>
  `Tool call "${toolName}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`

/** Result text for tool calls that never ran because the response failed. */
export const failedToolCallResult = (errorMessage: string) =>
  `Tool call was not executed: the response failed (${errorMessage}).`

/** AI SDK only runs tools when the model stopped normally (`stop` / `tool-calls`). */
export const executesTools = (finishReason: FinishReason) =>
  finishReason === 'stop' || finishReason === 'tool-calls'

export const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * One model request's assistant message as it streams, turned into pi-shaped events:
 * `message_start`, `message_update`s, `message_end`, then `tool_execution_start / end` for its tool calls.
 * Also builds the message to keep when the request is aborted or fails before the AI SDK produced its own.
 */
export class StepMessage {
  private readonly content: ContentPart[] = []
  private readonly byStreamId = new Map<string, number>()
  private readonly rawToolInput = new Map<string, string>()
  /** Tool calls the model finished writing, in order */
  readonly toolCalls: ToolCallPart[] = []
  /** Tool calls that got a result or an error, by id */
  readonly results = new Map<string, ToolResultPart>()
  private readonly executionStarted = new Map<string, number>()
  private started = false
  /** message_end was emitted */
  ended = false
  /** The model finished this message normally (not aborted or failed midway) */
  complete = false
  /** The model finished (from the AI SDK's model-call-end callback): its finish reason and tool call ids */
  modelEnd: { finishReason: FinishReason; toolCallIds: string[] } | undefined

  constructor(private readonly emit: (event: VelaEvent) => void) {}

  /** A copy of the message so far. */
  snapshot(options: { complete?: boolean } = {}): AssistantModelMessage {
    const complete = options.complete ?? true
    const finished = new Set(this.toolCalls.map((call) => call.toolCallId))
    const content = this.content
      .filter((part) =>
        complete
          ? true
          : // An interrupted message keeps its text and whole tool calls; half-written reasoning (its signature is
            // incomplete) and tool calls are dropped, like pi drops the whole message
            part.type === 'text' ||
            (part.type === 'tool-call' && finished.has(part.toolCallId)),
      )
      .filter((part) => part.type !== 'text' || part.text !== '')
      .map((part) => {
        if (complete) return { ...part }
        // Replayed as plain text and calls: provider metadata of an interrupted response points at items the
        // provider may not have kept (e.g. OpenAI Responses sends a text part's itemId as an item_reference,
        // which also needs the dropped reasoning item), so replaying it would break every later request
        const { providerOptions: _, ...plain } = part
        return plain
      })
    return { role: 'assistant', content }
  }

  get hasContent(): boolean {
    return this.content.length > 0
  }

  /** Tool calls have started running, so the request must not be sent again. */
  get toolsStarted(): boolean {
    return this.executionStarted.size > 0
  }

  private start(): void {
    if (this.started) return
    this.started = true
    this.emit({ type: 'message_start', message: this.snapshot() })
  }

  private update(assistantMessageEvent: AssistantMessageEvent): void {
    this.start()
    this.emit({
      type: 'message_update',
      message: this.snapshot(),
      assistantMessageEvent,
    })
  }

  private open(
    id: string,
    part: ContentPart,
    providerMetadata: ProviderMetadata | undefined,
  ): number {
    const index = this.content.length
    this.content.push(
      providerMetadata ? { ...part, providerOptions: providerMetadata } : part,
    )
    this.byStreamId.set(id, index)
    return index
  }

  private merge(index: number, providerMetadata: ProviderMetadata | undefined) {
    const part = this.content[index]
    if (!part || !providerMetadata) return
    part.providerOptions = { ...part.providerOptions, ...providerMetadata }
  }

  textStart(id: string, providerMetadata?: ProviderMetadata): void {
    const contentIndex = this.open(
      id,
      { type: 'text', text: '' },
      providerMetadata,
    )
    this.update({ type: 'text_start', contentIndex })
  }

  textDelta(
    id: string,
    delta: string,
    providerMetadata?: ProviderMetadata,
  ): void {
    if (!this.byStreamId.has(id)) this.textStart(id)
    const contentIndex = this.byStreamId.get(id) as number
    const part = this.content[contentIndex] as { text: string }
    part.text += delta
    this.merge(contentIndex, providerMetadata)
    this.update({ type: 'text_delta', contentIndex, delta })
  }

  textEnd(id: string, providerMetadata?: ProviderMetadata): void {
    const contentIndex = this.byStreamId.get(id)
    if (contentIndex === undefined) return
    this.merge(contentIndex, providerMetadata)
    const part = this.content[contentIndex] as { text: string }
    this.update({ type: 'text_end', contentIndex, content: part.text })
  }

  thinkingStart(id: string, providerMetadata?: ProviderMetadata): void {
    const contentIndex = this.open(
      id,
      { type: 'reasoning', text: '' },
      providerMetadata,
    )
    this.update({ type: 'thinking_start', contentIndex })
  }

  thinkingDelta(
    id: string,
    delta: string,
    providerMetadata?: ProviderMetadata,
  ): void {
    if (!this.byStreamId.has(id)) this.thinkingStart(id)
    const contentIndex = this.byStreamId.get(id) as number
    const part = this.content[contentIndex] as { text: string }
    part.text += delta
    this.merge(contentIndex, providerMetadata)
    this.update({ type: 'thinking_delta', contentIndex, delta })
  }

  thinkingEnd(id: string, providerMetadata?: ProviderMetadata): void {
    const contentIndex = this.byStreamId.get(id)
    if (contentIndex === undefined) return
    this.merge(contentIndex, providerMetadata)
    const part = this.content[contentIndex] as { text: string }
    this.update({ type: 'thinking_end', contentIndex, content: part.text })
  }

  toolCallStart(
    id: string,
    toolName: string,
    providerMetadata?: ProviderMetadata,
  ): void {
    const contentIndex = this.open(
      id,
      { type: 'tool-call', toolCallId: id, toolName, input: {} },
      providerMetadata,
    )
    this.rawToolInput.set(id, '')
    this.update({ type: 'toolcall_start', contentIndex })
  }

  async toolCallDelta(id: string, delta: string): Promise<void> {
    const contentIndex = this.byStreamId.get(id)
    if (contentIndex === undefined) return
    const raw = (this.rawToolInput.get(id) ?? '') + delta
    this.rawToolInput.set(id, raw)
    const parsed = await parsePartialJson(raw)
    const part = this.content[contentIndex] as ToolCallPart
    if (parsed.value !== undefined) part.input = parsed.value
    this.update({ type: 'toolcall_delta', contentIndex, delta })
  }

  toolCallEnd(call: {
    toolCallId: string
    toolName: string
    input: unknown
    providerMetadata?: ProviderMetadata
  }): void {
    if (!this.byStreamId.has(call.toolCallId))
      this.toolCallStart(call.toolCallId, call.toolName, call.providerMetadata)
    const contentIndex = this.byStreamId.get(call.toolCallId) as number
    const part = this.content[contentIndex] as ToolCallPart
    part.input = call.input
    this.merge(contentIndex, call.providerMetadata)
    const toolCall = { ...part }
    this.toolCalls.push(toolCall)
    this.update({ type: 'toolcall_end', contentIndex, toolCall })
    this.endIfReady()
  }

  /**
   * The model finished (AI SDK's model-call-end callback, which fires before tools run). The stream may still be
   * delivering its last parts, so the message ends here only if every tool call has streamed in; otherwise
   * when the last one does (see toolCallEnd).
   */
  modelFinished(finishReason: FinishReason, toolCallIds: string[]): void {
    this.modelEnd = { finishReason, toolCallIds }
    this.endIfReady()
  }

  private endIfReady(): void {
    // Without tool calls nothing runs next: the message ends at finish-step, after the stream delivered all its text
    if (!this.modelEnd?.toolCallIds.length || this.ended) return
    const seen = new Set(this.toolCalls.map((call) => call.toolCallId))
    if (this.modelEnd.toolCallIds.every((id) => seen.has(id)))
      this.end(this.modelEnd.finishReason)
  }

  /** A tool result arrived, so the model finished and its tools ran: end the message if that hasn't happened yet. */
  endBeforeResults(): void {
    this.end(this.modelEnd?.finishReason ?? 'tool-calls')
  }

  /**
   * Ends the message (once). When the model stopped normally its tool calls run next, so their
   * `tool_execution_start` follow (like pi, after the assistant's `message_end`).
   */
  end(finishReason: FinishReason): void {
    if (this.ended) return
    this.ended = true
    this.complete = true
    this.start()
    const runs = executesTools(finishReason) && this.toolCalls.length > 0
    const stopReason: StopReason =
      finishReason === 'length'
        ? 'length'
        : runs
          ? 'toolUse'
          : finishReason === 'error'
            ? 'error'
            : 'stop'
    this.emit({ type: 'message_end', message: this.snapshot(), stopReason })
    if (runs) for (const call of this.toolCalls) this.executionStart(call)
  }

  /** Ends the message as aborted / failed, keeping what streamed so far (no-op if it already ended). */
  endInterrupted(stopReason: 'aborted' | 'error', errorMessage: string): void {
    if (this.ended) return
    this.ended = true
    this.start()
    this.emit({
      type: 'message_end',
      message: this.snapshot({ complete: false }),
      stopReason,
      errorMessage,
    })
  }

  private executionStart(call: ToolCallPart): void {
    if (this.executionStarted.has(call.toolCallId)) return
    this.executionStarted.set(call.toolCallId, performance.now())
    this.emit({
      type: 'tool_execution_start',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.input,
    })
  }

  /** A tool call's outcome: emits `tool_execution_end` and records the result part for history. */
  result(
    call: { toolCallId: string; toolName: string; input?: unknown },
    outcome: { output: unknown; details?: unknown } | { error: unknown },
  ): void {
    if (this.results.has(call.toolCallId)) return
    const known = this.toolCalls.find((c) => c.toolCallId === call.toolCallId)
    this.executionStart(
      known ?? { type: 'tool-call', input: call.input, ...call },
    )
    const startedAt = this.executionStarted.get(call.toolCallId)
    const isError = 'error' in outcome
    const result = isError ? outcome.error : outcome.output
    this.emit({
      type: 'tool_execution_end',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result,
      isError,
      ...('details' in outcome && outcome.details !== undefined
        ? { details: outcome.details }
        : {}),
      ...(startedAt === undefined
        ? {}
        : { durationMs: Math.round(performance.now() - startedAt) }),
    })
    this.results.set(call.toolCallId, {
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: isError
        ? { type: 'error-text', value: errorMessageOf(result) }
        : typeof result === 'string'
          ? { type: 'text', value: result }
          : { type: 'json', value: (result ?? null) as never },
    })
  }

  /**
   * After an abort or a final error: answers every finished tool call that has no result yet with an
   * error result, so each call in history stays paired with a result.
   */
  closeOpenCalls(text: string): void {
    for (const call of this.toolCalls)
      if (!this.results.has(call.toolCallId))
        this.result(call, { error: new Error(text) })
  }

  /** The tool message for this step's results, in tool-call order (undefined when there are none). */
  toolMessage(): ToolModelMessage | undefined {
    const content = this.toolCalls
      .map((call) => this.results.get(call.toolCallId))
      .filter((part): part is ToolResultPart => part !== undefined)
    return content.length ? { role: 'tool', content } : undefined
  }
}

/** The tool-result parts of a step's tool messages (for turn_end). */
export function toolResultsOf(messages: ModelMessage[]): ToolResultPart[] {
  return messages.flatMap((message) =>
    message.role === 'tool'
      ? message.content.filter(
          (part): part is ToolResultPart => part.type === 'tool-result',
        )
      : [],
  )
}
