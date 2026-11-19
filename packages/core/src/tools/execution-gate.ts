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

/** Sequential nested calls serialize without reacquiring their parent's gate. */
export class NestedExecutionGate {
  /** Sequential nested calls run one at a time (like pi's nested call queue) */
  private nestedTail: Promise<void> = Promise.resolve()
  /** Nested calls running while holding that queue: their own nested calls don't wait for it again */
  private readonly nestedHolders = new Set<string>()

  async run<T>(
    mode: ToolExecutionMode,
    parentToolCallId: string,
    toolCallId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const holds = this.nestedHolders.has(parentToolCallId)
    const exclusive = mode === 'sequential' && !holds
    let release: (() => void) | undefined
    if (exclusive) {
      const previous = this.nestedTail
      this.nestedTail = new Promise((resolve) => {
        release = resolve
      })
      await previous
    }
    if ((holds || exclusive) && toolCallId) this.nestedHolders.add(toolCallId)
    try {
      return await fn()
    } finally {
      if (toolCallId) this.nestedHolders.delete(toolCallId)
      release?.()
    }
  }
}

/** Tracks active tool calls from model, host and nested dispatch until their records settle. */
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
