import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestVela } from '@glows777/vela/testing'
import { runServe } from '../../../packages/vela/src/cli/serve.ts'
import { lark } from '../../../packages/vela/src/lark/index.ts'
import { fauxText } from '../../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../../support/lark.ts'

const cwd = process.argv[2]!
const fake = fakeLark()
const report = (name: string, value: unknown) =>
  writeFileSync(join(cwd, name), JSON.stringify(value))
const t = createTestVela({
  cwd,
  responses: [
    () => {
      report('forbidden-model.json', true)
      return fauxText('Must not run after shutdown')
    },
  ],
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
await t.vela.ready()
// Hold the real session-resume boundary after admission but before RunFeedback.active.
const open = t.vela.session.bind(t.vela)
t.vela.session = (...args) => {
  const session = open(...args)
  const resume = session.resume.bind(session)
  session.resume = async (...options) => {
    report('preparation-started.json', true)
    while (!existsSync(join(cwd, 'release'))) await Bun.sleep(10)
    return resume(...options)
  }
  return session
}
const serving = runServe({
  vela: t.vela,
  write: (line) => appendFileSync(join(cwd, 'serve.log'), `${line}\n`),
})
while (!t.vela.runningChannels().length) await Bun.sleep(5)
fake.deliver(
  larkEvent({
    message_id: 'held-preparation',
    root_id: 'root',
    thread_id: 'thread',
    content: JSON.stringify({ text: 'Original pending task' }),
  }),
)
const code = await serving
await t.vela.dispose()
report('model-calls.json', t.model.calls)
process.exit(code)
