import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db/sqlite.ts'
import { projectDataDir } from '../../src/driver/config/paths.ts'
import { createVela } from '../../src/driver/index.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import { exportSavedSession } from '../../src/driver/session/export.ts'
import {
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelOutboundMessage,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import {
  createFauxModel,
  fauxHang,
  fauxText,
} from '../../src/testing/core/index.ts'

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

test('single <agentDir>/vela.db isolates multi-project listSessions/searchSessions and supports --export', async () => {
  const root = tempRoot('vela-s3b-single-db-')
  const agentDir = join(root, 'agent')
  const projA = join(root, 'proj-a')
  const projB = join(root, 'proj-b')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projA, { recursive: true })
  mkdirSync(projB, { recursive: true })

  const dataDirA = projectDataDir(agentDir, projA)
  const dataDirB = projectDataDir(agentDir, projB)

  const velaA = createVela({
    cwd: projA,
    agentDir,
    dataDir: dataDirA,
    model: createFauxModel({ responses: [fauxText('Alpha answer')] }),
  })
  const velaB = createVela({
    cwd: projB,
    agentDir,
    dataDir: dataDirB,
    model: createFauxModel({ responses: [fauxText('Beta answer')] }),
  })

  try {
    await velaA.session('sess-a').prompt('alpha-unique-token')
    await velaB.session('sess-b').prompt('beta-unique-token')

    expect(existsSync(join(agentDir, 'vela.db'))).toBe(true)
    expect(existsSync(join(dataDirA, 'vela.db'))).toBe(false)
    expect(existsSync(join(dataDirB, 'vela.db'))).toBe(false)

    expect((await velaA.listSessions()).map((s) => s.id)).toEqual(['sess-a'])
    expect((await velaB.listSessions()).map((s) => s.id)).toEqual(['sess-b'])

    expect(
      (await velaA.searchSessions('alpha-unique-token')).map((h) => h.id),
    ).toEqual(['sess-a'])
    expect(await velaA.searchSessions('beta-unique-token')).toEqual([])
    expect(
      (await velaB.searchSessions('beta-unique-token')).map((h) => h.id),
    ).toEqual(['sess-b'])
  } finally {
    await velaA.dispose()
    await velaB.dispose()
  }

  const outHtml = join(root, 'exported.html')
  const written = await exportSavedSession({
    dataDir: dataDirA,
    agentDir,
    sessionId: 'sess-a',
    outputPath: outHtml,
    baseCwd: projA,
  })
  expect(written).toBe(outHtml)
  expect(existsSync(outHtml)).toBe(true)
})

test('Project/Session/ChannelBinding domain CRUD, multi-topic partial unique indexes, and projects.remove disk safety', async () => {
  const root = tempRoot('vela-s3b-domain-')
  const agentDir = join(root, 'agent')
  const diskProjDir = join(root, 'user-repo')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(diskProjDir, { recursive: true })
  writeFileSync(join(diskProjDir, 'README.md'), '# Keep me on disk\n')

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir })

  try {
    // Local project without hub triage session
    const localProj = runtime.projects.create({
      name: 'Local Repo',
      cwd: diskProjDir,
      hubSessionId: null,
    })
    expect(localProj.hubSessionId).toBeNull()

    // Quick Chat (projectId = null)
    const quickChat = runtime.sessions.create({
      id: 'quick-1',
      projectId: null,
      kind: 'chat',
      name: 'Quick Chat',
    })
    expect(quickChat.projectId).toBeNull()
    expect(quickChat.kind).toBe('chat')

    // Rename, status, delete
    const renamed = runtime.sessions.rename('quick-1', 'Renamed Chat')
    expect(renamed.name).toBe('Renamed Chat')
    expect(runtime.sessions.status('quick-1').session.name).toBe('Renamed Chat')
    expect(runtime.sessions.delete('quick-1')).toBe(true)
    expect(runtime.sessions.get('quick-1')).toBeUndefined()

    // Lark project with auto hub session & multiple topic bindings
    const larkProj = runtime.projects.create({
      name: 'Lark Group',
      cwd: diskProjDir,
      hubSessionId: true,
    })
    expect(larkProj.hubSessionId).toBeTruthy()
    expect(runtime.sessions.get(larkProj.hubSessionId!)?.kind).toBe('hub')

    const rootBinding = runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'oc_group_1',
      kind: 'group',
      projectId: larkProj.id,
      sessionId: larkProj.hubSessionId,
    })
    expect(rootBinding.threadId).toBeNull()

    const topic1 = runtime.sessions.create({
      projectId: larkProj.id,
      kind: 'topic',
      name: 'Topic 1',
    })
    const topic2 = runtime.sessions.create({
      projectId: larkProj.id,
      kind: 'topic',
      name: 'Topic 2',
    })
    const bTopic1 = runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'oc_group_1',
      threadId: 'thread_1',
      kind: 'group',
      projectId: larkProj.id,
      sessionId: topic1.id,
    })
    const bTopic2 = runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'oc_group_1',
      threadId: 'thread_2',
      kind: 'group',
      projectId: larkProj.id,
      sessionId: topic2.id,
    })
    expect(bTopic1.id).not.toBe(bTopic2.id)
    expect(runtime.bindings.list({ channel: 'lark' })).toHaveLength(3)

    // Hot disable/enable binding
    expect(runtime.bindings.setEnabled(bTopic1.id, false)?.enabled).toBe(false)
    expect(
      runtime.bindings.list({ channel: 'lark', enabledOnly: true }),
    ).toHaveLength(2)

    // Removing project unlinks DB rows but preserves user folder on disk
    expect(runtime.projects.remove(localProj.id)).toBe(true)
    expect(runtime.projects.get(localProj.id)).toBeUndefined()
    expect(existsSync(join(diskProjDir, 'README.md'))).toBe(true)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('!stop / !restart / !status / !timers shortcuts bypass inbox_events while !routines is not treated as a shortcut', async () => {
  const root = tempRoot('vela-s3b-shortcuts-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const db = openDatabase({ path: join(agentDir, 'vela.db') })

  let hangStarted!: () => void
  const hangReady = new Promise<void>((r) => {
    hangStarted = r
  })
  const delivered: ChannelOutboundMessage[] = []
  let adapterCtx!: ChannelAdapterContext

  const adapter: ChannelAdapter = {
    name: 'mockchan',
    async start(ctx) {
      adapterCtx = ctx
    },
    async stop() {},
    async deliver(message) {
      delivered.push(message)
      return { externalMessageId: `ext-${delivered.length}` }
    },
  }

  const runtime = new VelaRuntimeEngine({ db, agentDir })
  const driver = createVelaAgentDriver({
    db,
    agentDir,
    blobs: runtime.blobs,
    environments: runtime.environments,
    defaultModel: createFauxModel({
      responses: [
        () => {
          hangStarted()
          return fauxHang()
        },
        fauxText('After restart reply'),
      ],
    }),
  })
  runtime.registerDriver(driver)

  try {
    await runtime.registerChannel(adapter)
    const project = runtime.projects.create({
      name: 'Chat Project',
      cwd: root,
      hubSessionId: true,
    })
    const sessionId = project.hubSessionId!
    runtime.bindings.upsert({
      channel: 'mockchan',
      externalId: 'chat_1',
      kind: 'group',
      projectId: project.id,
      sessionId,
    })
    runtime.timers.createRoutine({
      projectId: project.id,
      sessionId,
      message: 'Check CI',
      schedule: { time: '09:00' },
      timezone: 'UTC',
    })

    // Start a hanging run so !stop can abort it immediately bypassing inbox_events
    await adapterCtx.ingest({
      channel: 'mockchan',
      dedupeKey: 'm-1',
      externalChatId: 'chat_1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: 'Start working',
      timestamp: new Date().toISOString(),
    })
    await hangReady

    // !timers & !status bypass inbox_events even while run is active
    await adapterCtx.ingest({
      channel: 'mockchan',
      dedupeKey: 'm-timers',
      externalChatId: 'chat_1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: '!timers',
      timestamp: new Date().toISOString(),
    })
    await adapterCtx.ingest({
      channel: 'mockchan',
      dedupeKey: 'm-status',
      externalChatId: 'chat_1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: '!status',
      timestamp: new Date().toISOString(),
    })

    expect(delivered.some((d) => d.text.includes('Check CI'))).toBe(true)
    expect(
      delivered.some((d) => d.text.includes(`Session: ${sessionId}`)),
    ).toBe(true)

    // !stop aborts active run directly
    await adapterCtx.ingest({
      channel: 'mockchan',
      dedupeKey: 'm-stop',
      externalChatId: 'chat_1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: '!stop',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(sessionId)
    expect(delivered.some((d) => d.text.includes('Stopped active run.'))).toBe(
      true,
    )

    // !routines has no legacy alias: it goes to inbox_events instead of shortcut handler
    const beforeCount = db.get<{ n: number }>(
      'SELECT count(*) AS n FROM inbox_events',
    )!.n
    await adapterCtx.ingest({
      channel: 'mockchan',
      dedupeKey: 'm-routines',
      externalChatId: 'chat_1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: '!routines',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(sessionId)
    const afterCount = db.get<{ n: number }>(
      'SELECT count(*) AS n FROM inbox_events',
    )!.n
    expect(afterCount).toBe(beforeCount + 1)
    expect(delivered.some((d) => d.text === 'After restart reply')).toBe(true)

    // !restart resets session state
    await adapterCtx.ingest({
      channel: 'mockchan',
      dedupeKey: 'm-restart',
      externalChatId: 'chat_1',
      kind: 'group',
      senderId: 'u1',
      senderName: 'Liam',
      text: '!restart',
      timestamp: new Date().toISOString(),
    })
    expect(
      delivered.some((d) => d.text.includes('Restarted with a fresh session.')),
    ).toBe(true)
    expect(runtime.sessions.get(sessionId)?.leafMessageId).toBeNull()
  } finally {
    await runtime.dispose()
    db.close()
  }
})
