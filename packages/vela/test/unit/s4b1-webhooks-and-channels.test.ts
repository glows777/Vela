import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { connectRuntime } from '../../src/daemon/client.ts'
import { startDaemonServer } from '../../src/daemon/server.ts'
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAnnouncementInput,
  ChannelOutboundMessage,
} from '../../src/runtime/channels.ts'
import { RuntimeWebhookReceiver } from '../../src/runtime/webhooks/index.ts'
import { createRuntime } from '../../src/runtime-sdk.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4b1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await Promise.resolve(fn()).catch(() => {})
  }
})

test('RuntimeWebhookReceiver validates HMAC, filters GitHub labels/own comments, enforces generic namespace, and dedupes deliveries', async () => {
  const received: Array<{ source: string; key: string; final?: boolean }> = []
  let failNext = false
  const receiver = new RuntimeWebhookReceiver(
    {
      port: 0,
      github: {
        secret: 'gh-secret',
        repositories: ['glows777/Vela'],
        issueLabels: { all: ['bug'], any: ['P1', 'P2'] },
      },
      generic: {
        secret: 'gen-secret',
        source: 'sentry',
      },
    },
    async (event) => {
      if (failNext) {
        failNext = false
        throw new Error('storage down')
      }
      received.push({
        source: event.source,
        key: event.key,
        final: event.final,
      })
    },
    silentLogger,
  )
  await receiver.start()
  cleanups.push(() => receiver.stop())

  const port = receiver.port!
  expect(port).toBeGreaterThan(0)
  expect(receiver.status()).toEqual({
    enabled: true,
    listening: true,
    port,
    endpoints: ['github', 'generic'],
  })

  // 1. Invalid signature -> 403
  const badSig = await fetch(`http://127.0.0.1:${port}/events/github`, {
    method: 'POST',
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'd-bad',
      'x-hub-signature-256': signPayload('wrong', '{}'),
    },
    body: '{}',
  })
  expect(badSig.status).toBe(403)

  // 2. Missing delivery header -> 400
  const noHeader = await fetch(`http://127.0.0.1:${port}/events/generic`, {
    method: 'POST',
    headers: {
      'x-vela-signature-256': signPayload('gen-secret', '{}'),
    },
    body: '{}',
  })
  expect(noHeader.status).toBe(400)

  // 3. Issue matching all=['bug'] & any=['P1','P2'] vs missing label + own comment marker
  const issueMatch = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'glows777/Vela' },
    issue: {
      number: 42,
      title: 'Crash',
      html_url: 'https://github.com/glows777/Vela/issues/42',
      user: { login: 'alice' },
      body: 'Broken',
      labels: [{ name: 'bug' }, { name: 'P1' }],
    },
  })
  const r1 = await fetch(`http://127.0.0.1:${port}/events/github`, {
    method: 'POST',
    headers: {
      'x-github-event': 'issues',
      'x-github-delivery': 'd-1',
      'x-hub-signature-256': signPayload('gh-secret', issueMatch),
    },
    body: issueMatch,
  })
  expect(r1.status).toBe(202)

  const ownComment = JSON.stringify({
    action: 'created',
    repository: { full_name: 'glows777/Vela' },
    issue: {
      number: 42,
      title: 'Crash',
      pull_request: {},
      labels: [],
    },
    comment: {
      body: 'Automated note\n<!-- vela:event-origin -->',
      user: { login: 'bot' },
      html_url: 'https://github.com/glows777/Vela/pull/42#issuecomment-1',
    },
  })
  const r2 = await fetch(`http://127.0.0.1:${port}/events/github`, {
    method: 'POST',
    headers: {
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'd-2',
      'x-hub-signature-256': signPayload('gh-secret', ownComment),
    },
    body: ownComment,
  })
  expect(r2.status).toBe(202)

  // 4. Generic namespace rejection & valid delivery + dedupe
  const wrongNs = JSON.stringify({
    key: 'other:1',
    summary: 'Out of namespace',
  })
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/events/generic`, {
        method: 'POST',
        headers: {
          'x-vela-delivery': 'g-bad',
          'x-vela-signature-256': signPayload('gen-secret', wrongNs),
        },
        body: wrongNs,
      })
    ).status,
  ).toBe(400)

  const prClosed = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'glows777/Vela' },
    pull_request: {
      number: 99,
      merged: true,
      title: 'Ship',
      user: { login: 'liam' },
      head: { sha: 'a'.repeat(40) },
      html_url: 'https://github.com/glows777/Vela/pull/99',
    },
  })
  failNext = true
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/events/github`, {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'd-pr',
          'x-hub-signature-256': signPayload('gh-secret', prClosed),
        },
        body: prClosed,
      })
    ).status,
  ).toBe(503)
  // Duplicate delivery ID is ignored on retry even after 503
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/events/github`, {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'd-pr',
          'x-hub-signature-256': signPayload('gh-secret', prClosed),
        },
        body: prClosed,
      })
    ).status,
  ).toBe(202)

  const genOk = JSON.stringify({
    key: 'sentry:issue-7',
    summary: 'Spike in errors',
    final: true,
  })
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/events/generic`, {
        method: 'POST',
        headers: {
          'x-vela-delivery': 'g-1',
          'x-vela-signature-256': signPayload('gen-secret', genOk),
        },
        body: genOk,
      })
    ).status,
  ).toBe(202)

  expect(received).toEqual([
    { source: 'github', key: 'github:glows777/Vela#issues', final: undefined },
    { source: 'sentry', key: 'sentry:issue-7', final: true },
  ])
})

test('daemon hosts webhooks, routes eventDefaultTarget with announce(), hot-reloads, and degrades gracefully on errors', async () => {
  const root = makeTempDir('vela-daemon-wh-')
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'proj')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  const model = createFauxModel({
    responses: [
      fauxText('Handled PR feedback'),
      fauxText('Handled unmatched default event'),
    ],
  })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      webhooks: {
        port: 0,
        github: {
          secret: 'wh-sec',
          repositories: ['glows777/Vela'],
        },
      },
      eventDefaultTarget: { channel: 'mockchan', chatId: 'oc_group_1' },
    }),
  )

  const daemon = await startDaemonServer({
    agentDir,
    registerSignalHandlers: false,
  })
  cleanups.push(() => daemon.close('test'))

  const announced: ChannelAnnouncementInput[] = []
  const delivered: ChannelOutboundMessage[] = []
  let ctxRef: ChannelAdapterContext | undefined
  const adapter: ChannelAdapter = {
    name: 'mockchan',
    async start(ctx) {
      ctxRef = ctx
    },
    async stop() {},
    status: () => ({ connected: true }),
    async announce(input) {
      announced.push(input)
      return { externalMessageId: `ann-${announced.length}` }
    },
    async deliver(msg) {
      delivered.push(msg)
      return { externalMessageId: `out-${delivered.length}` }
    },
  }
  await daemon.runtime.registerChannel(adapter)
  expect(ctxRef).toBeDefined()

  const client = await connectRuntime({
    agentDir,
    socketPath: daemon.socketPath,
    autoStart: false,
  })
  cleanups.push(() => client.dispose())

  const proj = await client.projects.create({
    name: 'GroupProj',
    cwd: projectDir,
    hubSessionId: true,
  })
  await client.bindings.upsert({
    channel: 'mockchan',
    externalId: 'oc_group_1',
    kind: 'group',
    projectId: proj.id,
    enabled: true,
  })
  const subTopic = await client.sessions.create({
    projectId: proj.id,
    kind: 'topic',
    name: 'PR 77',
  })
  await client.sessions.configure(subTopic.id, { cwd: projectDir })
  await client.subscriptions.create({
    source: 'github',
    eventKey: 'github:glows777/Vela#pr/77',
    projectId: proj.id,
    sessionId: subTopic.id,
  })

  // Use a real faux scenario file on disk so daemon resolves it cleanly
  const scenarioPath = join(root, 'faux.json')
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      responses: [
        fauxText('Subscribed PR handled'),
        fauxText('Default target handled'),
      ],
    }),
  )
  await client.sessions.configure(subTopic.id, {
    model: `faux:${scenarioPath}`,
    cwd: projectDir,
  })
  await client.sessions.configure(proj.hubSessionId!, {
    model: `faux:${scenarioPath}`,
    cwd: projectDir,
  })

  // Inspect prompt includes githubSubscriptions when webhooks.github.repositories is set
  const hubSnap = await client.sessions.inspect(proj.hubSessionId!, {
    previewPrompt: true,
  })
  expect(
    hubSnap.promptSnapshot?.extensionSections.githubSubscriptions,
  ).toContain('glows777/Vela')

  // Check initial webhook port via daemon status
  const { getDaemonStatus } = await import('../../src/daemon/launcher.ts')
  const st1 = await getDaemonStatus({ agentDir })
  expect(st1.webhooks?.enabled).toBe(true)
  expect(st1.webhooks?.listening).toBe(true)
  expect(st1.webhooks?.port).toBeGreaterThan(0)
  expect(st1.channels?.some((c) => c.name === 'mockchan' && c.connected)).toBe(
    true,
  )

  const whPort = st1.webhooks!.port!
  // 1. Matching subscription (final: true removes subscription)
  const prBody = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'glows777/Vela' },
    pull_request: {
      number: 77,
      merged: true,
      title: 'Merge PR',
      user: { login: 'liam' },
      head: { sha: 'b'.repeat(40) },
      html_url: 'https://github.com/glows777/Vela/pull/77',
    },
  })
  const resSub = await fetch(`http://127.0.0.1:${whPort}/events/github`, {
    method: 'POST',
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'd-sub-77',
      'x-hub-signature-256': signPayload('wh-sec', prBody),
    },
    body: prBody,
  })
  expect(resSub.status).toBe(202)
  await client.waitForIdle()
  expect(
    (await client.subscriptions.list({ sessionId: subTopic.id })).length,
  ).toBe(0)

  // 2. Unmatched event -> routes to eventDefaultTarget, calls announce(), replies under ann-1
  const prUnmatched = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'glows777/Vela' },
    pull_request: {
      number: 88,
      merged: false,
      title: 'Other PR',
      user: { login: 'liam' },
      head: { sha: 'c'.repeat(40) },
      html_url: 'https://github.com/glows777/Vela/pull/88',
    },
  })
  const resDef = await fetch(`http://127.0.0.1:${whPort}/events/github`, {
    method: 'POST',
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'd-def-88',
      'x-hub-signature-256': signPayload('wh-sec', prUnmatched),
    },
    body: prUnmatched,
  })
  expect(resDef.status).toBe(202)
  await client.waitForIdle()
  expect(announced).toHaveLength(1)
  expect(announced[0]!.text).toContain('github:glows777/Vela#pr/88')
  const hubReply = delivered.find((d) => d.replyToMessageId === 'ann-1')
  expect(hubReply).toBeDefined()

  // 3. Hot-reload: bad webhook config (port in use or invalid) degrades gracefully without killing daemon
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ webhooks: { port: 0 } }), // missing github/generic -> invalid
  )
  await client.reloadConfig()
  const stErr = await getDaemonStatus({ agentDir })
  expect(stErr.running).toBe(true)
  expect(stErr.webhooks?.enabled).toBe(true)
  expect(stErr.webhooks?.listening).toBe(false)
  expect(stErr.webhooks?.error).toContain('Invalid webhooks')

  // 4. Hot-reload: port collision degrades gracefully
  const blocker = createServer()
  await new Promise<void>((resolve) =>
    blocker.listen(0, '127.0.0.1', () => resolve()),
  )
  cleanups.push(
    () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  )
  const busyPort = (blocker.address() as { port: number }).port
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      webhooks: { port: busyPort, generic: { secret: 's', source: 'ci' } },
    }),
  )
  await client.reloadConfig()
  const stBusy = await getDaemonStatus({ agentDir })
  expect(stBusy.running).toBe(true)
  expect(stBusy.webhooks?.listening).toBe(false)
  expect(stBusy.webhooks?.error).toBeDefined()

  // 5. Hot-reload: remove webhooks stops listener cleanly
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({}))
  await client.reloadConfig()
  const stOff = await getDaemonStatus({ agentDir })
  expect(stOff.webhooks).toEqual({ enabled: false, listening: false })
  void model
})

test('ChannelAdapter control plane: DM auto-bind, requireExistingSession, messages() routing, channel tools, topicModel, preformatted/inlineOnly, routine announce() skip-on-fail, and channels RPC', async () => {
  const root = makeTempDir('vela-s4b1-ctrl-')
  const agentDir = join(root, 'agent')
  const projDir = join(root, 'proj')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projDir, { recursive: true })

  const model = createFauxModel({
    responses: [
      fauxText('DM reply'),
      fauxText('Topic reply'),
      fauxText('Preformatted reply'),
      fauxText('Routine reply'),
    ],
  })

  let failNextAnnounce = false
  const announced: ChannelAnnouncementInput[] = []
  const delivered: ChannelOutboundMessage[] = []
  const channelMessagesLog = [
    {
      id: 'ext-1',
      sessionId: '',
      runId: null,
      seq: 1,
      kind: 'message',
      role: 'user' as const,
      text: 'Visible human unmentioned',
      content: 'Visible human unmentioned',
      senderName: 'Bob',
      senderId: 'ou_bob',
      createdAt: '2026-11-27T00:00:00Z',
    },
  ]
  let ctxRef!: ChannelAdapterContext

  const adapter: ChannelAdapter = {
    name: 'lark',
    async start(ctx) {
      ctxRef = ctx
    },
    async stop() {},
    status: () => ({ connected: true }),
    async fetchAttachment() {
      // 1x1 transparent PNG
      return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      )
    },
    async deliver(msg) {
      delivered.push(msg)
      return { externalMessageId: `m-${delivered.length}` }
    },
    async announce(input) {
      if (failNextAnnounce) {
        failNextAnnounce = false
        throw new Error('lark announce transport down')
      }
      announced.push(input)
      return { externalMessageId: `ann-${announced.length}` }
    },
    async listMessages({ sessionId }) {
      return {
        messages: channelMessagesLog.map((m) => ({ ...m, sessionId })),
      }
    },
    async listChats() {
      return [{ chatId: 'oc_grp', name: 'Dev Group' }]
    },
    async submitFromHost(input) {
      return {
        outcome: 'posted',
        sessionId: input.sessionId ?? 'host-s1',
        messageId: 'host-m1',
      }
    },
    getTools(binding) {
      if (binding.kind !== 'group') return []
      return [
        {
          name: 'search_history',
          description: 'Search channel history',
          inputSchema: z.object({ q: z.string() }),
          readOnly: true,
          execute: ({ q }: { q: string }, toolCtx) => ({
            q,
            chat: toolCtx.externalChatId,
          }),
        },
      ]
    },
  }

  let enabledFlag = true
  const runtime = createRuntime({
    agentDir,
    defaultModel: model,
    onChannelEnabledChange: async (_name, enabled) => {
      enabledFlag = enabled
    },
  })
  cleanups.push(() => runtime.dispose())
  await runtime.registerChannel(adapter)

  // 1. DM auto-creates standalone chat session + direct binding
  await ctxRef.ingest({
    channel: 'lark',
    dedupeKey: 'dm-1',
    externalChatId: 'oc_dm_alice',
    kind: 'direct',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'hello dm',
    timestamp: '2026-11-27T00:00:00Z',
  })
  await runtime.waitForIdle()
  const dmBinding = (await runtime.bindings.list({ channel: 'lark' })).find(
    (b) => b.externalId === 'oc_dm_alice',
  )
  expect(dmBinding?.kind).toBe('direct')
  expect(dmBinding?.sessionId).toBeTruthy()
  expect(delivered.some((d) => d.text === 'DM reply')).toBe(true)

  // Topic inherits topicModel/topicThinkingLevel when created on a project with topic overrides
  const inheritProj = await runtime.projects.create({
    name: 'InheritProj',
    cwd: projDir,
    defaultModel: 'openai/gpt-4o',
    defaultThinkingLevel: 'low',
    config: {
      topicModel: 'openai/gpt-4.1',
      topicThinkingLevel: 'high',
    },
  })
  const topicInherited = await runtime.sessions.create({
    projectId: inheritProj.id,
    kind: 'topic',
    name: 'Inherited',
  })
  expect(topicInherited.model).toBe('openai/gpt-4.1')
  expect(topicInherited.thinkingLevel).toBe('high')

  // Group project with explicit defaultTools + channel tool (uses injected faux defaultModel)
  const proj = await runtime.projects.create({
    name: 'LarkGroup',
    cwd: projDir,
    hubSessionId: true,
    defaultTools: ['read', 'search_history'],
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_grp',
    kind: 'group',
    projectId: proj.id,
    enabled: true,
  })

  // Unknown thread with requireExistingSession=true does NOT create a topic session
  const beforeCount = (await runtime.sessions.list({ projectId: proj.id }))
    .length
  await ctxRef.ingest({
    channel: 'lark',
    dedupeKey: 'unmentioned-thread-1',
    externalChatId: 'oc_grp',
    kind: 'group',
    threadId: 'omt_unknown',
    messageId: 'om_unknown',
    senderId: 'ou_bob',
    senderName: 'Bob',
    text: 'unmentioned foreign thread',
    requireExistingSession: true,
    timestamp: '2026-11-27T00:00:01Z',
  })
  expect((await runtime.sessions.list({ projectId: proj.id })).length).toBe(
    beforeCount,
  )

  // Create topic with faux model to test channel tools, defaultTools preservation, preformatted, and inlineOnly
  const topicWork = await runtime.sessions.create({
    projectId: proj.id,
    kind: 'topic',
    name: 'WorkTopic',
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_grp',
    threadId: 'omt_work',
    kind: 'group',
    projectId: proj.id,
    sessionId: topicWork.id,
    enabled: true,
  })
  // Inspect shows search_history AND preserved control tools despite explicit defaultTools=['read', 'search_history']
  const topicSnap = await runtime.sessions.inspect(topicWork.id)
  expect(topicSnap.allTools).toContain('search_history')
  expect(topicSnap.activeTools).toContain('search_history')
  expect(topicSnap.activeTools).toContain('session_list')
  expect(topicSnap.activeTools).toContain('skip_reply')
  expect(topicSnap.activeTools).toContain('wait_for_input')
  expect(topicSnap.activeTools).not.toContain('session_start')

  // Unbound local session does NOT get lark's search_history tool
  const localSess = await runtime.sessions.create({
    location: { environment: 'local', cwd: projDir },
  })
  expect((await runtime.sessions.inspect(localSess.id)).allTools).not.toContain(
    'search_history',
  )

  // messages() routes bound session via adapter.listMessages(), unbound via vela_messages
  const boundMsgs = await runtime.sessions.messages({ sessionId: topicWork.id })
  expect(boundMsgs.messages).toHaveLength(1)
  expect(boundMsgs.messages[0]!.senderName).toBe('Bob')
  const unboundMsgs = await runtime.sessions.messages({
    sessionId: localSess.id,
  })
  expect(unboundMsgs.messages).toEqual([])

  // Preformatted + inlineOnly image attachment avoids double "Bob:" prefix and [file:] line
  await runtime.sessions.configure(topicWork.id, { cwd: projDir })
  await ctxRef.ingest({
    channel: 'lark',
    dedupeKey: 'topic-msg-1',
    externalChatId: 'oc_grp',
    kind: 'group',
    threadId: 'omt_work',
    messageId: 'om_t1',
    senderId: 'ou_bob',
    senderName: 'Bob',
    text: 'Context:\nBob: check this',
    preformatted: true,
    rawText: 'check this',
    attachments: [
      {
        name: 'img.png',
        mimeType: 'image/png',
        ref: 'img_key_1',
        inlineOnly: true,
      },
    ],
    timestamp: '2026-11-27T00:00:02Z',
  })
  await runtime.waitForIdle()
  const topicPromptText = JSON.stringify(model.calls[1]!.prompt)
  expect(topicPromptText).toContain('Context:\\nBob: check this')
  expect(topicPromptText).not.toContain('Bob: Context:')
  expect(topicPromptText).not.toContain('[file: img.png')

  // Slash command without preformatted avoids "Bob: /help-ext"
  await ctxRef.ingest({
    channel: 'lark',
    dedupeKey: 'topic-msg-2',
    externalChatId: 'oc_grp',
    kind: 'group',
    threadId: 'omt_work',
    messageId: 'om_t2',
    senderId: 'ou_bob',
    senderName: 'Bob',
    text: '/custom_cmd arg',
    timestamp: '2026-11-27T00:00:03Z',
  })
  await runtime.waitForIdle()
  const cmdPromptText = JSON.stringify(model.calls[2]!.prompt)
  expect(cmdPromptText).toContain('/custom_cmd arg')
  expect(cmdPromptText).not.toContain('Bob: /custom_cmd')

  // Routine top-level announcement: success then fail-to-skip without LLM call
  const hubId = proj.hubSessionId!
  await runtime.sessions.configure(hubId, { cwd: projDir })
  // First: failing announce skips LLM turn completely (model.calls stays at 3)
  failNextAnnounce = true
  const rFail = await runtime.timers.createRoutine({
    projectId: proj.id,
    sessionId: hubId,
    target: { channel: 'lark', externalChatId: 'oc_grp' },
    creatorId: 'ou_alice',
    creatorName: 'Alice',
    message: 'Daily standup',
    schedule: { at: new Date(Date.now() - 5_000).toISOString() },
    nowMs: Date.now() - 10_000,
  })
  await runtime.recover()
  await new Promise((r) => setTimeout(r, 30))
  await runtime.waitForIdle()
  expect(failNextAnnounce).toBe(false)
  expect(model.calls.length).toBe(3)
  void rFail

  // Second: succeeding announce posts ⏰ header and threads reply under ann-1
  await runtime.timers.createRoutine({
    projectId: proj.id,
    sessionId: hubId,
    target: { channel: 'lark', externalChatId: 'oc_grp' },
    creatorId: 'ou_alice',
    creatorName: 'Alice',
    message: 'Daily sync',
    schedule: { at: new Date(Date.now() - 5_000).toISOString() },
    nowMs: Date.now() - 10_000,
  })
  await runtime.recover()
  await new Promise((r) => setTimeout(r, 30))
  await runtime.waitForIdle()
  expect(model.calls.length).toBe(4)
  expect(announced).toHaveLength(1)
  expect(announced[0]!.text).toContain('⏰ Daily sync (set by Alice')
  const routineOut = delivered.find(
    (d) => d.replyToMessageId === 'ann-1' && d.text === 'Routine reply',
  )
  expect(routineOut).toBeDefined()
  expect(routineOut!.isRoutine).toBe(true)

  // channels.{list, setEnabled, chats, submit}
  expect(await runtime.channels.chats('lark')).toEqual([
    { chatId: 'oc_grp', name: 'Dev Group' },
  ])
  expect(
    await runtime.channels.submit('lark', {
      chatId: 'oc_grp',
      text: 'hi',
      author: { id: 'vela-app', name: 'Vela app' },
    }),
  ).toEqual({ outcome: 'posted', sessionId: 'host-s1', messageId: 'host-m1' })
  const toggled = await runtime.channels.setEnabled('lark', false)
  expect(toggled.enabled).toBe(false)
  expect(enabledFlag).toBe(false)
})
