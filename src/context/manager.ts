import type { ModelMessage } from 'ai'
import type { SessionState, SessionStore } from '../session'
import type { TokenTracker } from '../usage/tracker'
import {
  MICROCOMPACT_TOKEN_THRESHOLD,
  MIN_MICRO_SAVINGS,
  persistMicrocompact,
  planMicrocompact,
  SUMMARY_TOKEN_THRESHOLD,
  summarize,
} from './compressor'
import {
  estimateRequestTokens,
  MAX_INPUT_TOKENS,
  type RequestSnapshot,
} from './request'
export { createRequestSnapshot } from './request'

export class ContextManager {
  constructor(
    readonly store: SessionStore,
    readonly tracker: TokenTracker,
    readonly state: SessionState = {
      messages: [],
      timestamps: new Map(),
      summary: '',
    },
  ) {}

  restore(state: SessionState): void {
    this.state.messages.splice(0, this.state.messages.length, ...state.messages)
    this.state.timestamps.clear()
    for (const [message, timestamp] of state.timestamps)
      this.state.timestamps.set(message, timestamp)
    this.state.summary = state.summary
  }

  async commit(
    messages: ModelMessage[],
    summary = this.state.summary,
    historyViewSequence = this.store.results.historyViewSequence,
  ): Promise<void> {
    const timestamps = new Map(
      messages.map((message) => [
        message,
        this.state.timestamps.get(message) ?? Date.now(),
      ]),
    )
    await this.store.replace(messages, timestamps, summary, historyViewSequence)
    this.store.results.historyViewSequence = historyViewSequence
    const previous = this.state.messages.slice()
    this.restore({ messages: messages.slice(), timestamps, summary })
    this.tracker.replaceMessages(previous, this.state.messages)
  }

  async save(): Promise<void> {
    await this.commit(this.state.messages.slice())
  }

  async prepare(
    request: RequestSnapshot,
    options: { allowSummary?: boolean } = {},
  ): Promise<void> {
    request.abortSignal?.throwIfAborted()
    const before = estimateRequestTokens(request)
    const micro =
      before >= MICROCOMPACT_TOKEN_THRESHOLD
        ? planMicrocompact(request.messages, this.store.results)
        : null
    const microAfter = micro
      ? estimateRequestTokens(request, micro.messages)
      : before
    const savings = before - microAfter
    if (
      micro &&
      savings >= MIN_MICRO_SAVINGS &&
      microAfter < SUMMARY_TOKEN_THRESHOLD
    ) {
      await persistMicrocompact(micro.candidates, this.store.results)
      request.abortSignal?.throwIfAborted()
      await this.commit(micro.messages)
      this.tracker.setEstimatedTokens(microAfter)
      console.log(
        `[Context] action=micro before=${before} after=${microAfter} saved=${savings} calls=${micro.candidates.length}`,
      )
      return
    }
    if (before >= SUMMARY_TOKEN_THRESHOLD) {
      if (options.allowSummary === false) {
        console.log(
          `[Context] action=summary-required before=${before} microSavings=${savings}; 下次模型请求时生成摘要`,
        )
        return
      }
      // Choose summary before changing history; its dedicated task sees only the old prefix.
      const compacted = await summarize(
        request,
        this.store.results,
        this.tracker,
      )
      const after = estimateRequestTokens(request, compacted.messages)
      if (after > MAX_INPUT_TOKENS)
        throw new Error('摘要后上下文仍超过安全容量，本轮已停止，原历史保留。')
      request.abortSignal?.throwIfAborted()
      await this.commit(
        compacted.messages,
        compacted.summary,
        compacted.historyViewSequence,
      )
      this.tracker.setEstimatedTokens(after)
      console.log(
        `[Context] action=summary before=${before} after=${after} messages=${compacted.compressedCount}`,
      )
      return
    }
    if (before > MAX_INPUT_TOKENS)
      throw new Error('上下文超过安全容量，本轮已停止，原历史保留。')
    this.tracker.setEstimatedTokens(before)
  }
}
