import type { ChannelConnection } from '@glows777/vela-channels'
import { type LarkTransport, larkTransport } from './transport.ts'

type Listener = (connection: ChannelConnection) => void

/** Connection observations belong to one start lifetime, never a previous socket. */
export class LarkConnection {
  private lifetime = 0
  private connection: ChannelConnection = { connected: false }
  private readonly listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    this.notify(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(listener: Listener): void {
    try {
      listener({ ...this.connection })
    } catch {
      // Observers must not interrupt transport startup, teardown, or other observers.
    }
  }

  private report(connection: ChannelConnection): void {
    this.connection = { ...connection }
    for (const listener of this.listeners) this.notify(listener)
  }

  begin({
    appId,
    appSecret,
    transport: custom,
  }: {
    appId: string
    appSecret: string
    transport?: LarkTransport
  }) {
    const lifetime = ++this.lifetime
    this.report({ connected: false })
    const active = () => lifetime === this.lifetime
    const report = (connection: ChannelConnection) => {
      if (active()) this.report(connection)
    }
    const transport =
      custom ??
      (appId && appSecret
        ? larkTransport(appId, appSecret, false, undefined, undefined, report)
        : undefined)
    return { active, report, transport }
  }

  stop(): void {
    ++this.lifetime
    this.report({ connected: false })
  }
}
