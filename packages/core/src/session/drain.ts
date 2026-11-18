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
