import { readFauxScenario } from './faux.ts'
import {
  createTestVela,
  type TestVela,
  type TestVelaOptions,
} from './test-vela.ts'

export interface ReplayResult {
  t: TestVela
  /** Error thrown by prompt() for each input (undefined if none), in `inputs` order */
  errors: unknown[]
}

/**
 * Replays a recorded scenario (the JSON written by `VELA_RECORD=<file>`) offline:
 * builds a faux model from the scenario's responses and prompts each of `inputs` in order
 * in the default session. The returned `t` is the same as createTestVela()'s, so you can
 * keep asserting on events, messages and files on disk.
 */
export async function replayScenario(
  path: string,
  options: Omit<TestVelaOptions, 'responses' | 'generate' | 'model'> = {},
): Promise<ReplayResult> {
  const scenario = await readFauxScenario(path)
  if (!scenario.inputs?.length)
    throw new Error(`replayScenario: ${path} has no inputs to replay`)
  const { inputs, responses, generate, ...fauxOptions } = scenario
  const t = createTestVela({
    ...options,
    responses,
    generate,
    faux: { ...fauxOptions, ...options.faux },
  })
  const errors: unknown[] = []
  for (const input of inputs) {
    errors.push(
      await t.run(input).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
  }
  return { t, errors }
}
