// Run through verify-vela exec in its isolated workspace. Only the model is faux;
// the SDK, example blocking hook, tool selection and file side effects are real.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import confirmDangerous from '../../../examples/extensions/confirm-dangerous.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

{
  const cwd = join(process.cwd(), 'blocked-hook')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'junk.txt'), 'keep me')
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
    const session = vela.session('blocked-hook')
    await session.prompt('Delete junk.txt')
    const output = model.calls[1]!.toolResults[0]!.output
    const exists = existsSync(join(cwd, 'junk.txt'))
    if (!exists) throw new Error('blocked-hook: unexpected file side effect')
    if (!output.includes('Deletion blocked by confirm-dangerous extension'))
      throw new Error(`Blocked reason missing: ${output}`)
    console.log(JSON.stringify({ mode: 'blocked-hook', exists, output }))
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
console.log('SDK hook blocking and tool selection journey passed')
