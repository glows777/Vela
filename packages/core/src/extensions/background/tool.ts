import z from 'zod'
import {
  type ToolContext,
  type ToolDefinition,
  ToolExecutionResult,
} from '../../extension-api.ts'
import type { BackgroundJobs } from './jobs.ts'

const idSchema = z
  .string()
  .trim()
  .min(1)
  .describe('The id returned by background_start, for example bg-1')

const startSchema = z
  .object({
    command: z.string().describe('Shell command to run in the background'),
  })
  .strict()

const outputSchema = z.object({ id: idSchema }).strict()

const stopSchema = z.object({ id: idSchema }).strict()

/** The snapshot as the model reads it: the tail and the exit state, never a file path. */
function snapshotText(
  snapshot: ReturnType<BackgroundJobs['snapshot']>,
): string {
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
  return `${snapshot.id} (${state}).\nOutput:\n${output}`
}

export function createBackgroundTools(
  jobs: (context: ToolContext | undefined) => BackgroundJobs,
): ToolDefinition[] {
  return [
    {
      name: 'start',
      description:
        'Start a shell command in the background and return at once with its id. Its output is delivered to this conversation when it exits; use background_output to read output so far or background_stop to end it. Same shell, working directory and authority as bash; the command dies with this session.',
      inputSchema: startSchema,
      // The tools ship off; a topic enables them, and a session can name them explicitly.
      activeByDefault: false,
      executionMode: 'sequential',
      annotations: { destructiveHint: true, openWorldHint: true },
      execute: async ({ command }: { command: string }, context) => {
        const { id, pid } = jobs(context).start(command)
        return new ToolExecutionResult(
          { id, ...(pid === undefined ? {} : { pid }) },
          `Started ${id}${pid === undefined ? '' : ` (pid ${pid})`}. Its output will arrive when it exits.`,
        )
      },
    },
    {
      name: 'output',
      description:
        'Read a background command’s output so far: the last 2000 lines or 50KB. An unknown id means it ended with a restart or session close.',
      inputSchema: outputSchema,
      activeByDefault: false,
      annotations: { readOnlyHint: true },
      execute: async ({ id }: { id: string }, context) => {
        const snapshot = jobs(context).snapshot(id)
        const { output, ...value } = snapshot
        return new ToolExecutionResult(value, snapshotText(snapshot))
      },
    },
    {
      name: 'stop',
      description:
        'Stop a background command: SIGTERM to its process group, SIGKILL shortly after. Returns its last output. An unknown id means it ended with a restart or session close.',
      inputSchema: stopSchema,
      activeByDefault: false,
      executionMode: 'sequential',
      annotations: { destructiveHint: true },
      execute: async ({ id }: { id: string }, context) => {
        const snapshot = await jobs(context).stop(id)
        const { output, ...value } = snapshot
        return new ToolExecutionResult(value, snapshotText(snapshot))
      },
    },
  ]
}
