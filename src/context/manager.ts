import type { ModelMessage } from 'ai'
import type { VelaEventListener } from '../agent/events.ts'
import { resolveLimits, type VelaLimits } from '../limits.ts'
import type { SessionState, SessionStore } from '../session/index.ts'
import type { TokenTracker } from '../usage/tracker.ts'
import {
  persistMicrocompact,
  planMicrocompact,
  summarize,
} from './compressor.ts'
import { estimateRequestTokens, type RequestSnapshot } from './request.ts'

export { createRequestSnapshot } from './request.ts'

export class ContextManager {
  constructor(
    readonly store: SessionStore,
    readonly tracker: TokenTracker,
    readonly state: SessionState = {
      messages: [],
      timestamps: new Map(),
      summary: '',
    },
    /** Compaction is reported through events; silent when omitted. */
    public onEvent?: VelaEventListener,
    /** Compaction thresholds and input cap; missing fields use defaults. */
    limits: Partial<VelaLimits> = {},
  ) {
    this.limits = resolveLimits(limits)
  }

  readonly limits: VelaLimits

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

  /** Manual summary (session.compact(), or after a provider context overflow): ignores thresholds, replaces earlier history with a summary and saves it. */
  async compact(
    request: RequestSnapshot,
    focus?: string,
    action: 'compact' | 'overflow' = 'compact',
  ): Promise<void> {
    const before = estimateRequestTokens(request)
    const compacted = await summarize(
      request,
      this.store.results,
      this.tracker,
      this.limits.maxInputTokens,
      focus,
    )
    const after = estimateRequestTokens(request, compacted.messages)
    request.abortSignal?.throwIfAborted()
    await this.commit(
      compacted.messages,
      compacted.summary,
      compacted.historyViewSequence,
    )
    this.tracker.setEstimatedTokens(after)
    this.onEvent?.({
      type: 'context',
      action,
      before,
      after,
      messages: compacted.compressedCount,
    })
  }

  async prepare(
    request: RequestSnapshot,
    options: { allowSummary?: boolean } = {},
  ): Promise<void> {
    request.abortSignal?.throwIfAborted()
    const before = estimateRequestTokens(request)
    const micro =
      before >= this.limits.microcompactThreshold
        ? planMicrocompact(request.messages, this.store.results)
        : null
    const microAfter = micro
      ? estimateRequestTokens(request, micro.messages)
      : before
    const savings = before - microAfter
    if (
      micro &&
      savings >= this.limits.minMicroSavings &&
      microAfter < this.limits.summaryThreshold
    ) {
      await persistMicrocompact(micro.candidates, this.store.results)
      request.abortSignal?.throwIfAborted()
      await this.commit(micro.messages)
      this.tracker.setEstimatedTokens(microAfter)
      this.onEvent?.({
        type: 'context',
        action: 'micro',
        before,
        after: microAfter,
        saved: savings,
        calls: micro.candidates.length,
      })
      return
    }
    if (before >= this.limits.summaryThreshold) {
      if (options.allowSummary === false) {
        this.onEvent?.({
          type: 'context',
          action: 'summary-required',
          before,
          saved: savings,
        })
        return
      }
      // Summarize before micro changes history so the main request prefix stays intact.
      const compacted = await summarize(
        request,
        this.store.results,
        this.tracker,
        this.limits.maxInputTokens,
      )
      const after = estimateRequestTokens(request, compacted.messages)
      if (after > this.limits.maxInputTokens)
        throw new Error(
          'Context still exceeds the safe input size after summarizing; this turn was stopped and the original history kept.',
        )
      request.abortSignal?.throwIfAborted()
      await this.commit(
        compacted.messages,
        compacted.summary,
        compacted.historyViewSequence,
      )
      this.tracker.setEstimatedTokens(after)
      this.onEvent?.({
        type: 'context',
        action: 'summary',
        before,
        after,
        messages: compacted.compressedCount,
      })
      return
    }
    if (before > this.limits.maxInputTokens)
      throw new Error(
        'Context exceeds the safe input size; this turn was stopped and the original history kept.',
      )
    this.tracker.setEstimatedTokens(before)
  }
}
