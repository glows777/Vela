import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../../src/db/sqlite.ts'
import { saveTrust } from '../../../src/db/trust.ts'
import type { ExecutionEnv } from '../../../src/driver/execution/types.ts'
import { createVelaAgentDriver } from '../../../src/driver/runtime-adapter.ts'
import { buildRuntimePromptSections } from '../../../src/driver/runtime-prompt.ts'
import { ToolRegistry } from '../../../src/driver/tools/registry.ts'
import { createRuntimeMcpAdapter } from '../../../src/mcp/index.ts'
import { createApprovalRequest } from '../../../src/runtime/approvals.ts'
import {
  forwardToProjectSession,
  readProjectSessionMessages,
  sendProjectSessionMessage,
  startProjectSession,
} from '../../../src/runtime/control-ops.ts'
import {
  isTopicAwaitingBindingInDb,
  listSessionsWithPendingWake,
} from '../../../src/runtime/inbox.ts'
import {
  type ChannelAdapter,
  type ChannelOutboundMessage,
  EnvironmentRegistry,
  VelaRuntimeEngine,
} from '../../../src/runtime/index.ts'
import { claimNextTurnInDb } from '../../../src/runtime/worker.ts'
import {
  createFauxModel,
  type FauxStep,
  fauxText,
  fauxToolCall,
} from '../../../src/testing/core/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function createRuntimeWithDriver(options: {
  root: string
  responses: FauxStep[]
  agentDir?: string
  offline?: boolean
  mcp?: ReturnType<typeof createRuntimeMcpAdapter>
}) {
  const db = openDatabase({ path: join(options.root, 'vela.db') })
  const agentDir = options.agentDir ?? options.root
  const model = createFauxModel({ responses: options.responses })
  const runtime = new VelaRuntimeEngine({ db, agentDir })
  const driver = createVelaAgentDriver({
    db,
    agentDir,
    blobs: runtime.blobs,
    environments: runtime.environments,
    timers: runtime.timers,
    subscriptions: runtime.subscriptions,
    eventBus: runtime.eventBus,
    wakeSession: (sid) => runtime.scheduleSession(sid),
    defaultModel: model,
    offline: options.offline ?? true,
    mcp: options.mcp,
  })
  runtime.registerDriver(driver)
  return { db, runtime, model, driver }
}

test('subscriptions auto-remove final matches and ignore non-final cleanup', () => {
  const root = tempRoot('vela-s3c-subs-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  try {
    const project = runtime.projects.create({ name: 'p', cwd: root })
    const s1 = runtime.sessions.create({ projectId: project.id, kind: 'work' })
    const sub = runtime.subscriptions.create({
      source: 'github',
      eventKey: 'pr:42',
      projectId: project.id,
      sessionId: s1.id,
    })
    expect(runtime.subscriptions.list({ sessionId: s1.id })).toHaveLength(1)

    const hit1 = runtime.subscriptions.dispatchEvent({
      source: 'github',
      eventKey: 'pr:42',
      dedupeKey: 'ev-1',
      summary: 'CI running',
      final: false,
    })
    expect(hit1.matchedSessionIds).toEqual([s1.id])
    expect(runtime.subscriptions.list({ sessionId: s1.id })).toHaveLength(1)

    const hit2 = runtime.subscriptions.dispatchEvent({
      source: 'github',
      eventKey: 'pr:42',
      dedupeKey: 'ev-2',
      summary: 'CI passed',
      final: true,
    })
    expect(hit2.matchedSessionIds).toEqual([s1.id])
    expect(runtime.subscriptions.list({ sessionId: s1.id })).toHaveLength(0)
    expect(
      db.get('SELECT 1 FROM subscriptions WHERE id = ?', sub.id),
    ).toBeUndefined()
  } finally {
    void runtime.dispose()
    db.close()
  }
})

test('session_start, topic_start channel binding writeback, session_forward, session_list, session_read, and child hub wake=0 note', async () => {
  const root = tempRoot('vela-s3c-sessions-')
  const delivered: ChannelOutboundMessage[] = []
  let ingest!: (
    msg: Parameters<Parameters<ChannelAdapter['start']>[0]['ingest']>[0],
  ) => Promise<void>
  let dbRef!: ReturnType<typeof openDatabase>
  let runtimeRef!: VelaRuntimeEngine

  let hubStep = 0
  let childStep = 0
  const result = createRuntimeWithDriver({
    root,
    responses: Array.from({ length: 8 }, () => (req) => {
      const isHub = req.system.includes('You are the hub session')
      if (isHub) {
        switch (hubStep++) {
          case 0:
            return fauxToolCall('session_start', {
              title: 'Investigate flaky build',
              brief: 'Check why build step fails cleanly',
            })
          case 1:
            return fauxText('Started worker')
          case 2: {
            expect(req.lastUserText).toContain('[Background note]')
            expect(req.lastUserText).toContain('Build fixed in Makefile')
            const worker = runtimeRef.sessions
              .list()
              .find((s) => s.kind === 'topic')!
            return fauxToolCall('session_read', { session_id: worker.id })
          }
          case 3:
            return fauxToolCall('session_list', {})
          case 4: {
            const worker = runtimeRef.sessions
              .list()
              .find((s) => s.kind === 'topic')!
            return fauxToolCall('session_forward', {
              session_id: worker.id,
              text: 'Also verify lint',
            })
          }
          default:
            return fauxText('Forwarded follow-up')
        }
      }
      return childStep++ === 0
        ? fauxText('Build fixed in Makefile')
        : fauxText('Lint verified')
    }),
  })
  const { db, runtime, model } = result
  dbRef = db
  runtimeRef = runtime

  try {
    await runtime.registerChannel({
      name: 'lark',
      async start(ctx) {
        ingest = ctx.ingest
      },
      async stop() {},
      async deliver(msg) {
        delivered.push(msg)
        return {
          externalMessageId: `ext-${delivered.length}`,
          threadId: msg.kind === 'topic_start' ? 'omt_topic_99' : msg.threadId,
        }
      },
    })

    const project = runtime.projects.create({ name: 'proj', cwd: root })
    const hub = runtime.sessions.create({
      projectId: project.id,
      kind: 'hub',
      location: { environment: 'local', cwd: root },
    })
    runtime.projects.update(project.id, { hubSessionId: hub.id })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-hub-1',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })

    await ingest({
      channel: 'lark',
      dedupeKey: 'in-1',
      externalChatId: 'chat-hub-1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      mentioned: true,
      text: 'Please investigate the flaky build',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(hub.id)

    const child = runtime.sessions
      .list({ projectId: project.id })
      .find((s) => s.kind === 'topic')!
    expect(child).toBeDefined()
    expect(child.name).toBe('Investigate flaky build')

    await runtime.waitForIdle(child.id)
    const childBinding = dbRef.get<{ thread_id: string | null }>(
      'SELECT thread_id FROM channel_bindings WHERE session_id = ?',
      child.id,
    )
    expect(childBinding?.thread_id).toBe('omt_topic_99')

    runtime.submitPrompt({ sessionId: hub.id, text: 'Status check' })
    await runtime.waitForIdle(hub.id)
    await runtime.waitForIdle(child.id)

    expect(delivered.some((m) => m.kind === 'topic_start')).toBe(true)
    expect(
      delivered.some((m) => m.text.includes('Build fixed in Makefile')),
    ).toBe(true)
    expect(delivered.some((m) => m.text.includes('Lint verified'))).toBe(true)
    const listToolRes = model.calls
      .flatMap((c) => c.toolResults)
      .find((r) => r.toolName === 'session_list')
    expect(listToolRes?.output).toContain('Investigate flaky build')
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('session_message enforces MAX_DEPTH = 3 across handoffs', async () => {
  const root = tempRoot('vela-s3c-depth-')
  const { db, runtime } = createRuntimeWithDriver({
    root,
    responses: [fauxText('pong')],
  })
  try {
    const project = runtime.projects.create({ name: 'p', cwd: root })
    const hub = runtime.sessions.create({ projectId: project.id, kind: 'hub' })
    const workerA = runtime.sessions.create({
      projectId: project.id,
      kind: 'work',
      name: 'A',
    })
    const workerB = runtime.sessions.create({
      projectId: project.id,
      kind: 'work',
      name: 'B',
    })
    runtime.projects.update(project.id, { hubSessionId: hub.id })

    expect(() =>
      sendProjectSessionMessage(
        {
          db,
          blobs: runtime.blobs,
          eventBus: runtime.eventBus,
          scheduleSession: (sid) => runtime.scheduleSession(sid),
        },
        {
          callerSessionId: workerA.id,
          target: workerB.id,
          text: 'cascade beyond cap',
          currentHandoffDepth: 3,
        },
      ),
    ).toThrow(/chain limit/i)

    const ok = sendProjectSessionMessage(
      {
        db,
        blobs: runtime.blobs,
        eventBus: runtime.eventBus,
        scheduleSession: (sid) => runtime.scheduleSession(sid),
      },
      {
        callerSessionId: workerA.id,
        target: workerB.id,
        text: 'depth 1 ok',
        currentHandoffDepth: 0,
      },
    )
    expect(ok.queued).toBe(true)
    expect(ok.target.id).toBe(workerB.id)
    await runtime.waitForIdle(workerB.id)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('timers and subscriptions tools create, list, edit, and cancel/remove scoped records', async () => {
  const root = tempRoot('vela-s3c-timers-subs-')
  const { db, runtime, model } = createRuntimeWithDriver({
    root,
    responses: [
      fauxToolCall('timers', {
        action: 'create',
        kind: 'routine',
        message: 'Daily standup reminder',
        schedule: { time: '09:30', days: ['mon', 'fri'] },
        timezone: 'UTC',
      }),
      fauxToolCall('timers', { action: 'list' }),
      fauxToolCall('subscriptions', {
        action: 'create',
        source: 'github',
        key: 'repo:vela#99',
      }),
      fauxToolCall('subscriptions', { action: 'list' }),
      fauxText('All configured'),
    ],
  })
  try {
    const project = runtime.projects.create({ name: 'p', cwd: root })
    const s = runtime.sessions.create({
      projectId: project.id,
      kind: 'hub',
      location: { environment: 'local', cwd: root },
    })
    runtime.submitPrompt({
      sessionId: s.id,
      text: 'Set timer and subscription',
    })
    await runtime.waitForIdle(s.id)

    expect(runtime.timers.list({ projectId: project.id })).toHaveLength(1)
    expect(runtime.subscriptions.list({ projectId: project.id })).toHaveLength(
      1,
    )
    const subList = model.calls
      .flatMap((c) => c.toolResults)
      .find(
        (r) =>
          r.toolName === 'subscriptions' && r.output.includes('repo:vela#99'),
      )
    expect(subList).toBeDefined()
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('wait_for_input puts session into waiting_human, sets waiting_reason, and human reply auto-resumes', async () => {
  const root = tempRoot('vela-s3c-wait-')
  const delivered: ChannelOutboundMessage[] = []
  let ingest!: (
    msg: Parameters<Parameters<ChannelAdapter['start']>[0]['ingest']>[0],
  ) => Promise<void>

  const { db, runtime } = createRuntimeWithDriver({
    root,
    responses: [
      fauxToolCall('wait_for_input', {
        reason: 'Need production vs staging confirmation',
      }),
      fauxText('Should I deploy to staging or production?'),
      (req) => {
        expect(req.lastUserText).toContain('staging please')
        return fauxText('Deploying to staging now')
      },
    ],
  })
  try {
    await runtime.registerChannel({
      name: 'lark',
      async start(ctx) {
        ingest = ctx.ingest
      },
      async stop() {},
      async deliver(msg) {
        delivered.push(msg)
        return { externalMessageId: `out-${delivered.length}` }
      },
    })

    const project = runtime.projects.create({ name: 'p', cwd: root })
    const s = runtime.sessions.create({
      projectId: project.id,
      kind: 'topic',
      location: { environment: 'local', cwd: root },
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-w1',
      threadId: 'thr-w1',
      kind: 'group',
      projectId: project.id,
      sessionId: s.id,
      enabled: true,
    })

    await ingest({
      channel: 'lark',
      dedupeKey: 'w-in-1',
      externalChatId: 'chat-w1',
      threadId: 'thr-w1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: 'Deploy the release',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(s.id)

    const waiting = runtime.sessions.get(s.id)!
    expect(waiting.state).toBe('waiting_human')
    expect(waiting.waitingReason).toBe(
      'Need production vs staging confirmation',
    )
    expect(
      delivered.some((m) => m.text.includes('staging or production')),
    ).toBe(true)

    await ingest({
      channel: 'lark',
      dedupeKey: 'w-in-2',
      externalChatId: 'chat-w1',
      threadId: 'thr-w1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: 'staging please',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(s.id)

    const done = runtime.sessions.get(s.id)!
    expect(done.state).toBe('idle')
    expect(done.waitingReason).toBeNull()
    expect(
      delivered.some((m) => m.text.includes('Deploying to staging now')),
    ).toBe(true)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('skip_reply suppresses outbox only on channel-bound sessions and is hidden on non-channel sessions', async () => {
  const root = tempRoot('vela-s3c-skip-')
  const delivered: ChannelOutboundMessage[] = []
  let ingest!: (
    msg: Parameters<Parameters<ChannelAdapter['start']>[0]['ingest']>[0],
  ) => Promise<void>

  const { db, runtime, model } = createRuntimeWithDriver({
    root,
    responses: [
      (req) => {
        expect(req.tools).not.toContain('skip_reply')
        return fauxText('plain reply')
      },
      (req) => {
        expect(req.tools).toContain('skip_reply')
        return fauxToolCall('skip_reply', {})
      },
      fauxText('internal acknowledgment never sent'),
    ],
  })

  try {
    await runtime.registerChannel({
      name: 'lark',
      async start(ctx) {
        ingest = ctx.ingest
      },
      async stop() {},
      async deliver(msg) {
        delivered.push(msg)
        return { externalMessageId: `m-${delivered.length}` }
      },
    })

    const localOnly = runtime.sessions.create({
      kind: 'chat',
      location: { environment: 'local', cwd: root },
    })
    runtime.submitPrompt({ sessionId: localOnly.id, text: 'hi local' })
    await runtime.waitForIdle(localOnly.id)

    const chSession = runtime.sessions.create({
      kind: 'chat',
      location: { environment: 'local', cwd: root },
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-silent',
      kind: 'direct',
      sessionId: chSession.id,
      enabled: true,
    })
    await ingest({
      channel: 'lark',
      dedupeKey: 'skip-in-1',
      externalChatId: 'chat-silent',
      kind: 'direct',
      senderId: 'u1',
      senderName: 'Liam',
      text: 'just FYI',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(chSession.id)

    expect(model.calls).toHaveLength(3)
    expect(delivered).toHaveLength(0)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('send_file snapshots workspace file to blob and enqueues outbox file item when active', async () => {
  const root = tempRoot('vela-s3c-sendfile-')
  const delivered: ChannelOutboundMessage[] = []
  writeFileSync(join(root, 'report.txt'), 'Q4 metrics summary\n')

  const { db, runtime } = createRuntimeWithDriver({
    root,
    responses: [
      fauxToolCall('send_file', { path: 'report.txt' }),
      fauxText('Sent the report'),
    ],
  })

  try {
    await runtime.registerChannel({
      name: 'lark',
      async start() {},
      async stop() {},
      async deliver(msg) {
        delivered.push(msg)
        return { externalMessageId: `f-${delivered.length}` }
      },
    })

    const project = runtime.projects.create({ name: 'p', cwd: root })
    const hub = runtime.sessions.create({
      projectId: project.id,
      kind: 'hub',
      location: { environment: 'local', cwd: root },
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-file',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })
    runtime.submitPrompt({ sessionId: hub.id, text: 'Send report.txt' })
    await runtime.waitForIdle(hub.id)

    const fileMsg = delivered.find((m) => m.kind === 'file')
    expect(fileMsg).toBeDefined()
    expect(fileMsg?.files?.[0]?.name).toBe('report.txt')
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('VelaAgentDriver gates workspace resources by trusted_paths, attaches MCP pool for tool_search, and disposes cleanly', async () => {
  const root = tempRoot('vela-s3c-driver-wiring-')
  const workspace = join(root, 'repo')
  const agentDir = join(root, 'agent')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'SECRET_WORKSPACE_RULE_XYZ\n')

  let serverToolsCalled = 0
  const mcp = createRuntimeMcpAdapter({
    idleTtlMs: 0,
    async createTransport(entry) {
      const { InMemoryTransport } = await import(
        '@modelcontextprotocol/sdk/inMemory.js'
      )
      const { Server } = await import(
        '@modelcontextprotocol/sdk/server/index.js'
      )
      const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
        '@modelcontextprotocol/sdk/types.js'
      )
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
      const srv = new Server(
        { name: entry.name, version: '1.0.0' },
        { capabilities: { tools: {} } },
      )
      srv.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'ping',
            description: 'Deferred ping tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }))
      srv.setRequestHandler(CallToolRequestSchema, async () => {
        serverToolsCalled++
        return { content: [{ type: 'text', text: 'pong-mcp' }] }
      })
      await srv.connect(serverTransport)
      return clientTransport
    },
  })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      mcpServers: {
        demo: {
          command: 'fake-mcp',
          exposure: 'deferred',
        },
      },
    }),
  )

  const db = openDatabase({ path: join(root, 'vela.db') })
  const model = createFauxModel({
    responses: [
      (req) => {
        expect(req.system).not.toContain('SECRET_WORKSPACE_RULE_XYZ')
        expect(req.tools).toContain('tool_search')
        return fauxToolCall('tool_search', { query: 'ping' })
      },
      (req) => {
        expect(req.tools).toContain('mcp__demo__ping')
        return fauxToolCall('mcp__demo__ping', {})
      },
      fauxText('MCP worked'),
      (req) => {
        expect(req.system).toContain('SECRET_WORKSPACE_RULE_XYZ')
        return fauxText('Trusted AGENTS loaded')
      },
    ],
  })
  const runtime = new VelaRuntimeEngine({ db, agentDir })
  const driver = createVelaAgentDriver({
    db,
    agentDir,
    blobs: runtime.blobs,
    environments: runtime.environments,
    timers: runtime.timers,
    subscriptions: runtime.subscriptions,
    eventBus: runtime.eventBus,
    defaultModel: model,
    mcp,
  })
  runtime.registerDriver(driver)

  try {
    const s = runtime.sessions.create({
      kind: 'chat',
      location: { environment: 'local', cwd: workspace },
    })
    runtime.submitPrompt({ sessionId: s.id, text: 'Use mcp ping' })
    await runtime.waitForIdle(s.id)
    expect(serverToolsCalled).toBe(1)

    saveTrust(db, workspace, true, agentDir)
    runtime.submitPrompt({ sessionId: s.id, text: 'Check trusted AGENTS' })
    await runtime.waitForIdle(s.id)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('multi-room session_start routes topic to invoking room, clones attachments, waits for topic binding, and forwards human reply to waiting_human child', async () => {
  const root = tempRoot('vela-r1-multiroom-')
  const outbound: Array<ChannelOutboundMessage & { threadId?: string }> = []
  const db = openDatabase({ path: join(root, 'vela.db') })
  let hubStep = 0
  let childStep = 0
  let followUpForward = false
  let childIdRef = ''
  const model = createFauxModel({
    responses: Array.from({ length: 8 }, () => (req) => {
      if (req.system.includes('You are the hub session')) {
        if (followUpForward && hubStep >= 2) {
          if (hubStep === 2) {
            hubStep++
            expect(req.tools).toContain('session_forward')
            return fauxToolCall('session_forward', {
              session_id: childIdRef,
              text: 'Use staging',
            })
          }
          hubStep++
          return fauxText('Handled Hub follow-up')
        }
        return hubStep++ === 0
          ? fauxToolCall('session_start', {
              title: 'Investigate build',
              brief: 'Inspect attached artifact',
            })
          : fauxText('Started investigation in this room.')
      }
      switch (childStep++) {
        case 0:
          expect(req.lastUserText).toContain('spec.txt')
          return fauxToolCall('wait_for_input', { reason: 'Choose target env' })
        case 1:
          return fauxText('Should we target staging or prod?')
        default:
          expect(req.lastUserText).toContain('Use staging')
          return fauxText('Done targeting staging.')
      }
    }),
  })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  let ingest!: Parameters<ChannelAdapter['start']>[0]['ingest']
  await runtime.registerChannel({
    name: 'lark',
    async start(ctx) {
      ingest = ctx.ingest
    },
    async stop() {},
    async fetchAttachment() {
      return new TextEncoder().encode('attached spec')
    },
    async deliver(msg) {
      outbound.push(msg)
      if (msg.kind === 'topic_start') {
        return {
          externalMessageId: 'msg-topic-1',
          rootId: 'om-root-2',
          threadId: 'thread-room-2',
        }
      }
      return { externalMessageId: `msg-${outbound.length}` }
    },
  })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      timers: runtime.timers,
      subscriptions: runtime.subscriptions,
      eventBus: runtime.eventBus,
      defaultModel: model,
      offline: true,
    }),
  )

  try {
    const project = runtime.projects.create({ name: 'proj', cwd: root })
    const hub = runtime.sessions.create({
      projectId: project.id,
      kind: 'hub',
      location: { environment: 'local', cwd: root },
    })
    runtime.projects.update(project.id, { hubSessionId: hub.id })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-room-1',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-room-2',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })

    await ingest({
      channel: 'lark',
      dedupeKey: 'm-room2-1',
      externalChatId: 'chat-room-2',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      mentioned: true,
      text: 'Start investigating the attached spec',
      timestamp: new Date().toISOString(),
      attachments: [{ ref: 'ref-spec-1', name: 'spec.txt' }],
    })
    await runtime.waitForIdle(hub.id)

    const child = runtime.sessions
      .list({ projectId: project.id })
      .find((s) => s.id !== hub.id)!
    expect(child).toBeDefined()
    expect(child.kind).toBe('topic')
    await runtime.waitForIdle(child.id)

    const topicStart = outbound.find((m) => m.kind === 'topic_start')
    expect(topicStart?.externalChatId).toBe('chat-room-2')
    expect(outbound.some((m) => m.threadId === 'thread-room-2')).toBe(true)
    expect(runtime.sessions.get(child.id)?.state).toBe('waiting_human')

    childIdRef = child.id
    followUpForward = true
    await ingest({
      channel: 'lark',
      dedupeKey: 'm-room2-2',
      externalChatId: 'chat-room-2',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      mentioned: true,
      text: 'Use staging',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(hub.id)
    await runtime.waitForIdle(child.id)
    expect(
      outbound.some((m) => m.text.includes('Done targeting staging.')),
    ).toBe(true)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('control ops enforce missing topic routing identity, null leaf read, non-human forward guard, followup timer edit, and final subscription replay', async () => {
  const root = tempRoot('vela-r1-ops-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  await runtime.registerChannel({
    name: 'lark',
    async start() {},
    async stop() {},
    async deliver(msg) {
      if (msg.kind === 'topic_start') {
        return { externalMessageId: 'root-only-empty' }
      }
      return { externalMessageId: 'ok-1' }
    },
  })

  try {
    const project = runtime.projects.create({ name: 'p', cwd: root })
    const hub = runtime.sessions.create({
      projectId: project.id,
      kind: 'hub',
      location: { environment: 'local', cwd: root },
    })
    runtime.projects.update(project.id, { hubSessionId: hub.id })
    const child = runtime.sessions.create({
      projectId: project.id,
      kind: 'work',
      parentSessionId: hub.id,
      location: { environment: 'local', cwd: root },
    })
    // session_read on null leaf returns empty messages
    expect(
      readProjectSessionMessages(db, {
        callerSessionId: hub.id,
        targetSessionId: child.id,
      }).messages,
    ).toEqual([])

    // Non-human provenance cannot forward to a waiting_human child
    db.run(
      "UPDATE sessions SET state = 'waiting_human', waiting_reason = 'need input' WHERE id = ?",
      child.id,
    )
    expect(() =>
      forwardToProjectSession(
        {
          db,
          blobs: runtime.blobs,
          eventBus: runtime.eventBus,
          scheduleSession: () => {},
        },
        {
          callerSessionId: hub.id,
          targetSessionId: child.id,
          text: 'auto reply',
        },
      ),
    ).toThrow(/waiting for human input/)

    // Final subscription delivery replay must not delete a recreated subscription
    runtime.subscriptions.create({
      projectId: project.id,
      sessionId: hub.id,
      source: 'github',
      eventKey: 'task.done',
    })
    const first = runtime.subscriptions.dispatchEvent({
      source: 'github',
      eventKey: 'task.done',
      dedupeKey: 'del-1',
      summary: 'done 1',
      final: true,
    })
    expect(first.matchedSessionIds).toEqual([hub.id])
    expect(runtime.subscriptions.list({ sessionId: hub.id })).toHaveLength(0)

    runtime.subscriptions.create({
      projectId: project.id,
      sessionId: hub.id,
      source: 'github',
      eventKey: 'task.done',
    })
    const replay = runtime.subscriptions.dispatchEvent({
      source: 'github',
      eventKey: 'task.done',
      dedupeKey: 'del-1',
      summary: 'done 1',
      final: true,
    })
    expect(replay.matchedSessionIds).toEqual([])
    expect(runtime.subscriptions.list({ sessionId: hub.id })).toHaveLength(1)

    // Outbox throws when topic_start returns no routing IDs at all
    await runtime.unregisterChannel('lark')
    await runtime.registerChannel({
      name: 'lark',
      async start() {},
      async stop() {},
      async deliver() {
        return {}
      },
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-empty',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })
    const badChild = await startProjectSession(
      {
        db,
        blobs: runtime.blobs,
        eventBus: runtime.eventBus,
        scheduleSession: () => {},
      },
      {
        callerSessionId: hub.id,
        title: 'Bad topic',
        brief: 'Needs binding',
      },
    )
    await expect(runtime.outbox.flushOnce()).resolves.toMatchObject({
      failed: 1,
    })
    expect(
      db.get(
        'SELECT 1 FROM channel_bindings WHERE session_id = ?',
        badChild.sessionId,
      ),
    ).toBeUndefined()
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('restricted network overrides +web_fetch and explicit selection, prompt sections filter inactive tools, and non-local symlink trust + MCP isolation hold', async () => {
  const reg = new ToolRegistry('/tmp/unused-spill')
  reg.register({
    name: 'read',
    description: 'read',
    inputSchema: {} as never,
    execute: async () => '',
  })
  reg.register({
    name: 'web_fetch',
    description: 'web_fetch',
    inputSchema: {} as never,
    execute: async () => '',
  })
  reg.setRestrictedNetwork(true)
  reg.setDefaultToolModifiers(['+web_fetch'])
  reg.setSelection(['read', 'web_fetch'])
  expect(reg.getActiveTools().map((t) => t.name)).toEqual(['read'])

  const hubSections = buildRuntimePromptSections({
    kind: 'hub',
    projectId: 'p1',
    hasChannelBinding: true,
    activeTools: new Set(['read']),
  })
  expect(hubSections.projectSession).not.toContain('session_start')
  expect(hubSections.projectSession).not.toContain('timers')
  expect(hubSections.channelGuide).not.toContain('skip_reply')

  // Non-local canonical symlink trust + MCP isolation
  const root = tempRoot('vela-r1-trust-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const environments = new EnvironmentRegistry({
    dataDir: root,
    environments: { dev: { image: 'node:22', network: 'restricted' } },
    openDocker: async () =>
      ({
        id: 'docker:dev',
        cwd: '/trusted/link',
        async canonicalPath(p: string) {
          return {
            ok: true as const,
            value: p === '/trusted/link' ? '/denied/real' : p,
          }
        },
        async readTextFile() {
          return {
            ok: true as const,
            value:
              '# Project Rules\nSHOULD_NEVER_LOAD_FROM_SYMLINKED_UNTRUSTED_DIR',
          }
        },
        async exists() {
          return { ok: true as const, value: true }
        },
        async listDir() {
          return { ok: true as const, value: [] }
        },
        async cleanup() {},
      }) as unknown as ExecutionEnv,
  })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root, environments })
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      mcpServers: {
        hostOnlyServer: { command: 'false' },
      },
    }),
  )
  saveTrust(db, { environment: 'dev', cwd: '/trusted/link' }, true, root)
  saveTrust(db, { environment: 'dev', cwd: '/denied/real' }, false, root)

  const model = createFauxModel({
    responses: [fauxText('Isolated safely')],
  })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: model,
      mcp: createRuntimeMcpAdapter(),
    }),
  )

  try {
    const s = runtime.sessions.create({
      kind: 'chat',
      location: { environment: 'dev', cwd: '/trusted/link' },
    })
    runtime.submitPrompt({ sessionId: s.id, text: 'hello' })
    await runtime.waitForIdle(s.id)
    const runRow = db.get<{ status: string }>(
      'SELECT status FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1',
      s.id,
    )
    expect(runRow?.status).toBe('completed')
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]!.system).not.toContain(
      'SHOULD_NEVER_LOAD_FROM_SYMLINKED_UNTRUSTED_DIR',
    )
    expect(model.calls[0]!.system).not.toContain('hostOnlyServer')
    expect(model.calls[0]!.tools.some((name) => name.startsWith('mcp__'))).toBe(
      false,
    )
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R2: topic readiness matches claim predicate, failed topic notifies hub without running, partial attachment rollback cleans up, room batching & timers stay isolated, and approval resume keeps metadata', async () => {
  const root = tempRoot('vela-r2-ctrl-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const delivered: ChannelOutboundMessage[] = []
  let deliverCalls = 0
  let ingest!: Parameters<ChannelAdapter['start']>[0]['ingest']
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  await runtime.registerChannel({
    name: 'lark',
    async start(ctx) {
      ingest = ctx.ingest
    },
    async stop() {},
    async fetchAttachment(ref) {
      return new TextEncoder().encode(`file:${ref}`)
    },
    async deliver(msg) {
      deliverCalls++
      if (msg.kind === 'topic_start' && msg.text === 'Fail permanently') {
        throw new Error('Topic creation API rejected')
      }
      delivered.push(msg)
      return { externalMessageId: `out-${deliverCalls}` }
    },
  })

  try {
    const project = runtime.projects.create({ name: 'p2', cwd: root })
    const hub = runtime.sessions.create({
      projectId: project.id,
      kind: 'hub',
      location: { environment: 'local', cwd: root },
    })
    runtime.projects.update(project.id, { hubSessionId: hub.id })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-A',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-B',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })

    // 1. Topic readiness + 5-failure settlement
    const failing = await startProjectSession(
      {
        db,
        blobs: runtime.blobs,
        eventBus: runtime.eventBus,
        scheduleSession: () => {},
      },
      {
        callerSessionId: hub.id,
        title: 'Fail permanently',
        brief: 'Never runs without topic binding',
      },
    )
    expect(isTopicAwaitingBindingInDb(db, failing.sessionId)).toBe(true)
    expect(listSessionsWithPendingWake(db)).not.toContain(failing.sessionId)
    expect(
      claimNextTurnInDb({
        db,
        sessions: runtime.sessions,
        eventBus: runtime.eventBus,
        activeOwners: new Set(),
        sessionId: failing.sessionId,
      }),
    ).toBeUndefined()

    for (let i = 0; i < 5; i++) {
      db.run(
        "UPDATE outbox SET next_retry_at = NULL WHERE session_id = ? AND kind = 'topic_start'",
        failing.sessionId,
      )
      await runtime.outbox.flushOnce()
    }
    const topicOutbox = db.get<{ status: string }>(
      "SELECT status FROM outbox WHERE session_id = ? AND kind = 'topic_start'",
      failing.sessionId,
    )
    expect(topicOutbox?.status).toBe('failed')
    expect(isTopicAwaitingBindingInDb(db, failing.sessionId)).toBe(true)
    expect(
      claimNextTurnInDb({
        db,
        sessions: runtime.sessions,
        eventBus: runtime.eventBus,
        activeOwners: new Set(),
        sessionId: failing.sessionId,
      }),
    ).toBeUndefined()
    const hubFailureNote = db.get<{ payload_json: string }>(
      "SELECT payload_json FROM inbox_events WHERE session_id = ? AND dedupe_key LIKE 'topic-failed:%'",
      hub.id,
    )
    expect(hubFailureNote?.payload_json).toContain(
      'failed to open its topic thread',
    )

    // 2. Partial attachment cloning rollback leaves zero orphan rows
    const validBlob = await runtime.blobs.storeInbound({
      sessionId: hub.id,
      projectId: project.id,
      filename: 'ok.txt',
      bytes: new TextEncoder().encode('ok'),
    })
    await expect(
      startProjectSession(
        {
          db,
          blobs: runtime.blobs,
          eventBus: runtime.eventBus,
          scheduleSession: () => {},
        },
        {
          callerSessionId: hub.id,
          title: 'Rollback test',
          brief: 'Second blob missing',
          attachments: [
            { blobId: validBlob.id, name: 'ok.txt' },
            { blobId: 'missing-blob-id', name: 'missing.txt' },
          ],
        },
      ),
    ).rejects.toThrow(/not found/)
    expect(
      db.all<{ id: string }>('SELECT id FROM blobs WHERE session_id IS NULL'),
    ).toHaveLength(0)

    // 3. Approval resumption + batched rooms + room-B timer delivery
    const childWaiting = runtime.sessions.create({
      projectId: project.id,
      kind: 'work',
      parentSessionId: hub.id,
      location: { environment: 'local', cwd: root },
    })
    db.run(
      "UPDATE sessions SET state = 'waiting_human', waiting_reason = 'Pick env' WHERE id = ?",
      childWaiting.id,
    )
    db.run(
      `INSERT INTO runs (id, session_id, project_id, driver, trigger, status, started_at, updated_at)
       VALUES ('run-wait-c', ?, ?, 'vela', 'session', 'waiting_human', ?, ?)`,
      childWaiting.id,
      project.id,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    createApprovalRequest(db, runtime.eventBus, {
      sessionId: childWaiting.id,
      projectId: project.id,
      runId: 'run-wait-c',
      toolCallRowId: null,
      toolCallId: null,
      toolName: 'wait_for_input',
      summary: 'Pick env',
      input: { reason: 'Pick env' },
    })

    let hubCall = 0
    const gatedModel = createFauxModel({
      responses: Array.from({ length: 6 }, () => (req) => {
        if (req.system.includes('You are the hub session')) {
          hubCall++
          if (hubCall === 1) {
            return fauxToolCall('bash', { command: 'echo approve-me' })
          }
          if (hubCall === 2) {
            return [
              fauxToolCall('session_forward', {
                session_id: childWaiting.id,
                text: 'Proceed in chat B',
              }),
              fauxToolCall('timers', {
                action: 'create',
                kind: 'followup',
                delay_seconds: 60,
                message: 'Room B reminder',
              }),
            ]
          }
          if (req.lastUserText.includes('Room B reminder')) {
            return fauxText('Reminder delivered to room B')
          }
          return fauxText('Forwarded after approval')
        }
        return fauxText('Child received forwarded approval')
      }),
    })
    runtime.registerDriver(
      createVelaAgentDriver({
        db,
        agentDir: root,
        blobs: runtime.blobs,
        environments: runtime.environments,
        timers: runtime.timers,
        subscriptions: runtime.subscriptions,
        eventBus: runtime.eventBus,
        defaultModel: gatedModel,
        offline: true,
        toolApprovalCheck: async (toolName) =>
          toolName === 'bash'
            ? { requireApproval: true, summary: 'Run bash?' }
            : undefined,
      }),
    )

    await ingest({
      channel: 'lark',
      dedupeKey: 'b-active-1',
      externalChatId: 'chat-B',
      kind: 'group',
      messageId: 'msg-b-1',
      senderId: 'u1',
      senderName: 'Liam',
      mentioned: true,
      text: 'Forward this to child and set reminder',
      timestamp: new Date().toISOString(),
    })
    await ingest({
      channel: 'lark',
      dedupeKey: 'a-passive-1',
      externalChatId: 'chat-A',
      kind: 'group',
      messageId: 'msg-a-passive',
      senderId: 'u2',
      senderName: 'Other',
      passive: true,
      text: 'Passive noise in room A',
      timestamp: new Date().toISOString(),
      attachments: [{ ref: 'room-a-att', name: 'room-a.txt' }],
    })
    await runtime.waitForIdle(hub.id)
    expect(runtime.sessions.get(hub.id)?.state).toBe('waiting_human')

    const pendingApproval = runtime.listPendingApprovals(hub.id)[0]!
    runtime.resolveApproval({
      approvalId: pendingApproval.id,
      decision: 'approved',
    })
    await runtime.waitForIdle(hub.id)
    await runtime.waitForIdle(childWaiting.id)
    expect(runtime.sessions.get(childWaiting.id)?.state).toBe('idle')
    expect(
      delivered.some(
        (m) =>
          m.externalChatId === 'chat-B' &&
          m.text.includes('Forwarded after approval'),
      ),
    ).toBe(true)

    const timerRow = runtime.timers.list({ sessionId: hub.id })[0]!
    db.run(
      'UPDATE timers SET next_fire_at = ? WHERE id = ?',
      new Date(Date.now() - 1000).toISOString(),
      timerRow.id,
    )
    runtime.timers.tick()
    await runtime.waitForIdle(hub.id)
    expect(
      delivered.some(
        (m) =>
          m.externalChatId === 'chat-B' &&
          m.text.includes('Reminder delivered to room B'),
      ),
    ).toBe(true)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R3 Codex P1: wait_for_input resolved via resolveApproval preserves originating Room B route and replyToMessageId on fresh run', async () => {
  const root = tempRoot('vela-r3-wait-route-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const delivered: ChannelOutboundMessage[] = []
  let ingest!: Parameters<ChannelAdapter['start']>[0]['ingest']
  const model = createFauxModel({
    responses: [
      fauxToolCall('wait_for_input', { reason: 'Confirm deployment target' }),
      fauxText('Deploy to staging or prod?'),
      (req) => {
        expect(req.lastUserText).toContain('staging')
        return fauxText('Proceeding with staging deploy')
      },
    ],
  })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  await runtime.registerChannel({
    name: 'lark',
    async start(ctx) {
      ingest = ctx.ingest
    },
    async stop() {},
    async deliver(msg) {
      delivered.push(msg)
      return { externalMessageId: `out-${delivered.length}` }
    },
  })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      timers: runtime.timers,
      subscriptions: runtime.subscriptions,
      eventBus: runtime.eventBus,
      defaultModel: model,
      offline: true,
    }),
  )

  try {
    const project = runtime.projects.create({ name: 'multi-wait', cwd: root })
    const hub = runtime.sessions.create({
      projectId: project.id,
      kind: 'topic',
      location: { environment: 'local', cwd: root },
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-room-A',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-room-B',
      kind: 'group',
      projectId: project.id,
      sessionId: hub.id,
      enabled: true,
    })

    await ingest({
      channel: 'lark',
      dedupeKey: 'room-b-wait-1',
      externalChatId: 'chat-room-B',
      kind: 'group',
      messageId: 'msg-room-B-99',
      senderId: 'u1',
      senderName: 'Liam',
      mentioned: true,
      text: 'Deploy the release',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(hub.id)
    expect(runtime.sessions.get(hub.id)?.state).toBe('waiting_human')

    const approval = runtime.listPendingApprovals(hub.id)[0]!
    runtime.resolveApproval({
      approvalId: approval.id,
      decision: 'approved',
      reason: 'staging',
      decidedBy: 'Liam',
    })
    await runtime.waitForIdle(hub.id)

    const finalOutbox = delivered.find((m) =>
      m.text.includes('Proceeding with staging deploy'),
    )
    expect(finalOutbox).toBeDefined()
    expect(finalOutbox?.externalChatId).toBe('chat-room-B')
    expect(finalOutbox?.replyToMessageId).toBe('msg-room-B-99')
  } finally {
    await runtime.dispose()
    db.close()
  }
})
