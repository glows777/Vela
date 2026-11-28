// Offline drive of the channel prompt cache: one group session woken by a person's message, untagged
// discussion, a host note and a person again must send the same system prompt, and each wake must read
// the prefix back. The Runtime, Lark adapter and usage ledger are real; only the model and transport are fake.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '@glows777/vela/testing'
import { DaemonLarkHost } from '../../../packages/vela/src/daemon/lark-host.ts'
import { openDatabase } from '../../../packages/vela/src/db/sqlite.ts'
import { silentLogger } from '../../../packages/vela/src/shared/logger.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

const PASSIVE_PREFIX = '[Passive group message from '
const failed: string[] = []
/** Print one check; a false `ok` marks it FAIL and makes the script exit 1. */
function check(label: string, ok: boolean) {
  console.log(`${ok ? '' : 'FAIL '}${label}: ${ok}`)
  if (!ok) failed.push(label)
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
async function until(what: string, ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await sleep(10)
  }
}

// A text answer ends the run; an untagged passive wake calls skip_reply and stays silent.
const router = (req: FauxRequest): FauxResponse => {
  if (req.toolResults.some((r) => r.toolName === 'skip_reply')) {
    return { text: '' }
  }
  if (req.lastUserText.startsWith(PASSIVE_PREFIX)) {
    return { toolCalls: [{ name: 'skip_reply', input: {} }] }
  }
  return { text: `ok: ${req.lastUserText.slice(-30)}` }
}

const fake = fakeLark()
const model = createFauxModel({
  cache: true,
  responses: Array.from({ length: 20 }, () => router),
})
const agentDir = join(process.cwd(), '.vela-data-wake-kind')
const runtime = createRuntime({
  agentDir,
  defaultModel: model,
  mcp: false,
})
const host = new DaemonLarkHost(runtime, {
  agentDir,
  hostEnv: {},
  logger: silentLogger,
  transport: fake.transport,
})
await runtime.ready()
await host.sync(
  {
    lark: {
      appId: 'bot',
      owners: ['ou_alice'],
      chats: [{ id: 'oc_group', readUntagged: true }],
    },
  },
  true,
)

// 1. A person addresses the bot
fake.deliver(larkEvent({ content: JSON.stringify({ text: '@_user_1 hello' }) }))
await until('person answered', () => fake.sent.length === 1)
await until('person request', () => model.calls.length === 1)

// 2. Untagged human discussion (calls skip_reply -> 2 model calls)
fake.deliver(
  larkEvent(
    { mentions: [], content: JSON.stringify({ text: 'the build is green' }) },
    'ou_bob',
  ),
)
await until('discussion evaluated', () => model.calls.length === 3)

// 3. A host-submitted message delivered through Runtime channel submit
const hubSession = (await runtime.sessions.list()).find(
  (s) => s.kind === 'hub',
)!
await runtime.channels.submit('lark', {
  chatId: 'oc_group',
  sessionId: hubSession.id,
  text: "Message from Vela's group session (not from a person):\nThe code is ORBIT-73",
  author: { id: 'ou_alice', name: 'Alice' },
})
await until('note evaluated', () => model.calls.length === 4)

// 4. A person again, after the passive marker is in history
fake.deliver(
  larkEvent({ content: JSON.stringify({ text: '@_user_1 ship it' }) }),
)
await until('second person answered', () => model.calls.length === 5)
await sleep(100)

const hash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 12)
const section = (system: string) =>
  system.slice(
    system.indexOf('<projectSession>'),
    system.indexOf('</channelGuide>'),
  )
for (const call of model.calls)
  console.log(
    `request ${call.index}: system=${hash(call.system)} section=${section(call.system).length} chars input=${JSON.stringify(call.lastUserText.split('\n')[0]!.slice(0, 70))}`,
  )

check(
  'system prompt byte-identical',
  model.calls.every((call) => call.system === model.calls[0]!.system),
)
check(
  'untagged input carries its marker',
  model.calls[1]!.lastUserText.startsWith(PASSIVE_PREFIX),
)
check(
  'note keeps its text',
  model.calls[3]!.lastUserText.includes("Message from Vela's group session"),
)
check(
  'later person message has no passive marker',
  !model.calls[4]!.lastUserText.includes(PASSIVE_PREFIX),
)

const dbPath = join(agentDir, 'vela.db')
if (!existsSync(dbPath)) check('usage ledger written', false)
else {
  const db = openDatabase({ path: dbPath, readonly: true })
  const wakes = db
    .all<{
      inputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }>(
      'SELECT input_tokens AS inputTokens, cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens FROM usage_records ORDER BY rowid DESC LIMIT 5',
    )
    .reverse()
  db.close()
  if (!wakes.length) check('usage ledger written', false)
  else {
    for (const wake of wakes)
      console.log(
        `wake: input=${wake.inputTokens} cacheRead=${wake.cacheReadTokens} cacheWrite=${wake.cacheWriteTokens}`,
      )
    check(
      'every wake after the first reads the previous prefix',
      wakes
        .slice(1)
        .every(
          (wake, index) =>
            wake.cacheReadTokens >= wakes[index]!.cacheWriteTokens - 1,
        ),
    )
  }
}

await host.stop()
await runtime.dispose()
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
if (failed.length) process.exit(1)
