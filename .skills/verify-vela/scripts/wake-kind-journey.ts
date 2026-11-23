// Offline drive of the channel prompt cache: one group session woken by a person's message, untagged
// discussion, a note and a person again must send the same system prompt, and each wake must read the
// prefix back. The extension, gateway, Lark adapter and usage ledger are real; the model (faux, with
// prefix caching) and the transport are fake.
// Run from a verify-vela run:  $H exec $RUN wake bun $REPO/.skills/verify-vela/scripts/wake-kind-journey.ts
// It prints one line per check, marks failed checks FAIL and exits 1 if any failed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  type FauxRequest,
  type FauxResponse,
} from '@glows777/vela/testing'
import { lark } from '../../../packages/vela/src/lark/index.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

const UNTAGGED = '[untagged group discussion, not addressed to you]'
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

// A text answer ends the run; an untagged wake stays silent with no reply.
const router = (req: FauxRequest): FauxResponse =>
  req.lastUserText.startsWith(UNTAGGED)
    ? { text: '' }
    : { text: `ok: ${req.lastUserText.slice(-30)}` }

const fake = fakeLark()
const model = createFauxModel({
  cache: true,
  responses: Array.from({ length: 20 }, () => router),
})
const vela = createVela({
  dataDir: '.vela-data',
  model,
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
await vela.startChannels()

// 1. A person addresses the bot
fake.deliver(larkEvent({ content: JSON.stringify({ text: '@_user_1 hello' }) }))
await until('person answered', () => fake.sent.length === 1)
await until('person request', () => model.calls.length === 1)

// 2. Untagged human discussion
fake.deliver(
  larkEvent(
    { mentions: [], content: JSON.stringify({ text: 'the build is green' }) },
    'ou_bob',
  ),
)
await until('discussion evaluated', () => model.calls.length === 2)

// 3. A note from another Vela session, delivered through the SDK host
await vela.channel('lark')!.submit({
  channelId: 'oc_group',
  chatKind: 'group',
  senderId: 'ou_alice',
  senderName: 'Alice',
  text: "Message from Vela's group session (not from a person):\nThe code is ORBIT-73",
  replyToId: 'root_a',
  handoff: { id: 'note-1', from: 'group session', depth: 1 },
})
await until('note evaluated', () => model.calls.length === 3)

// 4. A person again, after the discussion marker is in the history
fake.deliver(
  larkEvent({ content: JSON.stringify({ text: '@_user_1 ship it' }) }),
)
await until('second person answered', () => model.calls.length === 4)
await sleep(100)

const hash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 12)
const section = (system: string) =>
  system.slice(
    system.indexOf('<channelGroup>'),
    system.indexOf('</channelGroup>'),
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
  model.calls[1]!.lastUserText.startsWith(`${UNTAGGED}\n`),
)
check(
  'note keeps its own prefix',
  model.calls[2]!.lastUserText.startsWith("Message from Vela's"),
)
check(
  'later person message has no marker',
  !model.calls[3]!.lastUserText.includes(UNTAGGED),
)

const ledgerPath = join('.vela-data', 'usage', 'requests.jsonl')
if (!existsSync(ledgerPath)) check('usage ledger written', false)
else {
  const wakes = readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .slice(-4)
    .map((line) => JSON.parse(line))
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

await vela.dispose()
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'DONE')
if (failed.length) process.exit(1)
