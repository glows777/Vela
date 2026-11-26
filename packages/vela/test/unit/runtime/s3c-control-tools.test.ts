import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../../src/db/sqlite.ts'
import { saveTrust } from '../../../src/db/trust.ts'
import { createVelaAgentDriver } from '../../../src/driver/runtime-adapter.ts'
import { createRuntimeMcpAdapter } from '../../../src/mcp/index.ts'
import { sendProjectSessionMessage } from '../../../src/runtime/control-ops.ts'
import {
  type ChannelAdapter,
  type ChannelOutboundMessage,
  VelaRuntimeEngine,
} from '../../../src/runtime/index.ts'
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
