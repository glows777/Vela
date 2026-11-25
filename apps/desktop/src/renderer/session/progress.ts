/** The last stage a run reported, as the Local channel publishes it. */
export interface SessionProgress {
  stage: 'tool' | 'retry' | 'compaction'
  tool?: string
  state?: 'started' | 'finished' | 'failed'
}

/**
 * What a running session is doing right now, or `undefined` once that stage ended. A stage is a moment, not a
 * fact: the Local channel publishes its end (`state`), so a finished tool's name and a retry that already
 * resumed must not stay on screen next to the state word (#571).
 */
export function currentStage(
  progress: SessionProgress | undefined,
): string | undefined {
  if (!progress) return undefined
  if (progress.state === 'finished' || progress.state === 'failed')
    return undefined
  if (progress.stage === 'tool') return progress.tool
  if (progress.stage === 'retry') return 'Retrying'
  return undefined
}
