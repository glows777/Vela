import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { connectRuntime } from '../../src/daemon/client.ts'
import { getDaemonStatus } from '../../src/daemon/launcher.ts'
import { startDaemonServer } from '../../src/daemon/server.ts'
import { DaemonWebhooksHost } from '../../src/daemon/webhooks-host.ts'
import { openDatabase } from '../../src/db/index.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import type {
  ChannelAdapterContext,
  ChannelAnnouncementInput,
  ChannelOutboundMessage,
} from '../../src/runtime/channels.ts'
import { enqueueInboxEvent } from '../../src/runtime/inbox.ts'
import { VelaRuntimeEngine } from '../../src/runtime/index.ts'
import { enqueueOutboxInTx } from '../../src/runtime/outbox.ts'
import { RuntimeWebhookReceiver } from '../../src/runtime/webhooks/index.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4b1-r2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await Promise.resolve(cleanups.pop()!()).catch(() => {})
  }
})

test('R2 #1,#2,#3,#13: non-waking route never stalls, announcements isolate from human prompts, passive inputs stay within route, mention+recipient stay paired', async () => {
  const root = makeTempDir('vela-r2-batch-')
  const agentDir = join(root, 'agent')
  const projDir = join(root, 'proj')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projDir, { recursive: true })

  const model = createFauxModel({
    responses: [
      fauxText('Reply B'),
      fauxText('Human reply'),
      fauxText('Routine ok'),
      fauxText('Reply Bob'),
      fauxText('Reply Alice'),
    ],
  })
  const announced: ChannelAnnouncementInput[] = []
  const delivered: ChannelOutboundMessage[] = []
  const db = openDatabase({ path: ':memory:' })
  const engine = new VelaRuntimeEngine({ db, agentDir, logger: silentLogger })
  engine.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir,
      blobs: engine.blobs,
      environments: engine.environments,
      eventBus: engine.eventBus,
      timers: engine.timers,
      subscriptions: engine.subscriptions,
      defaultModel: model,
    }),
  )
  cleanups.push(async () => {
    await engine.dispose()
    db.close()
  })

  await engine.registerChannel({
    name: 'lark',
    async start() {},
    async stop() {},
    async announce(input) {
      if (input.text.includes('FailRoutine')) {
        throw new Error('announce failed')
      }
      announced.push(input)
      return { externalMessageId: `ann-${announced.length}` }
    },
    async deliver(msg) {
      delivered.push(msg)
      return { externalMessageId: `out-${delivered.length}` }
    },
  })

  const proj = engine.projects.create({
    name: 'SharedHub',
    cwd: projDir,
    hubSessionId: true,
  })
  const hubId = proj.hubSessionId!
  engine.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_A',
    kind: 'group',
    projectId: proj.id,
    enabled: true,
  })
  engine.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_B',
    kind: 'group',
    projectId: proj.id,
    enabled: true,
  })

  // #1 & #3: passive & wake=false message for oc_A BEFORE waking message for oc_B
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'channel',
    wake: false,
    passive: true,
    payload: {
      type: 'channel',
      channel: 'lark',
      externalChatId: 'oc_A',
      senderId: 'ou_a',
      senderName: 'Alice',
      text: 'SECRET_GROUP_A_PASSIVE',
    },
  })
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'channel',
    wake: false,
    passive: false,
    payload: {
      type: 'channel',
      channel: 'lark',
      externalChatId: 'oc_A',
      senderId: 'ou_a',
      senderName: 'Alice',
      text: 'NO_WAKE_GROUP_A',
    },
  })
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'channel',
    wake: true,
    payload: {
      type: 'channel',
      channel: 'lark',
      externalChatId: 'oc_B',
      senderId: 'ou_b',
      senderName: 'Bob',
      text: 'Ping B',
    },
  })
  engine.scheduleSession(hubId)
  await engine.waitForIdle()
  expect(model.calls).toHaveLength(1)
  expect(JSON.stringify(model.calls[0]!.prompt)).not.toContain(
    'SECRET_GROUP_A_PASSIVE',
  )
  expect(delivered[0]!.externalChatId).toBe('oc_B')

  // #2: Failing routine + unrelated SDK prompt + valid routine + same-group message with messageId
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'timer',
    wake: true,
    payload: {
      type: 'timer',
      kind: 'routine',
      timerId: 't-fail',
      message: 'FailRoutine',
      creatorName: 'Alice',
      channel: 'lark',
      externalChatId: 'oc_A',
      scheduledAt: '2026-11-27T00:00:00Z',
      firedAt: '2026-11-27T00:00:00Z',
    },
  })
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'user',
    wake: true,
    payload: { type: 'user', text: 'SDK_HUMAN_PROMPT' },
  })
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'timer',
    wake: true,
    payload: {
      type: 'timer',
      kind: 'routine',
      timerId: 't-ok',
      message: 'GoodRoutine',
      creatorName: 'Alice',
      channel: 'lark',
      externalChatId: 'oc_A',
      scheduledAt: '2026-11-27T00:00:00Z',
      firedAt: '2026-11-27T00:00:00Z',
    },
  })
  engine.scheduleSession(hubId)
  await engine.waitForIdle()
  expect(model.calls).toHaveLength(3)
  expect(JSON.stringify(model.calls[1]!.prompt)).toContain('SDK_HUMAN_PROMPT')
  expect(announced).toHaveLength(1)
  expect(announced[0]!.text).toContain('GoodRoutine')

  // #13: Alice (mentionRecipient: true) + Bob (mentionRecipient omitted) split cleanly -> mention Bob never happens
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'channel',
    wake: true,
    payload: {
      type: 'channel',
      channel: 'lark',
      externalChatId: 'oc_B',
      senderId: 'ou_alice',
      senderName: 'Alice',
      mentionRecipient: true,
      text: 'From Alice',
    },
  })
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: proj.id,
    source: 'channel',
    wake: true,
    payload: {
      type: 'channel',
      channel: 'lark',
      externalChatId: 'oc_B',
      senderId: 'ou_bob',
      senderName: 'Bob',
      text: 'From Bob',
    },
  })
  engine.scheduleSession(hubId)
  await engine.waitForIdle()
  const bobOut = delivered.find(
    (d) =>
      d.externalChatId === 'oc_B' &&
      d.recipientId === 'ou_bob' &&
      d.mentionRecipient,
  )
  expect(bobOut).toBeUndefined()
  expect(
    delivered.some(
      (d) =>
        d.externalChatId === 'oc_B' &&
        d.recipientId === 'ou_alice' &&
        d.mentionRecipient === true,
    ),
  ).toBe(true)
})

test('R2 #4,#5,#6,#9,#10,#11,#12,#14,#15: binding revocation, disabled sub suppression, prior receipt safety, case-insensitive GitHub keys, db cursor, consistent multi-adapter, DM webhook, routine creator & rawText shortcut', async () => {
  const root = makeTempDir('vela-r2-ctrl-')
  const agentDir = join(root, 'agent')
  const projDir = join(root, 'proj')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projDir, { recursive: true })

  const model = createFauxModel({
    responses: [
      fauxText('DM fallback handled'),
      fauxText('DM final PR 3 handled'),
      fauxToolCall('timers', {
        action: 'create',
        kind: 'routine',
        message: 'Check build',
        schedule: { at: '2099-01-01T09:00' },
      }),
      fauxText('Scheduled for Alice'),
      fauxText('Alpha tools turn'),
      fauxText('Routine done'),
    ],
  })
  let toolInvocations = 0
  let dmAnnounceCalls = 0
  const delivered: ChannelOutboundMessage[] = []
  let ctxLark!: ChannelAdapterContext

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  const engine = new VelaRuntimeEngine({ db, agentDir, logger: silentLogger })
  engine.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir,
      blobs: engine.blobs,
      environments: engine.environments,
      eventBus: engine.eventBus,
      timers: engine.timers,
      subscriptions: engine.subscriptions,
      defaultModel: model,
    }),
  )
  cleanups.push(async () => {
    await engine.dispose()
    db.close()
  })

  await engine.registerChannel({
    name: 'alpha',
    async start(ctx) {
      ctxLark = ctx
    },
    async stop() {},
    async deliver(msg) {
      delivered.push(msg)
      return { externalMessageId: `m-${delivered.length}` }
    },
    async announce(input) {
      if (input.externalChatId === 'oc_dm') dmAnnounceCalls++
      return { externalMessageId: `ann-${delivered.length}` }
    },
    getTools: () => [
      {
        name: 'alpha_tool',
        description: 'Alpha tool',
        inputSchema: z.object({}).strict(),
        execute: () => {
          toolInvocations++
          return 'ok'
        },
      },
    ],
    listMessages: async ({ cursor }) => ({
      messages: [],
      nextCursor: cursor ? undefined : 'chan-p1',
    }),
  })
  await engine.registerChannel({
    name: 'beta',
    async start() {},
    async stop() {},
    async deliver(msg) {
      delivered.push(msg)
      return { externalMessageId: `b-${delivered.length}` }
    },
    getTools: () => [
      {
        name: 'beta_tool',
        description: 'Beta tool',
        inputSchema: z.object({}).strict(),
        execute: () => 'beta',
      },
    ],
  })

  // #12: Bound DM on channel works for default webhook without announce() & DM routine uses normal deliver()
  const dmProj = engine.projects.create({ name: 'DMProj', cwd: projDir })
  const dmSess = engine.sessions.create({
    projectId: dmProj.id,
    kind: 'chat',
    location: { environment: 'local', cwd: projDir },
  })
  engine.bindings.upsert({
    channel: 'beta',
    externalId: 'oc_dm',
    kind: 'direct',
    projectId: dmProj.id,
    sessionId: dmSess.id,
    enabled: true,
  })
  const dmWh = engine.ingestWebhookEvent(
    {
      source: 'sentry',
      key: 'sentry:dm',
      deliveryId: 'd-dm',
      summary: 'DM alert',
    },
    { channel: 'beta', chatId: 'oc_dm' },
  )
  expect(dmWh.defaultTargetSessionId).toBe(dmSess.id)
  await engine.waitForIdle(dmSess.id)
  expect(dmAnnounceCalls).toBe(0)
  expect(delivered.some((d) => d.externalChatId === 'oc_dm')).toBe(true)

  // #5 & #6 & #9: Disabled DM sub skips enqueue AND suppresses default fallback; case-insensitive GitHub match; prior delivery doesn't kill new sub B
  const dmSubSess = engine.sessions.create({ kind: 'chat', name: 'SubDM' })
  const dmSubBinding = engine.bindings.upsert({
    channel: 'alpha',
    externalId: 'oc_sub_dm',
    kind: 'direct',
    sessionId: dmSubSess.id,
    enabled: true,
  })
  engine.bindings.upsert({
    channel: 'alpha',
    externalId: 'oc_grp_fallback',
    kind: 'group',
    projectId: dmProj.id,
    enabled: true,
  })
  engine.subscriptions.create({
    source: 'github',
    eventKey: 'github:acme/vela#pr/3',
    sessionId: dmSubSess.id,
  })
  engine.setChannelEnabled('alpha', false)
  const blockedSubRes = engine.ingestWebhookEvent(
    {
      source: 'github',
      key: 'github:Acme/Vela#pr/3',
      deliveryId: 'gh-pr3-1',
      summary: 'Mixed case PR 3',
      final: true,
    },
    { channel: 'beta', chatId: 'oc_dm' },
  )
  expect(blockedSubRes.enqueuedCount).toBe(0)
  expect(blockedSubRes.defaultTargetSessionId).toBeUndefined()
  expect(engine.subscriptions.list({ sessionId: dmSubSess.id })).toHaveLength(1)
  engine.setChannelEnabled('alpha', true)

  // Now deliver gh-pr3-2 (removes dmSubSess subscription via final: true), then subscribe session B and redeliver gh-pr3-2 -> B MUST stay subscribed & get 0 enqueues!
  const okSubRes = engine.ingestWebhookEvent({
    source: 'github',
    key: 'github:Acme/Vela#pr/3',
    deliveryId: 'gh-pr3-2',
    summary: 'Final PR 3',
    final: true,
  })
  expect(okSubRes.enqueuedCount).toBe(1)
  await engine.waitForIdle(dmSubSess.id)
  const sessB = engine.sessions.create({ kind: 'chat', name: 'NewSubB' })
  engine.subscriptions.create({
    source: 'github',
    eventKey: 'github:acme/vela#pr/3',
    sessionId: sessB.id,
  })
  const redelivAfterSubB = engine.ingestWebhookEvent({
    source: 'github',
    key: 'github:Acme/Vela#pr/3',
    deliveryId: 'gh-pr3-2',
    summary: 'Final PR 3',
    final: true,
  })
  expect(redelivAfterSubB.enqueuedCount).toBe(0)
  expect(engine.subscriptions.list({ sessionId: sessB.id })).toHaveLength(1)

  // #4: Outbox drops queued reply if target binding disabled before flush, and pre-prepared channel tool checks active binding inside execute()
  const queuedReply = enqueueOutboxInTx(db, {
    sessionId: dmSubSess.id,
    channel: 'alpha',
    externalChatId: 'oc_sub_dm',
    text: 'Must not send after disable',
  })
  engine.bindings.setEnabled(dmSubBinding.id, false)
  await engine.outbox.flushOnce()
  const outRow = db.get<{ status: string }>(
    'SELECT status FROM outbox WHERE id = ?',
    queuedReply.id,
  )
  expect(outRow?.status).toBe('failed')

  // Channel tool captured before disablement must fail closed when invoked after binding is disabled
  engine.bindings.setEnabled(dmSubBinding.id, true)
  const { adaptChannelTools } = await import(
    '../../src/driver/runtime-tools.ts'
  )
  const preparedTools = adaptChannelTools(
    engine.getChannelToolsForSession(dmSubSess.id),
    dmSubSess.id,
    null,
    db,
  )
  expect(preparedTools).toHaveLength(1)
  engine.bindings.setEnabled(dmSubBinding.id, false)
  await expect(
    preparedTools[0]!.execute({}, undefined as never),
  ).rejects.toThrow(/disabled/)
  expect(toolInvocations).toBe(0)

  // #10: SQLite cursor cannot cross into channel adapter after channel is enabled
  engine.setChannelEnabled('alpha', false)
  engine.bindings.setEnabled(dmSubBinding.id, true)
  const sqlitePage = await engine.listSessionMessages({
    sessionId: dmSubSess.id,
    limit: 1,
  })
  expect(sqlitePage.nextCursor).toMatch(/^db:/)
  engine.setChannelEnabled('alpha', true)
  await expect(
    engine.listSessionMessages({
      sessionId: dmSubSess.id,
      cursor: sqlitePage.nextCursor,
    }),
  ).rejects.toThrow(/message source changed to channel/)

  // #11: Hub bound to alpha (oldest) and beta (newest) consistently chooses alpha in driver setup + tools
  const multiProj = engine.projects.create({
    name: 'MultiChan',
    cwd: projDir,
    hubSessionId: true,
  })
  const multiHub = multiProj.hubSessionId!
  engine.bindings.upsert({
    channel: 'alpha',
    externalId: 'oc_alpha_grp',
    kind: 'group',
    projectId: multiProj.id,
    enabled: true,
  })
  engine.bindings.upsert({
    channel: 'beta',
    externalId: 'oc_beta_grp',
    kind: 'group',
    projectId: multiProj.id,
    enabled: true,
  })

  // #14 & #15: Preformatted rawText '!status' triggers shortcut (not model); human turn creates routine with Alice attribution
  await ctxLark.ingest({
    channel: 'alpha',
    dedupeKey: 'sc-pre-1',
    externalChatId: 'oc_alpha_grp',
    kind: 'group',
    messageId: 'om_sc',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'Alice: !status',
    preformatted: true,
    rawText: '!status',
    timestamp: '2026-11-27T00:00:00Z',
  })
  expect(
    delivered.some(
      (d) => d.externalChatId === 'oc_alpha_grp' && d.text.includes('(idle)'),
    ),
  ).toBe(true)
  expect(engine.getChannelToolsForSession(multiHub)?.binding.channel).toBe(
    'alpha',
  )

  await ctxLark.ingest({
    channel: 'alpha',
    dedupeKey: 'rt-alice-1',
    externalChatId: 'oc_alpha_grp',
    kind: 'group',
    messageId: 'om_rt',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'Schedule a check',
    timestamp: '2026-11-27T00:00:00Z',
  })
  await engine.waitForIdle(multiHub)
  const createdRoutine = engine.timers.list({ projectId: multiProj.id })[0]!
  expect(createdRoutine.creatorId).toBe('ou_alice')
  expect(createdRoutine.creatorName).toBe('Alice')
})

test('R2 #7,#8,#16,#18,#19: idle daemon config watch, reload target generation isolation, submit RPC strict validation, receiver stop timeout bound, and concurrent duplicate 503 reservation', async () => {
  // #18 & #19: Receiver concurrent duplicates share publish outcome (503 -> both 503, then retry succeeds) & stop() is time-bounded despite hung publish
  let releaseHung!: () => void
  let failFirst = true
  const receiver = new RuntimeWebhookReceiver(
    { port: 0, generic: { secret: 'sec', source: 'ci' } },
    async () => {
      if (failFirst) {
        await new Promise((r) => setTimeout(r, 40))
        throw new Error('db busy')
      }
      await new Promise<void>((r) => {
        releaseHung = r
      })
    },
    silentLogger,
  )
  await receiver.start()
  const body = JSON.stringify({ key: 'ci:job', summary: 'Concurrent test' })
  const sig = signPayload('sec', body)
  const [c1, c2] = await Promise.all([
    fetch(`http://127.0.0.1:${receiver.port}/events/generic`, {
      method: 'POST',
      headers: { 'x-vela-delivery': 'd-conc', 'x-vela-signature-256': sig },
      body,
    }),
    fetch(`http://127.0.0.1:${receiver.port}/events/generic`, {
      method: 'POST',
      headers: { 'x-vela-delivery': 'd-conc', 'x-vela-signature-256': sig },
      body,
    }),
  ])
  expect(c1.status).toBe(503)
  expect(c2.status).toBe(503)

  // Now launch hung publish -> stop() resolves within ~2.6s without hanging forever
  failFirst = false
  const body2 = JSON.stringify({ key: 'ci:hung', summary: 'Hung' })
  const hungReq = fetch(`http://127.0.0.1:${receiver.port}/events/generic`, {
    method: 'POST',
    headers: {
      'x-vela-delivery': 'd-hung',
      'x-vela-signature-256': signPayload('sec', body2),
    },
    body: body2,
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 30))
  const stopStarted = Date.now()
  await receiver.stop()
  expect(Date.now() - stopStarted).toBeLessThan(4000)
  releaseHung?.()
  await hungReq

  // #8: DaemonWebhooksHost keeps old defaultTarget for in-flight requests during reload
  const seenTargets: Array<string | undefined> = []
  let proceedFirst!: () => void
  const firstStarted = new Promise<void>((r) => {
    setTimeout(r, 0)
  })
  void firstStarted
  let firstCall = true
  const host = new DaemonWebhooksHost(async (_ev, target) => {
    if (firstCall) {
      firstCall = false
      await new Promise<void>((r) => {
        proceedFirst = r
      })
    }
    seenTargets.push(target?.chatId)
  }, silentLogger)
  await host.sync({
    webhooks: { port: 0, generic: { secret: 's1', source: 'ci' } },
    eventDefaultTarget: { channel: 'lark', chatId: 'chat_OLD' },
  })
  const portA = host.status().port!
  const bA = JSON.stringify({ key: 'ci:gen', summary: 'Gen 1' })
  const reqOld = fetch(`http://127.0.0.1:${portA}/events/generic`, {
    method: 'POST',
    headers: {
      'x-vela-delivery': 'g-gen1',
      'x-vela-signature-256': signPayload('s1', bA),
    },
    body: bA,
  })
  await new Promise((r) => setTimeout(r, 30))
  const reloadP = host.sync(
    {
      webhooks: { port: 0, generic: { secret: 's2', source: 'ci' } },
      eventDefaultTarget: { channel: 'lark', chatId: 'chat_NEW' },
    },
    true,
  )
  proceedFirst()
  await reqOld
  await reloadP
  expect(seenTargets).toEqual(['chat_OLD'])
  await host.stop()

  // #7 & #16: Idle daemon detects new webhooks in config.json without reloadConfig(), and strict submit RPC rejects bad optional fields
  const root = makeTempDir('vela-r2-daemon-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const daemon = await startDaemonServer({
    agentDir,
    hostEnv: {},
    registerSignalHandlers: false,
  })
  cleanups.push(() => daemon.close('test-cleanup'))
  expect((await getDaemonStatus({ agentDir })).webhooks).toEqual({
    enabled: false,
    listening: false,
  })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      webhooks: { port: 0, generic: { secret: 's3', source: 'ci' } },
    }),
  )
  // Auto-reloads via daemon.status() / watcher without explicit client.reloadConfig()
  const reloadedStatus = await getDaemonStatus({ agentDir })
  expect(reloadedStatus.webhooks?.enabled).toBe(true)
  expect(reloadedStatus.webhooks?.listening).toBe(true)

  const client = await connectRuntime({
    agentDir,
    socketPath: daemon.socketPath,
    autoStart: false,
  })
  cleanups.push(() => client.dispose())
  await expect(
    client.channels.submit('lark', {
      chatId: 'oc_1',
      text: 'hi',
      // biome-ignore lint/suspicious/noExplicitAny: deliberate invalid RPC check
      newTopic: {} as any,
      author: { id: 'u', name: 'U' },
    }),
  ).rejects.toThrow(/Invalid channels\.submit/)
})
