/** Tracks command lifetimes and hostless result deliveries outside the current turn. */
export class SessionWork {
  private readonly running = new Set<Promise<unknown>>()
  private held?: (() => Promise<void>)[]

  constructor(readonly unattended: boolean) {}

  get active(): boolean {
    return this.running.size > 0
  }

  track(work: Promise<unknown>): void {
    this.running.add(work)
    void work.catch(() => {}).finally(() => this.running.delete(work))
  }

  /** Text print mode keeps result turns separate from the explicit prompts it prints. */
  holdDeliveries(): void {
    this.held = []
  }

  deliver(send: () => Promise<void>): void {
    if (this.held) this.held.push(send)
    else this.track(send())
  }

  discardHeld(): void {
    this.held = undefined
  }

  async settle(waitForIdle: () => Promise<void>): Promise<void> {
    const held = this.held
    this.discardHeld()
    for (const send of held ?? []) this.deliver(send)
    while (this.active) {
      await Promise.allSettled(this.running)
      await waitForIdle()
    }
  }
}
