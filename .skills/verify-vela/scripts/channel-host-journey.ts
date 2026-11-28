// Isolated Runtime + DaemonLarkHost verification. Only the model and Lark transport are fake.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createRuntime } from '@glows777/vela'
import { DaemonLarkHost } from '../../../packages/vela/src/daemon/lark-host.ts'
import { silentLogger } from '../../../packages/vela/src/shared/logger.ts'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

async function until(check: () => boolean, label = 'condition') {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert(Date.now() < deadline, `timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const network = fakeLark()
const transitions: string[] = []
const model = createFauxModel({
  responses: [
    fauxText('Existing topic ready'),
    fauxToolCall('wait_for_input', { reason: 'Choose a color' }),
    fauxText('Which color?'),
    fauxText('Direct prompt reply'),
    fauxHang(),
    fauxText('Queued work completed'),
  ],
})
const agentDir = resolve('host-data')
const runtime = createRuntime({
  agentDir,
  defaultModel: model,
  mcp: false,
})
const host = new DaemonLarkHost(runtime, {
  agentDir,
  hostEnv: {},
  logger: silentLogger,
  transport: network.transport,
})
const unsub = runtime.events.subscribe((event) => {
  if (event.type === 'run_started' || event.type === 'run_finished') {
    transitions.push(event.type)
  }
})

try {
  await runtime.ready()
  await host.sync(
    {
      lark: {
        appId: 'app_host',
        owners: ['ou_alice'],
        chats: ['oc_group'],
      },
    },
    true,
  )
  const statuses = await runtime.channels.list()
  assert.equal(statuses.find((s) => s.name === 'lark')?.connected, true)

  network.deliver(
    larkEvent({
      message_id: 'owned-root',
      root_id: 'owned-root',
      thread_id: 'thread_owned-root',
    }),
  )
  await until(
    () =>
      network.sent.some((m) => m.text.includes('Existing topic ready')) ||
      network.topics.some((m) => m.title.includes('Existing topic ready')),
    'existing topic ready',
  )
  const allSessions = await runtime.sessions.list()
  const topicSession = allSessions.find((s) => s.kind === 'topic')!
  const receipt = await runtime.channels.submit('lark', {
    chatId: 'oc_group',
    sessionId: topicSession.id,
    author: { id: 'ou_alice', name: 'Alice' },
    text: 'Continue the topic',
  })
  assert.equal(receipt.sessionId, topicSession.id)
  await until(
    () =>
      network.sent.some((m) => m.text.includes('Which color?')) ||
      network.topics.some((m) => m.title.includes('Which color?')),
    'which color reply',
  )
  assert.equal(
    (await runtime.sessions.get(topicSession.id))?.waitingReason,
    'Choose a color',
  )
  assert(
    transitions.includes('run_started') && transitions.includes('run_finished'),
  )
  console.log('Lark host: topic continued, wait_for_input recorded')

  const proj = await runtime.projects.create({
    name: 'Local check',
    cwd: process.cwd(),
    hubSessionId: true,
  })
  await runtime.prompt(proj.hubSessionId!, { text: 'Direct hello' })
  await until(() => model.calls.length >= 4)
  await runtime.waitForIdle(proj.hubSessionId!)
  console.log('Direct project session coexists with Lark bindings cleanly')

  const binding = (await runtime.bindings.list({ channel: 'lark' })).find(
    (b) => b.threadId === 'thread_owned-root',
  )!
  const reminder = await runtime.timers.createRoutine({
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    message: 'Review report',
    schedule: { time: '09:00' },
    timezone: 'UTC',
    creatorId: 'ou_alice',
    creatorName: 'Alice',
  })
  assert.equal(
    (await runtime.timers.list()).some((t) => t.id === reminder.id),
    true,
  )
  const edited = await runtime.timers.update(reminder.id, {
    message: 'Review the updated report',
    schedule: { time: '10:00' },
  })
  assert.equal(edited?.message, 'Review the updated report')
  assert.equal(await runtime.timers.delete(reminder.id), true)
  console.log('Host timer created, edited, listed, and cancelled via Runtime')

  network.deliver(
    larkEvent({
      message_id: 'busy-anchor',
      content: JSON.stringify({ text: '@_user_1 Hold this run' }),
    }),
  )
  await until(() => model.calls.length === 5, 'held run')
  const hubSession = (await runtime.sessions.list()).find(
    (s) =>
      s.kind === 'hub' &&
      (s.name === 'oc_group' || s.projectId === topicSession.projectId),
  )!
  const activeRunId = (await runtime.sessions.status(hubSession.id)).activeRunId
  assert.ok(activeRunId, 'held run must have an activeRunId')
  network.deliver(
    larkEvent({
      message_id: 'queued-anchor',
      content: JSON.stringify({ text: '@_user_1 Queued request' }),
    }),
  )
  assert.equal(
    await runtime.stop(hubSession.id, 'host-stop', {
      expectedRunId: activeRunId,
    }),
    true,
  )
  await until(
    () =>
      model.calls.length >= 6 ||
      network.sent.some((m) => m.text === 'Queued work completed'),
  )
  const staleStopResult = await runtime.stop(hubSession.id, 'stale-stop', {
    expectedRunId: activeRunId,
  })
  assert.equal(staleStopResult, false)
  await until(() =>
    network.sent.some((message) => message.text === 'Queued work completed'),
  )
  assert.equal(model.pending(), 0)
  console.log('Stop ended held run and preserved later queued input')
} finally {
  unsub()
  await host.stop()
  await runtime.dispose()
}
console.log('Disposed: host and runtime stopped cleanly')
