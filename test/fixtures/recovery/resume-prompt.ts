import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createTestVela,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'

const [cwd, mode] = process.argv.slice(2) as [string, string]
const t = createTestVela({
  cwd,
  allowPendingResponses: true,
  dataDir: join(cwd, 'agent'),
  sessionId: 'resume-prompt',
  responses:
    mode === 'start'
      ? [
          fauxToolCall('bash', {
            command: 'echo first >> first-count; printf FINISHED_FIRST',
          }),
          fauxToolCall('bash', {
            command:
              'echo started >> sideeffects; echo $$ > bash.pid; while [ ! -f release-bash ]; do sleep 0.1; done; echo finished > finished',
          }),
        ]
      : [
          (request) => {
            writeFileSync(join(cwd, 'request.json'), JSON.stringify(request))
            return fauxText('RECOVERED')
          },
        ],
})
const keepAlive = setInterval(() => {}, 1000)
try {
  if (mode === 'start') {
    void t.session.prompt('Run the commands once')
    while (!existsSync(join(cwd, 'bash.pid'))) await Bun.sleep(5)
    console.log('CRASH_READY')
    await new Promise(() => {})
  } else {
    if (!(await t.session.resume())) throw new Error('Session missing')
    if (mode === 'historical') {
      let failure: unknown
      try {
        await t.session.prompt('A new follow-up that must not be appended')
      } catch (error) {
        failure = error
      }
      writeFileSync(
        join(cwd, 'rejection.json'),
        JSON.stringify({
          error: failure instanceof Error ? failure.message : String(failure),
          modelCalls: t.model.calls.length,
        }),
      )
      if (!failure)
        throw new Error('Corrupted history was unexpectedly accepted')
    } else await t.session.prompt('What happened? Do not repeat the commands.')
    await t.session.save()
    console.log('RECOVERED')
  }
} finally {
  clearInterval(keepAlive)
  await t.cleanup({ keepDir: true })
}
