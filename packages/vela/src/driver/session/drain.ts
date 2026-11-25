/** Wait without aborting execution; the owner applies its bounded shutdown deadline. */
export async function waitForDrain(
  session: {
    waitForIdle(): Promise<void>
    registry: { waitForIdle(): Promise<void> }
    save(): Promise<void>
  },
  bash: Promise<unknown> | undefined,
): Promise<void> {
  await session.waitForIdle()
  await bash?.catch(() => {})
  await session.registry.waitForIdle()
  await session.save()
}

export async function shutdownSession(opts: {
  abortBash(): void
  abort(reason: unknown): void
  commands: Iterable<Promise<void>>
  running: Promise<void> | undefined
  bashRunning: Promise<unknown> | undefined
  waitForRegistry(): Promise<void>
  started: Promise<void> | undefined
  onShutdown: () => Promise<void>
  save(): Promise<void>
  release(): void
  onClose(): void | Promise<void>
}): Promise<void> {
  opts.abortBash()
  opts.abort(new DOMException('Session closed', 'AbortError'))
  // Let extension commands finish first (commands like /dream wait on the prompt they started)
  await Promise.allSettled(opts.commands)
  await opts.running
  // A cancelled `!` command still records itself; wait for that before the final save
  await opts.bashRunning?.catch(() => {})
  await opts.waitForRegistry().catch(() => {})
  const errors: unknown[] = []
  // Only sessions that fired session_start emit session_shutdown.
  if (opts.started) {
    await opts.started.catch(() => {})
    try {
      await opts.onShutdown()
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    await opts.save()
  } catch (error) {
    errors.push(error)
  } finally {
    opts.release()
    await opts.onClose()
  }
  if (errors.length) throw new AggregateError(errors, 'Session shutdown failed')
}
