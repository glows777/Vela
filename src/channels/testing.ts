import { type ChannelVela, channelInternals } from './vela.ts'

/** Testing only: replies/feedback and queues created by a handoff must settle too. */
export async function drainChannels(vela: ChannelVela): Promise<void> {
  const gateway = channelInternals(vela) as unknown as {
    queues: Map<string, Promise<void>>
  }
  while (gateway.queues.size) await Promise.all([...gateway.queues.values()])
}
