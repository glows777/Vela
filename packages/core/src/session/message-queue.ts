import type { CustomMessageInfo, VelaEventListener } from '../agent/events.ts'
import { type ModelMessage, normalizeUserMessage } from '../messages.ts'
import type { QueueMode } from './options.ts'

/** Queued inputs and custom-message metadata owned by one session. */
export class MessageQueue {
  private readonly steeringQueue: ModelMessage[] = []
  private readonly followUpQueue: ModelMessage[] = []
  /** Extensions' custom messages in the history or queues, and what they carry (pi's custom message fields) */
  readonly customMessages = new WeakMap<ModelMessage, CustomMessageInfo>()
  /** Custom messages sent while running without triggering a turn: appended once the step's tool results are in (like pi) */
  readonly pendingCustom: ModelMessage[] = []
  /** Custom messages for the next prompt (`deliverAs: 'nextTurn'`) */
  readonly nextTurnMessages: ModelMessage[] = []
  constructor(private readonly emit: VelaEventListener) {}

  enqueue(kind: 'steering' | 'followUp', message: ModelMessage): void {
    ;(kind === 'steering' ? this.steeringQueue : this.followUpQueue).push(
      message,
    )
    this.emitQueue()
  }

  /** Clears queued messages and returns the user inputs among them (the TUI puts them back in the input box before aborting). */
  clear(): { steering: string[]; followUp: string[] } {
    const steering = this.steeringQueue.splice(0)
    const followUp = this.followUpQueue.splice(0)
    if (steering.length || followUp.length) this.emitQueue()
    return {
      steering: this.inputTexts(steering),
      followUp: this.inputTexts(followUp),
    }
  }

  /** Currently queued user inputs (a copy; queued custom messages are not listed) */
  get queue(): { steering: string[]; followUp: string[] } {
    return {
      steering: this.inputTexts(this.steeringQueue),
      followUp: this.inputTexts(this.followUpQueue),
    }
  }

  private inputTexts(messages: ModelMessage[]): string[] {
    return messages
      .filter((message) => !this.customMessages.has(message))
      .map(messageText)
  }

  private emitQueue(): void {
    this.emit({ type: 'queue_update', ...this.queue })
  }

  /** Takes from the queues by mode: steer first, then followUp. */
  dequeue(kind: 'steering' | 'followUp', mode: QueueMode): ModelMessage[] {
    const queue = kind === 'steering' ? this.steeringQueue : this.followUpQueue
    const taken = queue.splice(0, mode === 'all' ? queue.length : 1)
    if (taken.length) this.emitQueue()
    return taken
  }

  /** Preserve extension display metadata when normalization replaces an input object. */
  async normalizeInput(message: ModelMessage): Promise<ModelMessage> {
    const normalized = await normalizeUserMessage(message)
    const custom = this.customMessages.get(message)
    if (custom && normalized !== message)
      this.customMessages.set(normalized, custom)
    return normalized
  }
}

/** Text of a user message (its text parts joined). */
export function messageText(message: ModelMessage): string {
  const { content } = message
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}
