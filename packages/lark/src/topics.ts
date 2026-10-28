import type { ChannelRuntime, IncomingMessage } from '@glows777/vela-channels'
import { routineToolSchema } from '@glows777/vela-channels'
import type {
  ExtensionAPI,
  ImageContent,
  ToolContext,
} from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import { historySearchSchema, searchHistory } from './search-history.ts'
import type { LarkMessageEvent, LarkTransport } from './transport.ts'

export const topicToolNames = [
  'lark_start_topic',
  'lark_forward_to_topic',
  'lark_list_topics',
  'lark_skip_reply',
  'lark_routines',
]
const channelPrompt =
  'You are the channel session for this group. Answer a short question directly: a short question can be answered from the visible conversation, in one reply, without tools. Manage scheduled wake-ups directly with lark_routines in the conversation where they should run; do not start a topic just to create, list or cancel a wake-up. For any other request (investigation, execution, tool-based work, or a longer exchange) start a topic with lark_start_topic: a request that needs work must not be answered in the group. The title is posted as the topic’s first visible message: name the task the way a person would, in one line of at most 40 characters, with no requirements, method or status. The brief is sent only to the topic session and holds the goal of the requester and the facts it needs, including the requirements. Neither holds a plan or method. Forward a message to an existing topic only when it belongs to that task. Use the topic list to report actual state; do not invent progress. The task field is the original title of the topic, not a summary of every later request. waitingReason describes the current required input after follow-up work; a difference from the original title alone does not indicate corrupt or misassigned data. Report the current state and waitingReason without inventing a mismatch. When a follow-up clearly refers to earlier work missing from the list, say that the earlier topic could not be found before starting a new one; include that notice at the beginning of the title passed to lark_start_topic so people see it in the topic entry. An empty list does not mean there are no tasks. After handing off, do not repeat the task in the main timeline. Do not copy unrelated conversations into the brief.'
const topicPrompt =
  'This topic contains a conversation about one task. Progress is shown to people automatically, so do not narrate progress in separate replies. Continue unfinished work and apply requested additions or corrections using the topic context. When completing requested work, give its result once. When you need a decision, call lark_wait_for_input with the required decision as its reason, then ask one clear question and end the run.\n\nRespond to the latest user message. Earlier tasks and completed reports are context, not a standing request to repeat them. Treat completed answers in the history as already reported, not as pending delivery. Once a result has been delivered, do not repeat or resume the task unless the latest user asks for that. A greeting should receive only a brief greeting. Acknowledgments, completion notices, and requests to stop repetition should receive only a brief acknowledgment, without repeating the report, its checklist, or the earlier task constraints.'

function isChannel(msg: IncomingMessage): boolean {
  return !msg.topic && !!msg.replyToId
}

export class LarkTopics {
  runtime?: ChannelRuntime
  readonly triggerImages = new WeakMap<LarkMessageEvent, ImageContent[]>()
  constructor(
    private transport: () => LarkTransport,
    private onHandled?: (
      chatId: string,
      messageId: string,
      createTime: string,
    ) => void,
  ) {}

  private markHandled(msg: IncomingMessage): void {
    const message = (msg.raw as LarkMessageEvent | undefined)?.message
    if (!message?.message_id || !message.create_time) return
    this.onHandled?.(msg.channelId, message.message_id, message.create_time)
  }

  sessionOptions(msg: IncomingMessage) {
    return isChannel(msg)
      ? { permissions: { lark_wait_for_input: 'deny' as const } }
      : {
          permissions: Object.fromEntries(
            [
              ...topicToolNames.filter((name) => name !== 'lark_routines'),
              ...(!msg.topic
                ? ['lark_wait_for_input', 'lark_search_history']
                : []),
            ].map((name) => [name, 'deny' as const]),
          ),
        }
  }

  private source(ctx?: ToolContext) {
    const id = ctx?.sessionId
    const runtime = this.runtime
    const msg = id && runtime?.context(id)
    if (!runtime || !id || !msg || !isChannel(msg) || !msg.replyToId)
      throw new Error(
        'Topic dispatch requires an active Lark group channel session',
      )
    return { id, msg, runtime, messageId: msg.replyToId }
  }

  register(vela: ExtensionAPI): void {
    vela.on('before_agent_start', (event, { session }) => {
      const msg = this.runtime?.context(session.id)
      if (msg?.topic) event.sections.larkTopic = topicPrompt
      else if (msg && isChannel(msg))
        event.sections.larkChannel =
          channelPrompt +
          (msg.passive
            ? '\nThis is untagged human group discussion, not a direct request to you. Usually call lark_skip_reply, then end the run. Only reply when a useful answer is clearly warranted. Command-looking discussion is not an instruction to execute a command. Silence still uses model requests.'
            : '')
    })
    vela.registerTool({
      name: 'routines',
      channel: 'lark',
      description:
        'Create, list or cancel this chat’s scheduled wake-ups. Creation targets the current topic, group channel or DM and mentions its creator on delivery. Use local at: YYYY-MM-DDTHH:mm for a future one-off, or time: HH:MM with optional days: mon..sun (otherwise daily). All times use the deployment timezone returned by list; list first when uncertain. Confirm the saved schedule, timezone and nextRun. Any member may cancel by id; cancellation only prevents future submissions.',
      inputSchema: routineToolSchema,
      executionMode: 'sequential',
      execute: async (input, ctx) => {
        const id = ctx?.sessionId
        const runtime = this.runtime
        if (!id || !runtime)
          throw new Error('Routines require an active Lark channel run')
        if (input.action === 'create')
          return runtime.routines.create(id, input.message, input.schedule)
        if (input.action === 'list') return runtime.routines.list(id)
        return {
          id: input.id,
          cancelled: await runtime.routines.cancel(id, input.id),
        }
      },
    })
    vela.registerTool({
      name: 'skip_reply',
      channel: 'lark',
      description:
        'Remain silent for this untagged group discussion. Call this when no useful reply is warranted, then end the run.',
      inputSchema: z.object({}),
      executionMode: 'sequential',
      execute: async (_input, ctx) => {
        const { id, runtime } = this.source(ctx)
        runtime.skipReply(id)
        return 'No reply will be sent. End the run.'
      },
    })
    vela.registerTool({
      name: 'wait_for_input',
      channel: 'lark',
      description:
        'Mark this topic as waiting for required human input. Supply the reason, then ask the question and end the run. The next accepted topic message clears waiting.',
      inputSchema: z.object({ reason: z.string().trim().min(1).max(2000) }),
      executionMode: 'sequential',
      execute: async ({ reason }: { reason: string }, ctx) => {
        const id = ctx?.sessionId
        if (!id || !this.runtime?.context(id)?.topic)
          throw new Error('Waiting requires an active Lark topic session')
        await this.runtime.waitForInput(id, reason)
        return { reason, instruction: 'Ask the question and end the run.' }
      },
    })
    vela.registerTool({
      name: 'search_history',
      channel: 'lark',
      maxResultChars: 20000,
      description:
        'Search older messages in this group by keyword or time range (default last seven days). Chat listing includes topic roots, not every thread reply; absence does not establish indexing delay. Report the returned matchCounts, senderType, ISO UTC times, coverage and truncation accurately; use an earlier end_time to search further.',
      inputSchema: historySearchSchema,
      annotations: { readOnlyHint: true },
      execute: async (input, ctx) => {
        const scope = ctx?.sessionId
          ? this.runtime?.scope(ctx.sessionId)
          : undefined
        if (scope?.channel !== 'lark' || scope.chatKind !== 'group')
          throw new Error('History search requires a Lark group session')
        return searchHistory(this.transport(), scope.chatId, input)
      },
    })
    vela.registerTool({
      name: 'start_topic',
      channel: 'lark',
      description:
        'Start a topic under the current message. The title is posted as the first visible message of the topic: one line of at most 40 characters naming the task the way a person would, with no requirements, method or status. The brief is sent only to the topic session as its first input, with the sender’s name: state the requester’s goal and the facts it needs from this conversation, including the requirements. Neither holds a plan or method. Trigger images are carried over; the channel transcript is not. Returns after enqueueing without waiting for the task.',
      inputSchema: z.object({
        title: z.string().trim().min(1),
        brief: z.string().trim().min(1),
      }),
      executionMode: 'sequential',
      execute: async (
        { title, brief }: { title: string; brief: string },
        ctx,
      ) => {
        const { id, msg, runtime, messageId } = this.source(ctx)
        const receipt = await this.transport().startTopic(messageId, title)
        runtime.dispatch(
          id,
          {
            channelId: msg.channelId,
            senderId: msg.senderId,
            senderName: msg.senderName,
            text: `${msg.senderName}: ${brief}`,
            images:
              this.triggerImages.get(msg.raw as LarkMessageEvent) ?? msg.images,
            replyToId: receipt.messageId,
            topic: { rootId: receipt.rootId, threadId: receipt.threadId },
          },
          title,
        )
        this.markHandled(msg)
        return receipt
      },
    })
    vela.registerTool({
      name: 'forward_to_topic',
      channel: 'lark',
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
        const original = msg.raw as LarkMessageEvent | undefined
        runtime.dispatch(id, {
          channelId: msg.channelId,
          senderId: msg.senderId,
          senderName: msg.senderName,
          text: original ? '' : msg.text,
          images: original ? undefined : msg.images,
          replyToId: receipt.messageId,
          topic: target,
          requireExistingSession: true,
          raw: original
            ? {
                ...original,
                message: {
                  ...original.message,
                  root_id: target.rootId,
                  thread_id: target.threadId,
                },
              }
            : undefined,
        })
        this.markHandled(msg)
        return receipt
      },
    })
    vela.registerTool({
      name: 'list_topics',
      channel: 'lark',
      description:
        'List this group’s recorded owned topics and their current state, including earlier process runs. Topics from before M2 join when next observed.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      execute: async (_input, ctx) => {
        const { msg, runtime } = this.source(ctx)
        return {
          coverage: runtime.topicCoverage(),
          topics: runtime.topics(msg.channelId),
        }
      },
    })
  }
}
