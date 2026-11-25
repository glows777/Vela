import z from 'zod'
import {
  type ToolContext,
  type ToolDefinition,
  ToolExecutionResult,
} from '../../extension-api.ts'
import type {
  BackgroundCommands,
  BackgroundSnapshot,
} from '../../tools/background.ts'

const idSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'The id from the bash call that started the command, for example bg-1',
  )

const outputSchema = z.object({ id: idSchema }).strict()

const stopSchema = z.object({ id: idSchema }).strict()

/** The snapshot as the model reads it: the tail and the exit state, never a file path. */
function snapshotText(snapshot: BackgroundSnapshot): string {
  const state =
    snapshot.state === 'running'
      ? 'still running'
      : snapshot.stopped
        ? 'stopped'
        : snapshot.exitCode === undefined
          ? 'exited'
          : `exited with code ${snapshot.exitCode}`
  const output = snapshot.output
    ? `${snapshot.output}${snapshot.truncated ? '\n\n[Showing the last output only]' : ''}`
    : '(no output)'
  const fullOutput = snapshot.fullOutputPath
    ? `\nFull output: ${snapshot.fullOutputPath}`
    : ''
  return `${snapshot.id} (${state}).\nOutput:\n${output}${fullOutput}`
}

export function createBackgroundTools(
  commands: (context: ToolContext | undefined) => BackgroundCommands,
): ToolDefinition[] {
  return [
    {
      name: 'output',
      executionMode: 'parallel',
      description:
        'Read a background command’s output so far: the last 2000 lines or 50KB. An unknown id means its result was already delivered or returned by a stop, or it ended with a restart or session close.',
      inputSchema: outputSchema,
      annotations: { readOnlyHint: true },
      execute: async ({ id }: { id: string }, context) => {
        const snapshot = commands(context).snapshot(id)
        const { output, ...value } = snapshot
        return new ToolExecutionResult(value, snapshotText(snapshot))
      },
    },
    {
      name: 'stop',
      description:
        'Abort a background command through its execution environment. Returns its last output. An unknown id means its result was already delivered or returned by a stop, or it ended with a restart or session close.',
      inputSchema: stopSchema,
      executionMode: 'sequential',
      annotations: { destructiveHint: true },
      execute: async ({ id }: { id: string }, context) => {
        const snapshot = await commands(context).stop(id)
        const { output, ...value } = snapshot
        return new ToolExecutionResult(value, snapshotText(snapshot))
      },
    },
  ]
}
