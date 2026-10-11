import type { ModelMessage } from 'ai'
import type { CompactionReason, VelaEventListener } from '../agent/events.ts'
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

  /** Replaces the context in memory with `messages` (already recorded in the session). */
  private replace(messages: ModelMessage[], summary = this.state.summary) {
    const timestamps = new Map(
      messages.map((message) => [
        message,
        this.state.timestamps.get(message) ?? Date.now(),
      ]),
    )
    const previous = this.state.messages.slice()
    this.restore({ messages, timestamps, summary })
    this.tracker.replaceMessages(previous, this.state.messages)
  }

  /** Waits until the session's entries are written; rejects if some could not be. */
  async save(): Promise<void> {
    await this.store.flush()
  }

  /** Folded tool output: each changed message is recorded as a context edit (the original stays in the session). */
  private applyMicrocompact(messages: ModelMessage[]): void {
    messages.forEach((message, index) => {
      const original = this.state.messages[index]
      if (original && message !== original) {
        this.store.appendContextEdit(original, message)
        const timestamp = this.state.timestamps.get(original)
        if (timestamp !== undefined)
          this.state.timestamps.set(message, timestamp)
      }
    })
    this.replace(messages)
  }

  /**
   * Summarizes earlier history (like pi's compaction): emits compaction_start / compaction_end, appends a
   * compaction entry (the summarized messages stay in the session) and replaces the context in memory.
   */
  private async summarizeHistory(
    request: RequestSnapshot,
    reason: CompactionReason,
    focus?: string,
  ): Promise<void> {
    this.onEvent?.({ type: 'compaction_start', reason })
    try {
      const before = estimateRequestTokens(request)
      const compacted = await summarize(
        request,
        this.store.results,
        this.tracker,
        this.limits.maxInputTokens,
        focus,
      )
      const after = estimateRequestTokens(request, compacted.messages)
      if (reason === 'threshold' && after > this.limits.maxInputTokens)
        throw new Error(
          'Context still exceeds the safe input size after summarizing; this turn was stopped and the original history kept.',
        )
      request.abortSignal?.throwIfAborted()
      const [summaryMessage, firstKept] = compacted.messages
      const entry = this.store.appendCompaction(
        summaryMessage as ModelMessage,
        compacted.summary,
        firstKept,
        before,
        compacted.historyViewSequence,
      )
      this.store.results.historyViewSequence = compacted.historyViewSequence
      this.replace(compacted.messages, compacted.summary)
      this.tracker.setEstimatedTokens(after)
      this.onEvent?.({
        type: 'compaction_end',
        reason,
        result: {
          summary: compacted.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: before,
          tokensAfter: after,
          messages: compacted.compressedCount,
        },
        aborted: false,
        willRetry: reason === 'overflow',
      })
    } catch (error) {
      const aborted = request.abortSignal?.aborted ?? false
      this.onEvent?.({
        type: 'compaction_end',
        reason,
        aborted,
        willRetry: false,
        ...(aborted
          ? {}
          : {
              errorMessage:
                error instanceof Error ? error.message : String(error),
            }),
      })
      throw error
    }
  }

  /** Manual summary (session.compact(), or after a provider context overflow): ignores thresholds, replaces earlier history with a summary. */
  async compact(
    request: RequestSnapshot,
    focus?: string,
    reason: 'manual' | 'overflow' = 'manual',
  ): Promise<void> {
    await this.summarizeHistory(request, reason, focus)
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
      this.applyMicrocompact(micro.messages)
      this.tracker.setEstimatedTokens(microAfter)
      this.onEvent?.({
        type: 'context_prepare',
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
          type: 'context_prepare',
          action: 'summary-required',
          before,
          saved: savings,
        })
        return
      }
      // Summarize before micro changes history so the main request prefix stays intact.
      await this.summarizeHistory(request, 'threshold')
      return
    }
    if (before > this.limits.maxInputTokens)
      throw new Error(
        'Context exceeds the safe input size; this turn was stopped and the original history kept.',
      )
    this.tracker.setEstimatedTokens(before)
  }
}
