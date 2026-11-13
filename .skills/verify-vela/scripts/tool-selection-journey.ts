// Run through verify-vela exec in its isolated workspace. Only the model is faux;
// the SDK, example confirmation hook, supplied UI, tool selection and file side effects are real.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import confirmDangerous from '../../../examples/extensions/confirm-dangerous.ts'

for (const mode of ['headless', 'accept', 'decline'] as const) {
  const cwd = join(process.cwd(), mode)
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'junk.txt'), 'keep me')
  const asked: string[] = []
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'rm junk.txt' }),
      (r) => fauxText(r.toolResults[0]!.output),
    ],
  })
  const vela = createVela({
    cwd,
    dataDir: join(cwd, 'data'),
    model,
    extensions: [confirmDangerous],
  })
  try {
    const session = vela.session(
      mode,
      mode === 'headless'
        ? {}
        : {
            ui: {
              notify() {},
              select: async () => undefined,
              input: async () => undefined,
              confirm: async (title, text) => {
                asked.push(`${title}: ${text}`)
                return mode === 'accept'
              },
            },
          },
    )
    await session.prompt('Delete junk.txt')
    const output = model.calls[1]!.toolResults[0]!.output
    const exists = existsSync(join(cwd, 'junk.txt'))
    if (exists !== (mode !== 'accept'))
      throw new Error(`${mode}: unexpected file side effect`)
    if (
      mode === 'headless' &&
      (!output.includes('no UI for confirmation') || asked.length)
    )
      throw new Error('Headless reason missing')
    if (mode !== 'headless' && asked.join('') !== 'Delete files?: rm junk.txt')
      throw new Error('Supplied UI not used')
    if (
      mode === 'decline' &&
      !output.includes('User did not allow the deletion')
    )
      throw new Error('Decline reason missing')
    console.log(JSON.stringify({ mode, asked, exists, output }))
  } finally {
    await vela.dispose()
  }
}
for (const tools of [['read_file'], ['-bash']] as string[][]) {
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'echo blocked' }),
      (r) => fauxText(r.toolResults[0]!.output),
    ],
  })
  const vela = createVela({ cwd: process.cwd(), model })
  try {
    const session = vela.session('selection', { tools })
    await session.prompt('Run echo')
    if (model.calls[0]!.tools.includes('bash'))
      throw new Error('Unavailable bash reached model')
    const result = model.calls[1]!.toolResults[0]!.output
    if (!result.includes("unavailable tool 'bash'"))
      throw new Error('Unavailable bash not rejected')
    console.log(
      JSON.stringify({ tools, active: session.getActiveTools(), result }),
    )
  } finally {
    await vela.dispose()
  }
}
console.log('SDK confirmation and tool selection journey passed')
