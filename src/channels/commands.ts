import type { VelaSession } from '../vela-session.ts'
import type { ChannelDirectory } from './directory.ts'
import type { RunFeedback } from './feedback.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

export type TopicCommand = 'stop' | 'restart'

/** Match only a complete normalized topic message, before history or sender decoration. */
export function topicCommand(msg: IncomingMessage): TopicCommand | undefined {
  if (!msg.topic) return
  const text = msg.text.trim()
  if (text === '!stop') return 'stop'
  if (text === '!restart') return 'restart'
}

/** Called after the interrupted run has drained its normal delivery and finish path. */
export async function finishTopicCommand(
  command: TopicCommand,
  key: string,
  channel: ChannelDefinition,
  msg: IncomingMessage,
  stopped: boolean,
  directory: ChannelDirectory,
  feedback: RunFeedback,
  session?: VelaSession,
): Promise<void> {
  const inputs = feedback.acknowledge(channel, msg)
  let outcome: 'done' | 'failed' = 'failed'
  try {
    await Promise.all(inputs.map((input) => input.ready))
    let text = stopped ? '' : 'No run is currently active.'
    if (command === 'restart') {
      // Save before closing: a save failure must retain the old live session.
      await session?.save()
      await session?.close()
      directory.observe(key, channel.name, msg)
      await directory.restart(key)
      text = 'Restarted with a fresh session'
    }
    if (text) await channel.send({ ...msg, recipientId: msg.senderId, text })
    await directory.forget(key, msg.replyToId ? [msg.replyToId] : [])
    outcome = 'done'
  } finally {
    await Promise.all(inputs.map((input) => input.finish(outcome)))
  }
}
