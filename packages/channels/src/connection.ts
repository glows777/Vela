import type { VelaLogger } from '@glows777/vela-core/extension-api'
import type { ChannelConnection, ChannelDefinition } from './types.ts'

/** Informational only: no scheduling, replay or reconnect policy lives here. */
export class ChannelConnectionState {
  private value: ChannelConnection = { connected: false }
  private listeners = new Set<(value: ChannelConnection) => void>()
  private unsubscribe?: () => void
  private generation = 0

  constructor(
    private channel: ChannelDefinition,
    private logger: VelaLogger,
  ) {}

  get = (): ChannelConnection => ({ ...this.value })
  subscribe = (listener: (value: ChannelConnection) => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(value: ChannelConnection): void {
    const next = value.connected ? { connected: true } : { ...value }
    if (
      next.connected === this.value.connected &&
      next.error === this.value.error
    )
      return
    this.value = next
    for (const listener of this.listeners) {
      try {
        listener(this.get())
      } catch {
        this.logger.warn('[channels] Connection listener failed')
      }
    }
  }

  start(): void {
    this.unsubscribe?.()
    const generation = ++this.generation
    this.set({ connected: false })
    this.unsubscribe = this.channel.onConnection?.((value) => {
      if (generation === this.generation) this.set(value)
    })
  }

  started(started: boolean): void {
    if (!this.channel.onConnection || !started) this.set({ connected: started })
  }

  failed(): void {
    this.set({
      connected: false,
      error: this.value.error ?? 'Channel failed to start',
    })
  }

  clear(): void {
    ++this.generation
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.set({ connected: false })
    this.listeners.clear()
  }
}
