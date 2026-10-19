/** A manually advanced scheduler clock; no wall-clock sleeps. */
export class RoutineClock {
  private time: number
  private sequence = 0
  private timers = new Map<number, { at: number; run: () => void }>()
  constructor(at = '2026-01-05T08:00:00Z') {
    this.time = Date.parse(at)
  }
  now = () => this.time
  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.sequence
    this.timers.set(id, { at: this.time + delay, run })
    return id
  }
  clearTimeout = (id: number) => {
    this.timers.delete(id)
  }
  advance(at: string): void {
    this.time = Date.parse(at)
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.time)
    for (const [id, timer] of due) {
      this.timers.delete(id)
      timer.run()
    }
  }
}
