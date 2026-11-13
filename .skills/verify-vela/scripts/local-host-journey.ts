// Run through vela-verify.sh exec. Real SDK/tools/storage; only model and Lark wire are fake.
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { Server } from 'node:net'
import { resolve } from 'node:path'
import {
  createChannelVela,
  type LocalEvent,
  type LocalHost,
  local,
} from '@glows777/vela-channels'
import {
  createFauxModel,
  type FauxRequest,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'

const pass = (name: string) => console.log(`PASS ${name}`)
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    assert(Date.now() < deadline, 'Local host journey timed out')
    await new Promise((done) => setTimeout(done, 5))
  }
}
const cwd = resolve('host-project')
const alias = resolve('host-project-alias')
const dataDir = resolve('local-host-data')
await mkdir(cwd, { recursive: true })
await symlink(cwd, alias, 'dir')
const network = fakeLark()
const router = (request: FauxRequest) => {
  if (request.lastUserText.includes('Hold this run')) return fauxHang()
  if (request.lastUserText.includes('Queued request'))
    return fauxText('Queued work completed')
  if (request.lastUserText.includes('Choose a color'))
    return request.toolResults.length
      ? fauxText('Which color?')
      : fauxToolCall('channel_wait_for_input', { reason: 'Choose a color' })
  if (
    request.lastUserText.includes('Create a project file') ||
    request.lastUserText.includes('Write result.txt')
  ) {
    if (request.tools.includes('channel_start_topic'))
      return request.toolResults.length
        ? fauxText('Dispatched')
        : fauxToolCall('channel_start_topic', {
            title: 'Create a project file',
            brief: 'Write result.txt in the project directory',
          })
    return request.toolResults.length
      ? fauxText('Created result.txt successfully')
      : fauxToolCall('write_file', {
          path: 'result.txt',
          content: 'local host verification succeeded\n',
        })
  }
  return fauxText('Owned topic ready')
}
const model = createFauxModel({ responses: Array(40).fill(router) })
const makeVela = () =>
  createChannelVela({
    cwd: process.cwd(),
    dataDir,
    contextFiles: false,
    model,
    extensions: [
      lark({
        owners: ['ou_alice'],
        chats: ['oc_group'],
        timezone: 'UTC',
        transport: network.transport,
      }),
      local({}),
    ],
  })
let vela = makeVela()
await vela.ready()
const host: LocalHost = vela.channel('local')
const larkHost = vela.channel('lark')
const events: LocalEvent[] = []
const localConnections: boolean[] = []
const larkConnections: boolean[] = []
const runs: string[] = []
const status: string[] = []
const off = [
  host.onEvent((event) => events.push(event)),
  host.onConnection((value) => localConnections.push(value.connected)),
  larkHost.onConnection((value) => larkConnections.push(value.connected)),
  larkHost.onSession((update) => {
    if (update.run) runs.push(update.run.type)
  }),
  host.onStatus((line) => status.push(line.text)),
]
assert.deepEqual(host.connection(), { connected: false })
assert.deepEqual(larkHost.connection(), { connected: false })
await assert.rejects(host.openProject({ cwd }), /not running/)
// Observe the public Node listening boundary, without touching Vela runtime internals.
const listen = Server.prototype.listen
let listenCalls = 0
Server.prototype.listen = function (...args: Parameters<typeof listen>) {
  listenCalls++
  return listen.apply(this, args)
} as typeof listen
try {
  await vela.startChannels()
  assert(host.connection().connected && larkHost.connection().connected)
  assert.deepEqual(localConnections, [true])
  assert.deepEqual(larkConnections, [true])
  const project = await host.openProject({ cwd, name: 'Host verification' })
  assert.equal((await host.openProject({ cwd: alias })).id, project.id)
  assert.deepEqual(host.projects(), [project])
  pass('prestart subscriptions, typed LocalHost and canonical project identity')

  const address = { projectId: project.id, sessionId: project.sessionId }
  const receipt = await host.submit({
    ...address,
    text: 'Create a project file',
    clientMessageId: 'host-verification-1',
  })
  assert.equal(receipt.sessionId, project.sessionId)
  assert(
    host
      .messages(address)
      .messages.some(
        (message) =>
          message.id === receipt.messageId &&
          message.clientMessageId === 'host-verification-1',
      ),
  )
  await until(() =>
    host
      .sessions(project.id)
      .some(
        (session) =>
          !!session.topic && session.state === 'done' && !session.runId,
      ),
  )
  const task = host.sessions(project.id).find((session) => session.topic)!
  await until(() =>
    events.some(
      (event) =>
        event.type === 'run_finished' && event.sessionId === task.sessionId,
    ),
  )
  assert.equal(
    await readFile(resolve(cwd, 'result.txt'), 'utf8'),
    'local host verification succeeded\n',
  )
  await assert.rejects(readFile(resolve('result.txt')), { code: 'ENOENT' })
  const taskAddress = { projectId: project.id, sessionId: task.sessionId }
  const history = host.messages(taskAddress)
  assert(
    history.messages.some(
      (message) => message.text === 'Created result.txt successfully',
    ),
  )
  for (const sessionId of [project.sessionId, task.sessionId]) {
    await until(() =>
      events.some(
        (event) =>
          event.type === 'run_finished' && event.sessionId === sessionId,
      ),
    )
    const started = events.filter(
      (event) => event.type === 'run_started' && event.sessionId === sessionId,
    )
    const finished = events.filter(
      (event) => event.type === 'run_finished' && event.sessionId === sessionId,
    )
    assert.equal(started.length, 1)
    assert.equal(finished.length, 1)
    assert(started[0]!.runId)
    assert.equal(started[0]!.runId, finished[0]!.runId)
  }
  assert(status.length)
  assert(!events.some((event) => event.type === 'reset'))
  pass(
    'visible submit, shared triage, actual project file, status and exact run lifecycle',
  )

  network.deliver(
    larkEvent({
      message_id: 'owned-root',
      root_id: 'owned-root',
      thread_id: 'owned-thread',
    }),
  )
  await until(() =>
    larkHost.sessions().some((session) => !!session.topic && !session.runId),
  )
  const topic = larkHost.sessions().find((session) => session.topic)!
  const input = {
    channelId: topic.chatId,
    topic: topic.topic,
    senderId: 'ou_alice',
    senderName: 'Alice',
    replyToId: 'host-followup-anchor',
    text: 'Choose a color',
  }
  assert.equal((await larkHost.submit(input)).sessionId, topic.sessionId)
  await until(() =>
    larkHost
      .sessions()
      .some(
        (session) =>
          session.waitingReason === 'Choose a color' && !session.runId,
      ),
  )
  await until(() =>
    network.sent.some(
      (message) =>
        message.messageId === input.replyToId &&
        message.text.endsWith('Which color?'),
    ),
  )
  assert(larkHost.sessions().every((session) => session.chatId === 'oc_group'))
  assert(host.sessions().every((session) => session.chatId === project.id))
  assert(runs.includes('started') && runs.includes('finished'))
  pass(
    'isolated channel lists, owned Lark topic, anchored reply and waiting state',
  )

  const target = { chatId: topic.chatId, rootId: topic.topic!.rootId }
  const callsBeforeRoutine = model.calls.length
  const routine = await larkHost.routines.create(target, {
    message: 'Review the project file',
    schedule: {
      at: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16),
    },
    creator: { id: 'ou_alice', name: 'Alice' },
  })
  assert(
    larkHost.routines
      .list(target)
      .routines.some((item) => item.id === routine.id),
  )
  assert.equal(host.routines.list({ chatId: project.id }).routines.length, 0)
  assert(await larkHost.routines.cancel(target, routine.id))
  assert.equal(larkHost.routines.list(target).routines.length, 0)
  assert.equal(model.calls.length, callsBeforeRoutine)
  pass(
    'idle future routine create/list/cancel without model work or private clock',
  )

  // Topic inputs steer by default; the group hub preserves default-queued input.
  const queuedInput = { ...input, topic: undefined }
  const queuedTarget = { chatId: topic.chatId }
  await larkHost.submit({ ...queuedInput, text: 'Hold this run' })
  await until(() =>
    model.calls.some((call) => call.lastUserText.includes('Hold this run')),
  )
  const runId = larkHost.sessions().find((session) => !session.topic)!.runId!
  assert(runId)
  await larkHost.submit({
    ...queuedInput,
    text: 'Queued request',
    replyToId: 'queued-anchor',
  })
  assert.equal(await larkHost.stop(queuedTarget, 'expired-run'), false)
  assert(await larkHost.stop(queuedTarget, runId))
  await until(() =>
    network.sent.some(
      (message) =>
        message.messageId === 'queued-anchor' &&
        message.text.endsWith('Queued work completed'),
    ),
  )
  await until(
    () => !larkHost.sessions().find((session) => !session.topic)!.runId,
  )
  assert.equal(await larkHost.stop(queuedTarget, runId), false)
  pass('exact Stop rejects stale IDs and preserves the later queued reply')

  await vela.dispose()
  assert.deepEqual(localConnections, [true, false])
  assert.deepEqual(larkConnections, [true, false])
  assert.deepEqual(host.connection(), { connected: false })
  await assert.rejects(
    host.submit({ ...address, text: 'After disposal' }),
    /not running/,
  )
  vela = makeVela()
  await vela.startChannels()
  const reopened: LocalHost = vela.channel('local')
  assert.equal((await reopened.openProject({ cwd: alias })).id, project.id)
  assert.deepEqual(reopened.messages(taskAddress), history)
  assert(
    vela
      .channel('lark')
      .sessions()
      .some((session) => session.sessionId === topic.sessionId),
  )
  pass(
    'disposal disconnects and rejects writes; same dataDir restores projects and visible history',
  )
} finally {
  await vela.dispose()
  for (const unsubscribe of off) unsubscribe()
  Server.prototype.listen = listen
}
assert.equal(listenCalls, 0)
pass(
  'core-only local({}) never opened an HTTP/TCP listener, including after restart',
)
console.log(
  'Offline only: fakeLark does not simulate reconnect. Actual SDK callback/sanitized reconnect coverage is in local-host-connection.test.ts; live Lark and provider behavior remain unverified.',
)
