import type { ToolExecutionMode } from './types.ts'

/**
 * One session's tool calls: parallel calls run together; a sequential call waits for the calls
 * started before it and holds back the calls started after it (first come, first served).
 */
export class ExecutionGate {
  private barrier: Promise<void> = Promise.resolve()
  private readonly running = new Set<Promise<unknown>>()

  async run<T>(mode: ToolExecutionMode, fn: () => Promise<T>): Promise<T> {
    if (mode === 'parallel') {
      await this.barrier
      const job = fn()
      this.running.add(job)
      try {
        return await job
      } finally {
        this.running.delete(job)
      }
    }
    const previous = this.barrier
    let release!: () => void
    this.barrier = new Promise((resolve) => {
      release = resolve
    })
    try {
      await previous
      await Promise.allSettled([...this.running])
      return await fn()
    } finally {
      release()
    }
  }
}

/** Tracks active tool calls from model and host dispatch until their records settle. */
export class ActiveCalls {
  private readonly active = new Set<Promise<unknown>>()

  track<T>(run: () => Promise<T>): Promise<T> {
    const job = run()
    this.active.add(job)
    void job.then(
      () => this.active.delete(job),
      () => this.active.delete(job),
    )
    return job
  }

  get running(): boolean {
    return this.active.size > 0
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active])
  }
}
