import { type Component, Container } from '@earendil-works/pi-tui'
import type { ModelMessage } from '@glows777/vela-core'
import {
  AssistantMessage,
  BashExecution,
  CustomMessageBlock,
  imagePlaceholder,
  notice,
  ToolBlock,
  UserMessage,
} from './components.ts'
import { TurnFold } from './turn-fold.ts'
import type { LogLevel } from './types.ts'

export interface CustomMessage {
  customType: string
  display?: boolean
}

/**
 * The chat log: what the session produced, in order. A turn's thought and tool calls fold into one line
 * above its answer (see `TurnFold`); this class decides what belongs to that process and what stays on
 * screen, so the session handling above only forwards messages and events.
 */
export class ChatLog {
  readonly container = new Container()
  private readonly turns: TurnFold[] = []
  private readonly tools = new Map<string, ToolBlock>()
  private readonly allTools: ToolBlock[] = []
  private readonly allAssistant: AssistantMessage[] = []
  private readonly allBash: BashExecution[] = []
  /** The turn being written; created by its first thinking or tool call */
  private turn?: TurnFold
  /** Answer text streaming outside the fold; a tool call makes it part of the process */
  private answer?: AssistantMessage
  /** The last text that stayed outside the fold: a turn that ends with one keeps its fold closed */
  private lastAnswer?: AssistantMessage
  /** Thinking of the assistant message being written, inside the fold */
  private thinking?: AssistantMessage
  private turnsExpanded = false
  /** `!` output the user can expand on its own, outside any turn's fold */
  private bashExpanded = false
  private hideThinking = false

  constructor(private readonly requestRender: () => void) {}

  /** Drop everything, e.g. when another session opens. */
  clear(): void {
    for (const block of this.allTools) block.stop()
    for (const turn of this.turns) turn.stop()
    this.container.clear()
    this.tools.clear()
    this.allTools.length = 0
    this.allAssistant.length = 0
    this.allBash.length = 0
    this.turns.length = 0
    this.turn = undefined
    this.answer = undefined
    this.lastAnswer = undefined
    this.thinking = undefined
  }

  addNotice(text: string, level: LogLevel | 'dim' = 'info', raw = false): void {
    const trimmed = text.replace(/^\n+|\n+$/g, '')
    if (!trimmed.trim()) return
    this.container.addChild(notice(trimmed, level, raw))
    this.requestRender()
  }

  /** Add a block the log does not manage (a dialog's output, a queued message line, ...) */
  add(child: Component): void {
    this.container.addChild(child)
  }

  // ---------------------------------------------------------------- Messages

  /**
   * Draw a session message. Live user messages always show; assistant messages only in history, where their
   * thinking, text and tool calls are replayed in order.
   */
  renderMessage(
    message: ModelMessage,
    history = false,
    custom?: CustomMessage,
  ): void {
    if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) =>
                part.type === 'text'
                  ? part.text
                  : `\n${imagePlaceholder(part) ?? ''}`,
              )
              .join('')
      // Like pi: an extension's custom message shows only with `display: true`, in its own block
      if (custom) {
        if (custom.display)
          this.add(new CustomMessageBlock(custom.customType, text))
      } else if (text.trim()) this.add(new UserMessage(text))
      // A message that arrives mid-run is a steer: the turn goes on and keeps its fold
      if (history) this.endTurn()
      else this.nextMessage()
      return
    }
    if (!history) return
    if (message.role === 'assistant') {
      this.nextMessage()
      if (typeof message.content === 'string') {
        this.answerText().appendText(message.content)
        return
      }
      for (const part of message.content) {
        if (part.type === 'text') this.answerText().appendText(part.text)
        else if (part.type === 'reasoning') {
          // Saved history keeps the thinking but not how long it took
          this.currentTurn().noteThought()
          this.thinkingText().appendThinking(part.text)
        } else if (part.type === 'tool-call')
          this.addTool(part.toolCallId, part.toolName, part.input)
      }
    }
  }

  // ---------------------------------------------------------------- The turn

  appendThinking(delta: string): void {
    this.currentTurn().startThinking()
    this.thinkingText().appendThinking(delta)
  }

  appendText(delta: string): void {
    this.turn?.stopThinking()
    this.answerText().appendText(delta)
  }

  /** The request behind the streaming text failed: that text stays, marked, and a retry starts anew. */
  markFailed(): void {
    if (this.answer?.hasContent) this.answer.markFailed()
  }

  /** A new assistant message: the previous one's thinking and answer references end here. */
  nextMessage(): void {
    this.turn?.stopThinking()
    this.thinking = undefined
    this.answer = undefined
  }

  /** The prompt's run is over: settle its fold. A turn that left no answer stays open. */
  endTurn(): void {
    const turn = this.turn
    this.turn = undefined
    const answered = this.lastAnswer?.hasText ?? false
    this.answer = undefined
    this.lastAnswer = undefined
    this.thinking = undefined
    turn?.settle(answered)
  }

  /** Every block still waiting for a result (the run stopped): stop their clocks. */
  stopTools(): void {
    for (const block of this.allTools) block.stop()
  }

  toggleExpanded(): void {
    this.turnsExpanded = !this.turnsExpanded
    // A block that arrives later starts the way the log currently reads
    this.bashExpanded = this.turnsExpanded
    for (const turn of this.turns) turn.setExpanded(this.turnsExpanded)
    for (const block of this.allBash) block.setExpanded(this.turnsExpanded)
    this.container.invalidate()
    this.requestRender()
  }

  toggleThinking(): void {
    this.hideThinking = !this.hideThinking
    for (const message of this.allAssistant)
      message.setHideThinking(this.hideThinking)
    this.requestRender()
  }

  private currentTurn(): TurnFold {
    if (this.turn) return this.turn
    const turn = new TurnFold(this.requestRender, this.turnsExpanded)
    this.turns.push(turn)
    this.container.addChild(turn)
    this.turn = turn
    return turn
  }

  /**
   * Answer text streams outside the fold: until a tool call shows it was only a preamble, the reader sees
   * the model's words as they arrive rather than a blank fold line.
   */
  private answerText(): AssistantMessage {
    if (!this.answer) {
      this.answer = new AssistantMessage(this.hideThinking)
      this.lastAnswer = this.answer
      this.allAssistant.push(this.answer)
      this.container.addChild(this.answer)
    }
    return this.answer
  }

  /** Thinking belongs to the process, so it streams inside the fold. */
  private thinkingText(): AssistantMessage {
    if (!this.thinking) {
      this.thinking = new AssistantMessage(this.hideThinking)
      this.allAssistant.push(this.thinking)
      this.currentTurn().add(this.thinking)
    }
    return this.thinking
  }

  /** The text before a tool call was a preamble: it joins the process instead of staying on screen. */
  private foldAnswer(): void {
    const answer = this.answer
    this.answer = undefined
    if (!answer) return
    if (this.lastAnswer === answer) this.lastAnswer = undefined
    this.container.removeChild(answer)
    if (answer.hasText) this.currentTurn().add(answer)
    else this.allAssistant.splice(this.allAssistant.indexOf(answer), 1)
  }

  // ---------------------------------------------------------------- Tools

  addTool(id: string, name: string, input: unknown): void {
    // The model stopped thinking to call a tool
    this.turn?.stopThinking()
    this.foldAnswer()
    const turn = this.currentTurn()
    const block = new ToolBlock(name, input, this.requestRender)
    this.tools.set(id, block)
    this.allTools.push(block)
    turn.add(block)
    turn.noteTool(name)
  }

  hasTool(id: string): boolean {
    return this.tools.has(id)
  }

  startTool(id: string): void {
    this.tools.get(id)?.start()
  }

  updateTool(id: string, partialResult: unknown): void {
    this.tools.get(id)?.update(partialResult)
  }

  tool(id: string): ToolBlock | undefined {
    return this.tools.get(id)
  }

  /** The top-level block a nested call belongs to: nested ids are `<parent>/<n>`, at any depth */
  rootTool(parentToolCallId: string): ToolBlock | undefined {
    return (
      this.tools.get(parentToolCallId) ??
      this.tools.get(parentToolCallId.split('/', 1)[0] as string)
    )
  }

  /**
   * A tool call ended. A failure moves out of the fold: folding it would hide the one line the reader has
   * to see (Claude Code pops out failed calls the same way).
   */
  settleTool(
    block: ToolBlock | undefined,
    output: unknown,
    isError: boolean,
    details?: unknown,
    durationMs?: number,
  ): void {
    if (!block) return
    block.setResult(output, isError, details, durationMs)
    if (!isError) return
    const turn = this.turn
    if (!turn) return
    turn.remove(block)
    // Keep it where it happened: right after the fold, not at the end of the transcript
    const children = this.container.children
    const index = children.indexOf(turn)
    if (index === -1) children.push(block)
    else children.splice(index + 1, 0, block)
  }

  // ---------------------------------------------------------------- `!` commands

  /** `!` output never folds, so it keeps its preview and expands on its own. */
  addBash(
    command: string,
    excludeFromContext: boolean,
    container: Container = this.container,
  ): BashExecution {
    const block = new BashExecution(
      command,
      excludeFromContext,
      this.bashExpanded,
    )
    this.allBash.push(block)
    container.addChild(block)
    return block
  }
}
