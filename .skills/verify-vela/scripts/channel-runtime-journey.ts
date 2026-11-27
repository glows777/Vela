// Public Runtime acceptance: only the model and channel transport are fake.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelOutboundMessage,
  createRuntime,
} from '@glows777/vela'
import {
  createFauxModel,
  fauxHang,
  fauxText,
} from '../../../packages/vela/src/testing/core/index.ts'

let fixtureCtx!: ChannelAdapterContext
let otherCtx!: ChannelAdapterContext
const sent: ChannelOutboundMessage[] = []

function makeAdapter(
  name: string,
  setCtx: (ctx: ChannelAdapterContext) => void,
): ChannelAdapter {
  return {
    name,
    async start(ctx) {
      setCtx(ctx)
    },
    async stop() {},
    async deliver(message) {
      sent.push(message)
      return {
        externalMessageId: `${name}_out_${sent.length}`,
        ...(message.kind === 'topic_start'
          ? { threadId: `thread_${sent.length}`, rootId: `root_${sent.length}` }
          : {}),
      }
    },
  }
}

const model = createFauxModel({
  responses: [
    fauxHang(),
    fauxText('later message completed'),
    fauxText('topic result'),
  ],
})
const dataDir = process.env.VELA_DIR
assert.ok(dataDir, 'Run through the isolated verify-vela helper')
const runtime = createRuntime({
  agentDir: join(dataDir, 'runtime'),
  cwd: process.cwd(),
  defaultModel: model,
  mcp: false,
})
async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Runtime journey timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

try {
  await runtime.ready()
  const p1 = await runtime.projects.create({
    name: 'project',
    cwd: process.cwd(),
    hubSessionId: true,
  })
  await runtime.bindings.upsert({
    channel: 'fixture',
    externalId: 'project',
    threadId: null,
    kind: 'group',
    projectId: p1.id,
    enabled: true,
  })
  const p2 = await runtime.projects.create({
    name: 'other-project',
    cwd: process.cwd(),
    hubSessionId: true,
  })
  await runtime.bindings.upsert({
    channel: 'other',
    externalId: 'other-project',
    threadId: null,
    kind: 'group',
    projectId: p2.id,
    enabled: true,
  })
  await runtime.registerChannel(
    makeAdapter('fixture', (ctx) => {
      fixtureCtx = ctx
    }),
  )
  await runtime.registerChannel(
    makeAdapter('other', (ctx) => {
      otherCtx = ctx
    }),
  )

  // 1. Durable admission before model completion; hold run, queue second input, then stop active run
  const admitted = await fixtureCtx.ingestWithReceipt!({
    channel: 'fixture',
    dedupeKey: 'held-1',
    externalChatId: 'project',
    kind: 'group',
    senderId: 'owner',
    senderName: 'Owner',
    text: 'held run',
    timestamp: new Date().toISOString(),
  })
  assert.equal(admitted.admitted, true)
  assert.ok(admitted.sessionId)
  const storedSession = await runtime.sessions.get(admitted.sessionId)
  assert.equal(storedSession?.kind, 'hub')
  console.log('ingest acknowledged durable admission before model completion')

  await until(() => model.calls.length === 1)
  await fixtureCtx.ingestWithReceipt!({
    channel: 'fixture',
    dedupeKey: 'later-1',
    externalChatId: 'project',
    kind: 'group',
    senderId: 'owner',
    senderName: 'Owner',
    text: 'later queued input',
    timestamp: new Date().toISOString(),
  })
  assert.equal(await runtime.stop(admitted.sessionId, 'journey-stop'), true)
  await until(() =>
    sent.some((message) => message.text === 'later message completed'),
  )
  assert.equal(model.calls.length, 2)
  assert.equal(await runtime.stop(admitted.sessionId, 'stale-stop'), false)
  console.log('Stop preserves later queued input and rejects stale stop')

  // 2. Separate channel isolation & direct topic wake without extra hub model turn
  const otherReceipt = await otherCtx.ingestWithReceipt!({
    channel: 'other',
    dedupeKey: 'other-topic-1',
    externalChatId: 'other-project',
    kind: 'group',
    threadId: 'task-thread',
    threadRootId: 'task-root',
    senderId: 'owner',
    senderName: 'Owner',
    text: 'Topic task',
    timestamp: new Date().toISOString(),
  })
  assert.equal(otherReceipt.admitted, true)
  assert.notEqual(otherReceipt.sessionId, admitted.sessionId)
  await until(() => sent.some((message) => message.text === 'topic result'))
  assert.equal(model.calls.length, 3)
  assert.equal(model.pending(), 0)
  console.log(
    'channel isolation and topic delivery verified without extra turn',
  )
  console.log('DONE')
} finally {
  await runtime.dispose()
}
