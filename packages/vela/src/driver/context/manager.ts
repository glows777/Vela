import { resolveLimits, type VelaLimits } from '../../shared/limits.ts'
import type { CompactionReason, VelaEventListener } from '../agent/events.ts'
import type { ModelMessage } from '../messages.ts'
import type { SessionState, SessionStore } from '../session/index.ts'
import type { TokenTracker } from '../usage/tracker.ts'
import { canSummarize, summarize } from './compressor.ts'
import {
  contextRequestTokens,
  estimateRequestTokens,
  type RequestSnapshot,
} from './request.ts'

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

  /**
   * Automatic compaction (like pi's compaction.enabled). When off, nothing changes the context on its own:
   * no threshold summary (the session also skips compact-and-retry on overflow).
   * Manual compact() still works.
   */
  autoCompaction = true

  restore(state: SessionState): void {
    this.state.messages.splice(0, this.state.messages.length, ...state.messages)
    this.state.timestamps.clear()
    for (const [message, timestamp] of state.timestamps)
      this.state.timestamps.set(message, timestamp)
    this.state.summary = state.summary
  }

  /** Replaces the context in memory with `messages` (already recorded in the session). */
  private replace(
    messages: ModelMessage[],
    summary = this.state.summary,
    syncTracker = true,
  ) {
    const timestamps = new Map(
      messages.map((message) => [
        message,
        this.state.timestamps.get(message) ?? Date.now(),
      ]),
    )
    const previous = this.state.messages.slice()
    this.restore({ messages, timestamps, summary })
    if (syncTracker) this.tracker.replaceMessages(previous, this.state.messages)
  }

  /**
   * Summarizes the part of the context from `start` on (a branch the session is leaving) and returns the
   * summary text; the context itself is not changed.
   */
  async summarizeBranch(
    request: RequestSnapshot,
    start: number,
    focus?: string,
  ): Promise<string> {
    const result = await summarize(
      request,
      this.store,
      this.tracker,
      this.limits.maxInputTokens,
      focus,
      start,
    )
    return result.summary
  }

  /** Waits until the session's entries are written; rejects if some could not be. */
  async save(): Promise<void> {
    await this.store.flush()
  }

  /** Keeps the tracker's displayed estimate in sync when no provider report anchors it. */
  private syncContextEstimate(tokens: number): void {
    if (this.tracker.reportedContextTokens === undefined)
      this.tracker.setEstimatedTokens(tokens, true)
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
      let latestMemoryMsg: ModelMessage | undefined
      if (reason === 'overflow') {
        for (let i = request.messages.length - 1; i >= 0; i--) {
          const candidate = request.messages[i]!
          const candidateId = this.store.idOf(candidate)
          const entry = candidateId
            ? this.store.getEntry(candidateId)
            : undefined
          if (
            entry?.type === 'custom_message' &&
            entry.customType === 'memory'
          ) {
            latestMemoryMsg = candidate
            break
          }
        }
      }
      const estimate = Math.max(
        0,
        estimateRequestTokens(request) + this.tracker.contextDelta,
      )
      const before = contextRequestTokens(
        request,
        this.tracker.reportedContextTokens,
        estimate,
      )
      const compacted = await summarize(
        request,
        this.store,
        this.tracker,
        this.limits.maxInputTokens,
        focus,
      )
      const nextMessages =
        latestMemoryMsg && !compacted.messages.includes(latestMemoryMsg)
          ? [
              compacted.messages[0]!,
              latestMemoryMsg,
              ...compacted.messages.slice(1),
            ]
          : compacted.messages
      const after = estimateRequestTokens(request, nextMessages)
      request.abortSignal?.throwIfAborted()
      const [summaryMessage, firstKept] = compacted.messages
      const entry = this.store.appendCompaction(
        summaryMessage as ModelMessage,
        compacted.summary,
        firstKept,
        before,
      )
      this.replace(nextMessages, compacted.summary, false)
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

  async prepare(request: RequestSnapshot): Promise<void> {
    request.abortSignal?.throwIfAborted()
    const rawEstimate = estimateRequestTokens(request)
    this.syncContextEstimate(rawEstimate)
  }

  /** Post-turn threshold auto-compaction (runs after `agent_end` so mid-turn prompt prefixes stay cached). */
  async compactIfNeeded(request: RequestSnapshot): Promise<boolean> {
    if (!this.autoCompaction) return false
    const estimate = Math.max(
      0,
      estimateRequestTokens(request) + this.tracker.contextDelta,
    )
    const before = contextRequestTokens(
      request,
      this.tracker.reportedContextTokens,
      estimate,
    )
    if (
      before >= this.limits.summaryThreshold &&
      canSummarize(request.messages, this.limits.maxInputTokens)
    ) {
      await this.summarizeHistory(request, 'threshold')
      return true
    }
    return false
  }
}
