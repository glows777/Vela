import type {
  CustomMessage,
  CustomMessageInfo,
  VelaEventListener,
} from '../agent/events.ts'
import { type ModelMessage, normalizeUserMessage } from '../messages.ts'
import { assertCustomType } from './entries.ts'
import type { QueueMode } from './options.ts'

/** Queued steer inputs and custom-message metadata owned by one session. */
export class MessageQueue {
  private readonly steeringQueue: ModelMessage[] = []
  /** Extensions' custom messages in the history or queues, and what they carry (pi's custom message fields) */
  readonly customMessages = new WeakMap<ModelMessage, CustomMessageInfo>()
  /** Custom messages sent while running without triggering a turn: appended once the step's tool results are in (like pi) */
  readonly pendingCustom: ModelMessage[] = []
  /** Custom messages for the next prompt (`deliverAs: 'nextTurn'`) */
  readonly nextTurnMessages: ModelMessage[] = []
  constructor(private readonly emit: VelaEventListener) {}

  /** Builds the user message a custom message becomes and remembers its fields. */
  customMessage(message: CustomMessage): ModelMessage {
    assertCustomType(message.customType)
    if (typeof message.content !== 'string' && !Array.isArray(message.content))
      throw new Error('A custom message needs content (a string or parts)')
    const entry: ModelMessage = { role: 'user', content: message.content }
    this.customMessages.set(entry, {
      customType: message.customType,
      display: message.display === true,
      ...(message.details === undefined ? {} : { details: message.details }),
    })
    return entry
  }

  flushPendingCustom(append: (message: ModelMessage) => void): void {
    for (const message of this.pendingCustom.splice(0)) append(message)
  }

  enqueue(message: ModelMessage): void {
    this.steeringQueue.push(message)
    this.emitQueue()
  }

  /** Clears queued steer messages and returns the user inputs among them. */
  clear(): { steering: string[] } {
    const steering = this.steeringQueue.splice(0)
    if (steering.length) this.emitQueue()
    return {
      steering: this.inputTexts(steering),
    }
  }

  /** Currently queued user steer inputs (a copy; queued custom messages are not listed). */
  get queue(): { steering: string[] } {
    return {
      steering: this.inputTexts(this.steeringQueue),
    }
  }

  get hasSteering(): boolean {
    return this.steeringQueue.length > 0
  }

  private inputTexts(messages: ModelMessage[]): string[] {
    return messages
      .filter((message) => !this.customMessages.has(message))
      .map(messageText)
  }

  private emitQueue(): void {
    this.emit({ type: 'queue_update', ...this.queue })
  }

  /** Takes from the steer queue by mode. */
  dequeue(mode: QueueMode): ModelMessage[] {
    const taken = this.steeringQueue.splice(
      0,
      mode === 'all' ? this.steeringQueue.length : 1,
    )
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
