// Run through verify-vela exec in its isolated workspace. Only the model is faux;
// the SDK, example blocking hook, tool selection and file side effects are real.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
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
  const runtime = createRuntime({
    ephemeral: true,
    agentDir: join(cwd, 'agent'),
    defaultModel: model,
    extensions: [confirmDangerous],
    mcp: false,
    trustOverride: () => true,
  })
  try {
    await runtime.ready()
    const project = await runtime.projects.create({
      name: 'BlockedHook',
      cwd,
      hubSessionId: true,
    })
    const sessionId = project.hubSessionId!
    await runtime.prompt(sessionId, { text: 'Delete junk.txt' })
    await runtime.waitForIdle(sessionId)
    const output = model.calls[1]!.toolResults[0]!.output
    const exists = existsSync(join(cwd, 'junk.txt'))
    if (!exists) throw new Error('blocked-hook: unexpected file side effect')
    if (!output.includes('Deletion blocked by confirm-dangerous extension'))
      throw new Error(`Blocked reason missing: ${output}`)
    console.log(JSON.stringify({ mode: 'blocked-hook', exists, output }))
  } finally {
    await runtime.dispose()
  }
}
for (const tools of [['read'], ['-bash']] as string[][]) {
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'echo blocked' }),
      (r) => fauxText(r.toolResults[0]!.output),
    ],
  })
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: model,
    mcp: false,
  })
  try {
    await runtime.ready()
    const session = await runtime.sessions.create({ name: 'selection' })
    await runtime.sessions.configure(session.id, {
      cwd: process.cwd(),
      tools,
      approve: true,
    })
    await runtime.prompt(session.id, { text: 'Run echo' })
    await runtime.waitForIdle(session.id)
    if (model.calls[0]!.tools.includes('bash'))
      throw new Error('Unavailable bash reached model')
    const result = model.calls[1]!.toolResults[0]!.output
    if (!result.includes("unavailable tool 'bash'"))
      throw new Error('Unavailable bash not rejected')
    const inspected = await runtime.sessions.inspect(session.id)
    console.log(
      JSON.stringify({ tools, active: inspected.activeTools, result }),
    )
  } finally {
    await runtime.dispose()
  }
}
console.log('SDK hook blocking and tool selection journey passed')
