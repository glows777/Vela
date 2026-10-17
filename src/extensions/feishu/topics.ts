import { z } from 'zod'
import type { ChannelRuntime, IncomingMessage } from '../../channels/types.ts'
import type { ToolContext, ToolRegistry } from '../../tools/registry.ts'
import type { SessionOptions } from '../../vela-session.ts'
import type { ExtensionAPI } from '../types.ts'
import type { FeishuMessageEvent, FeishuTransport } from './transport.ts'

const toolNames = [
  'feishu_start_topic',
  'feishu_forward_to_topic',
  'feishu_list_topics',
]
const channelPrompt =
  'You are the channel session for this group. Answer a short question directly: a short question can be answered from the visible conversation, in one reply, without tools. For investigation, execution, tool-based work, or a longer exchange, start a topic with a concrete task. Forward a message to an existing topic only when it belongs to that task. Use the topic list to report actual state; do not invent progress. After handing off, do not repeat the task in the main timeline. Do not copy unrelated conversations into the task.'
const topicPrompt =
  'You are working on one task in this topic. Progress is shown to people automatically, so do not narrate progress in separate replies. When finished, give the result. When you need a decision, ask one clear question and end the run. Continue from the next message in this topic.'

function isChannel(msg: IncomingMessage): boolean {
  return (
    !msg.topic &&
    (msg.raw as FeishuMessageEvent | undefined)?.message.chat_type === 'group'
  )
}

export class FeishuTopics {
  runtime?: ChannelRuntime
  private sessions = new WeakMap<ToolRegistry, string>()
  constructor(private transport: () => FeishuTransport) {}

  sessionOptions(msg: IncomingMessage): SessionOptions {
    return isChannel(msg)
      ? {}
      : {
          permissions: Object.fromEntries(
            toolNames.map((name) => [name, 'deny' as const]),
          ),
        }
  }

  private source(ctx?: ToolContext) {
    const id = ctx?.registry && this.sessions.get(ctx.registry)
    const runtime = this.runtime
    const msg = id && runtime?.context(id)
    if (!runtime || !id || !msg || !isChannel(msg) || !msg.replyToId)
      throw new Error(
        'Topic dispatch requires an active Feishu group channel session',
      )
    return { id, msg, runtime, messageId: msg.replyToId }
  }

  register(vela: ExtensionAPI): void {
    vela.on('before_agent_start', (event, { session }) => {
      this.sessions.set(session.registry, session.id)
      const msg = this.runtime?.context(session.id)
      if (msg?.topic) event.sections.feishuTopic = topicPrompt
      else if (msg && isChannel(msg))
        event.sections.feishuChannel = channelPrompt
    })
    vela.registerTool({
      name: 'start_topic',
      description:
        'Start a topic under the current message and hand off a concrete task. Returns immediately after enqueueing; does not wait for the task.',
      inputSchema: z.object({ task: z.string().trim().min(1) }),
      executionMode: 'sequential',
      execute: async ({ task }: { task: string }, ctx) => {
        const { id, msg, runtime, messageId } = this.source(ctx)
        const receipt = await this.transport().startTopic(messageId, task)
        runtime.dispatch(id, {
          channelId: msg.channelId,
          senderId: msg.senderId,
          senderName: msg.senderName,
          text: `${msg.senderName}: ${task}`,
          replyToId: receipt.messageId,
          topic: { rootId: receipt.rootId, threadId: receipt.threadId },
        })
        return receipt
      },
    })
    vela.registerTool({
      name: 'forward_to_topic',
      description:
        'Forward the current original message into an owned topic in this group, with its sender attribution, and enqueue it once.',
      inputSchema: z.object({ root_id: z.string().min(1) }),
      executionMode: 'sequential',
      execute: async ({ root_id }: { root_id: string }, ctx) => {
        const { id, msg, runtime, messageId } = this.source(ctx)
        const target = runtime
          .topics(msg.channelId)
          .find((topic) => topic.rootId === root_id)
        if (!target)
          throw new Error(
            'The target is not an observed owned topic in this group',
          )
        const receipt = await this.transport().forward(
          messageId,
          target.threadId,
        )
        const original = msg.raw as FeishuMessageEvent
        runtime.dispatch(id, {
          channelId: msg.channelId,
          senderId: msg.senderId,
          senderName: msg.senderName,
          text: '',
          replyToId: receipt.messageId,
          topic: target,
          requireExistingSession: true,
          raw: {
            ...original,
            message: {
              ...original.message,
              root_id: target.rootId,
              thread_id: target.threadId,
            },
          },
        })
        return receipt
      },
    })
    vela.registerTool({
      name: 'list_topics',
      description:
        'List this group’s owned topics observed by this process and their current state. This is not a complete historical directory after restart.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      execute: async (_input, ctx) => {
        const { msg, runtime } = this.source(ctx)
        return {
          coverage: 'Owned topics observed by this process',
          topics: runtime.topics(msg.channelId),
        }
      },
    })
  }
}
