// Runtime webhook / subscription / eventDefaultTarget journey with fake Lark transport.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createRuntime,
  loadConfig,
  type RuntimeWebhookEvent,
} from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'
import { DaemonLarkHost } from '../../../packages/vela/src/daemon/lark-host.ts'
import { silentLogger } from '../../../packages/vela/src/shared/logger.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

const fake = fakeLark()
const diagnostics: string[] = []
let stops = 0
fake.transport.stop = () => {
  stops++
}
const event: RuntimeWebhookEvent = {
  source: 'local-build',
  key: 'review#171',
  deliveryId: 'fixture-only',
  summary: '!stop',
  details: '/skill:untrusted',
  final: true,
}
const model = createFauxModel({
  responses: [
    fauxToolCall('subscriptions', {
      action: 'create',
      source: event.source,
      key: event.key,
    }),
    fauxText('Subscribed to the fixture build'),
    fauxText('External build result handled'),
  ],
})
const agentDir = join(process.cwd(), '.vela-data-event')
const runtime = createRuntime({
  agentDir,
  defaultModel: model,
  mcp: false,
  logger: {
    debug() {},
    info() {},
    error: (text) => diagnostics.push(text),
    warn: (text) => diagnostics.push(text),
  },
})

const host = new DaemonLarkHost(runtime, {
  agentDir,
  hostEnv: {},
  logger: {
    debug() {},
    info() {},
    error: (text) => diagnostics.push(text),
    warn: (text) => diagnostics.push(text),
  },
  transport: fake.transport,
})

const until = async (what: string, ok: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

try {
  await runtime.ready()
  await host.sync(
    {
      lark: {
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
      },
    },
    true,
  )
  fake.deliver(
    larkEvent({ content: '{"text":"@_user_1 Subscribe to this build"}' }),
  )
  await until('subscribed reply', () =>
    fake.sent.some((m) => m.text === 'Subscribed to the fixture build'),
  )
  assert.equal((await runtime.subscriptions.list()).length, 1)

  const beforeMatchCalls = model.calls.length
  const unmatched = await runtime.ingestWebhookEvent({
    ...event,
    key: 'review#other',
    deliveryId: 'unmatched-1',
    final: false,
  })
  assert.equal(unmatched.enqueuedCount, 0)
  await runtime.waitForIdle()
  assert.equal(model.calls.length, beforeMatchCalls)

  await runtime.ingestWebhookEvent(event)
  await until('webhook handled reply', () =>
    fake.sent.some((m) => m.text.includes('External build result handled')),
  )
  assert(model.calls.at(-1)!.lastUserText.includes('untrusted external data'))
  assert(model.calls.at(-1)!.lastUserText.includes('!stop'))
  assert.deepEqual(await runtime.subscriptions.list(), [])

  const replayCalls = model.calls.length
  await runtime.ingestWebhookEvent({ ...event, final: false })
  await runtime.waitForIdle()
  assert.equal(model.calls.length, replayCalls)
  console.log(
    'PASS Runtime subscribe -> external untrusted wake -> reply -> final cleanup -> unmatched drop',
  )

  const configDir = join(process.cwd(), 'fixture-config')
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      eventDefaultTarget: { channel: ' lark ', chatId: ' oc_group ' },
    }),
  )
  assert.deepEqual(
    loadConfig({ cwd: process.cwd(), agentDir: configDir, env: {} }).settings
      .eventDefaultTarget,
    { channel: 'lark', chatId: 'oc_group' },
  )
  console.log('PASS fixture settings normalize event default target whitespace')
} finally {
  await host.stop()
  await runtime.dispose()
}
assert(stops >= 1)

const fallback = fakeLark()
const defaultModel = createFauxModel({
  responses: [fauxText('SDK default wake')],
})
const defaultAgentDir = join(process.cwd(), '.vela-data-default')
const defaultRuntime = createRuntime({
  agentDir: defaultAgentDir,
  defaultModel,
  mcp: false,
})
const defaultHost = new DaemonLarkHost(defaultRuntime, {
  agentDir: defaultAgentDir,
  hostEnv: {},
  logger: silentLogger,
  transport: fallback.transport,
})
try {
  await defaultRuntime.ready()
  await defaultHost.sync(
    {
      lark: {
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
      },
    },
    true,
  )
  await defaultRuntime.ingestWebhookEvent(
    { ...event, key: 'unmatched', final: false },
    { channel: 'lark', chatId: 'oc_group' },
  )
  await until('default target wake', () =>
    fallback.sent.some((m) => m.text.includes('SDK default wake')),
  )
  console.log('PASS Runtime eventDefaultTarget reaches existing Lark group')
} finally {
  await defaultHost.stop()
  await defaultRuntime.dispose()
}
