// Offline #281 comparison: real eval worker and Lark entry, scripted model and transport.
// Run under verify-vela's isolated HOME/VELA_DIR. Never uses a live provider.
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    runtime: { type: 'string' },
    output: { type: 'string' },
    prefix: { type: 'string' },
  },
  strict: true,
})
if (
  !values.runtime ||
  !values.output ||
  !['lark', 'channel'].includes(values.prefix ?? '')
)
  throw new Error(
    'Usage: bun dispatch-rename-eval.ts --runtime <checkout> --output <new-directory> --prefix lark|channel',
  )
const runtime = resolve(values.runtime)
const output = resolve(values.output)
const prefix = values.prefix!
// Require a fresh directory, so reruns cannot resume or overwrite old evidence.
await mkdir(output)
const {
  runAttempt,
  command,
}: typeof import('../../../scripts/eval/worker.ts') = await import(
  pathToFileURL(join(runtime, 'scripts/eval/worker.ts')).href
)
const {
  createFauxModel,
  fauxText,
  fauxToolCall,
}: typeof import('../../../packages/core/src/testing/faux.ts') = await import(
  pathToFileURL(join(runtime, 'packages/core/src/testing/faux.ts')).href
)
const attempts = []
for (const scenario of ['G1', 'G2', 'G3', 'G4', 'G5'] as const) {
  const cwd = join(output, scenario, 'work')
  await mkdir(cwd, { recursive: true })
  for (const args of [
    ['git', 'init', '-q'],
    [
      'git',
      '-c',
      'user.name=Eval test',
      '-c',
      'user.email=eval@localhost',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
  ]) {
    const result = await command(cwd, args)
    if (!result.ok)
      throw new Error(`Fixture preparation failed: ${result.text}`)
  }
  const responses = {
    G1: [fauxText('14:30 UTC.')],
    G2: [
      fauxToolCall(`${prefix}_start_topic`, {
        title: 'Launch brief',
        brief:
          'launch on 12 November; cap spending at 700 credits; assign the owner to Morgan.',
      }),
      fauxText(''),
      fauxText('Launch brief prepared.'),
    ],
    G3: [fauxToolCall(`${prefix}_skip_reply`, {}), fauxText('')],
    G4: [
      fauxToolCall(`${prefix}_wait_for_input`, {
        reason: 'Choose blue or green',
      }),
      fauxText('Blue or green?'),
    ],
    G5: [fauxText('You’re welcome.')],
  }[scenario]
  const model = createFauxModel({ responses })
  const result = await runAttempt(
    {
      runtime,
      cwd,
      artifactDir: join(output, scenario, 'artifacts'),
      scenario,
      arm: 'new',
      run: 1,
      attempt: 1,
      thinking: 'off',
    },
    undefined,
    model,
  )
  // Worker usage is synthetic for injected models, never provider billing.
  await Bun.write(
    join(output, scenario, 'requests.json'),
    JSON.stringify(model.calls, null, 2),
  )
  attempts.push(result)
  console.log(
    scenario,
    result.status,
    JSON.stringify(result.checks),
    'calls',
    result.toolCalls,
  )
}
await Bun.write(
  join(output, 'results.json'),
  JSON.stringify(
    {
      mode: 'offline scripted faux, not live-model validation',
      thinking: 'off',
      prefix,
      attempts,
    },
    null,
    2,
  ),
)
if (attempts.some((result) => result.status !== 'pass')) process.exitCode = 1
