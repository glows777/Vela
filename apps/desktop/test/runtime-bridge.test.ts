import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectRuntime,
  createRuntime,
  type DaemonServerHandle,
  startDaemonServer,
  type VelaRuntime,
} from '@glows777/vela'
import { createFauxModel } from '@glows777/vela/testing'
import {
  createDesktopSession,
  DesktopClientIdTracker,
  deleteDesktopSession,
  fetchDesktopMessages,
  mapLocalRuntimeEvent,
  openLocalDesktopProject,
  removeDesktopProject,
  renameDesktopSession,
  resolveSessionOwnership,
  stopDesktopTarget,
  submitDesktopMessage,
  toDesktopMessage,
  toDesktopSession,
} from '../src/main/runtime-bridge.ts'
import { handleDesktopRoutineRequest } from '../src/main/runtime-routines.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function openTestRuntime(): Promise<{
  dir: string
  server: DaemonServerHandle
  runtime: VelaRuntime
}> {
  const dir = tempDir('vela-bridge-')
  const socketPath = join(dir, 'test.sock')
  const server = await startDaemonServer({
    agentDir: dir,
    socketPath,
    hostEnv: {},
    enableWebhooks: false,
    enableLark: false,
    defaultModel: createFauxModel(),
  })
  const runtime = await connectRuntime({
    agentDir: dir,
    socketPath,
    autoStart: false,
  })
  cleanups.push(async () => {
    await runtime.dispose()
    await server.close('test-cleanup')
  })
  await runtime.ready()
  return { dir, server, runtime }
}

test('openLocalDesktopProject deduplicates concurrent opens and creates sessions independently', async () => {
  const { runtime } = await openTestRuntime()
  const cwd = tempDir('vela-open-proj-')

  const [a, b] = await Promise.all([
    openLocalDesktopProject(runtime, { cwd }),
    openLocalDesktopProject(runtime, { cwd: `${cwd}/.` }),
  ])
  expect(a.id).toBe(b.id)
  expect(a.cwd).toBe(realpathSync(cwd))
  const all = await runtime.projects.list()
  expect(all.filter((p) => p.cwd === a.cwd).length).toBe(1)

  const session = await createDesktopSession(runtime, {
    projectId: a.id,
    name: 'First task',
  })
  expect(session.projectId).toBe(a.id)
  expect(session.chatKind).toBe('direct')

  const renamed = await renameDesktopSession(runtime, {
    sessionId: session.sessionId,
    name: 'Renamed task',
  })
  expect(renamed?.task).toBe('Renamed task')

  expect(
    await deleteDesktopSession(runtime, { sessionId: session.sessionId }),
  ).toBe(true)
  expect(await removeDesktopProject(runtime, { projectId: a.id })).toBe(true)
  expect((await runtime.projects.list()).length).toBe(0)
})

test('Quick Chat creates and deletes projectless sessions', async () => {
  const { runtime } = await openTestRuntime()
  const quick = await createDesktopSession(runtime, {
    projectId: null,
    name: 'Quick question',
  })
  expect(quick.projectId).toBeNull()
  expect(quick.chatId).toBeNull()
  expect(quick.chatKind).toBe('quick')

  const submitted = await submitDesktopMessage(
    runtime,
    false,
    new DesktopClientIdTracker(),
    {
      method: 'submit',
      channel: 'local',
      message: {
        projectId: null,
        sessionId: quick.sessionId,
        text: 'Hello quick chat',
        clientMessageId: 'qc-1',
      },
    },
  )
  expect(submitted.outcome).toBe('posted')
  expect(submitted.sessionId).toBe(quick.sessionId)
})

test('cancelRoutine and stopDesktopTarget enforce project and session ownership boundaries', async () => {
  const { runtime } = await openTestRuntime()
  const projA = await runtime.projects.create({
    name: 'A',
    hubSessionId: false,
  })
  const projB = await runtime.projects.create({
    name: 'B',
    hubSessionId: false,
  })
  const childB = await runtime.sessions.create({
    projectId: projB.id,
    kind: 'work',
    name: 'Child B',
  })
  const routineB = await runtime.timers.createRoutine({
    projectId: projB.id,
    sessionId: childB.id,
    message: 'B timer',
    schedule: { time: '12:00' },
  })

  expect(
    await handleDesktopRoutineRequest(
      runtime,
      {},
      {
        method: 'cancelRoutine',
        channel: 'local',
        chatId: projA.id,
        id: routineB.id,
      },
    ),
  ).toBe(false)
  expect((await runtime.timers.list({ projectId: projB.id })).length).toBe(1)

  expect(
    await handleDesktopRoutineRequest(
      runtime,
      {},
      {
        method: 'cancelRoutine',
        channel: 'local',
        chatId: projB.id,
        id: routineB.id,
      },
    ),
  ).toBe(true)

  await expect(
    submitDesktopMessage(runtime, false, new DesktopClientIdTracker(), {
      method: 'submit',
      channel: 'local',
      message: {
        projectId: projA.id,
        sessionId: childB.id,
        text: 'cross project',
      },
    }),
  ).rejects.toThrow(/does not belong/)

  expect(
    await stopDesktopTarget(runtime, {
      method: 'stop',
      channel: 'local',
      target: { chatId: projA.id, rootId: childB.id },
      runId: 'any-run',
    }),
  ).toBe(false)
})

test('fetchDesktopMessages paginates >100 messages alongside failed runs and enforces Lark boundaries', async () => {
  const { runtime } = await openTestRuntime()
  const proj = await runtime.projects.create({
    name: 'Pag',
    hubSessionId: false,
  })
  const session = await runtime.sessions.create({
    projectId: proj.id,
    kind: 'work',
    name: 'Long session',
  })

  const total = 105
  const syntheticRows = Array.from({ length: total }, (_, idx) => ({
    id: `msg-${String(idx + 1).padStart(3, '0')}`,
    sessionId: session.id,
    runId: 'run-hist',
    seq: idx + 1,
    kind: 'message',
    role: 'user' as const,
    text: `Message ${idx + 1}`,
    content: `Message ${idx + 1}`,
    createdAt: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
  }))

  const mockRuntime: VelaRuntime = {
    ...runtime,
    sessions: {
      ...runtime.sessions,
      messages: async ({ cursor, limit = 100 }) => {
        const afterSeq = cursor ? Number(cursor) : 0
        const filtered = syntheticRows.filter((r) => r.seq > afterSeq)
        const slice = filtered.slice(0, limit)
        const hasMore = filtered.length > limit
        return {
          messages: slice,
          ...(hasMore && slice.length > 0
            ? { nextCursor: String(slice.at(-1)!.seq) }
            : {}),
        }
      },
    },
    events: {
      ...runtime.events,
      list: async ({ afterSeq } = {}) => {
        const all = [
          {
            seq: 1,
            sessionId: session.id,
            projectId: proj.id,
            runId: 'run-fail-1',
            timestamp: new Date(1_700_000_000_000 + 200_000).toISOString(),
            type: 'run_finished' as const,
            status: 'failed' as const,
            error: 'Quota exceeded',
          },
        ]
        return afterSeq !== undefined
          ? all.filter((e) => e.seq > afterSeq)
          : all
      },
    },
  }

  const page1 = await fetchDesktopMessages(
    mockRuntime,
    { sessionId: session.id, limit: 100 },
    new DesktopClientIdTracker(),
  )
  expect(page1.messages.length).toBe(100)
  expect(page1.nextCursor).toBeDefined()

  const page2 = await fetchDesktopMessages(
    mockRuntime,
    { sessionId: session.id, after: page1.nextCursor, limit: 100 },
    new DesktopClientIdTracker(),
  )
  expect(page2.messages.length).toBe(6)
  expect(page2.messages.at(-1)?.id).toBe('failed-run-fail-1')
  expect(page2.nextCursor).toBeUndefined()

  const larkProj = await runtime.projects.create({
    name: 'LarkProj',
    hubSessionId: true,
  })
  const disabledTopic = await runtime.sessions.create({
    projectId: larkProj.id,
    kind: 'topic',
    name: 'Disabled topic',
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_grp_en',
    kind: 'group',
    projectId: larkProj.id,
    sessionId: larkProj.hubSessionId,
    enabled: true,
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_grp_en',
    threadId: 'omt_dis',
    kind: 'group',
    projectId: larkProj.id,
    sessionId: disabledTopic.id,
    enabled: false,
  })
  await expect(
    fetchDesktopMessages(
      runtime,
      { sessionId: disabledTopic.id },
      new DesktopClientIdTracker(),
    ),
  ).rejects.toThrow(/Unknown or disabled/)
})

test('Lark routines use Vela app attribution and project timezone', async () => {
  const { runtime } = await openTestRuntime()
  const localProj = await runtime.projects.create({
    name: 'TZProj',
    hubSessionId: false,
    config: { timezone: 'Pacific/Honolulu' },
  })
  const listed = (await handleDesktopRoutineRequest(
    runtime,
    {},
    { method: 'listRoutines', channel: 'local', chatId: localProj.id },
  )) as { timezone: string }
  const localRoutine = (await handleDesktopRoutineRequest(
    runtime,
    {},
    {
      method: 'createRoutine',
      channel: 'local',
      target: { chatId: localProj.id },
      input: { message: 'Honolulu routine', schedule: { time: '09:00' } },
    },
  )) as { timezone: string; target: string; creator: { name: string } }
  expect(listed.timezone).toBe('Pacific/Honolulu')
  expect(localRoutine.timezone).toBe('Pacific/Honolulu')
  expect(localRoutine.target).toBe('Project default')
  expect(localRoutine.creator.name).toBe('You')

  const larkProj = await runtime.projects.create({
    name: 'GroupProj',
    hubSessionId: true,
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_grp_routine',
    kind: 'group',
    projectId: larkProj.id,
    sessionId: larkProj.hubSessionId,
    enabled: true,
  })
  const larkRoutine = (await handleDesktopRoutineRequest(
    runtime,
    {},
    {
      method: 'createRoutine',
      channel: 'lark',
      target: { chatId: 'oc_grp_routine' },
      input: { message: 'Daily sync', schedule: { time: '10:00' } },
    },
  )) as { creator: { id: string; name: string }; target: string }
  expect(larkRoutine.creator).toEqual({ id: 'vela-app', name: 'Vela app' })
  expect(larkRoutine.target).toBe('Group channel')
})

test('DesktopClientIdTracker correlates batched inboxEventIds onto user commits regardless of event order', () => {
  const tracker = new DesktopClientIdTracker()
  tracker.trackPrompt('in-1', 'c-1')
  tracker.trackPrompt('in-2', 'c-2')
  tracker.onRunStarted('run-1', ['in-1', 'in-2'])
  const matched = tracker.consumeForUserMessage(
    'sess-1',
    'run-1',
    'first\n\nsecond',
    'msg-1',
  )
  expect(matched).toEqual(['c-1', 'c-2'])
  expect(tracker.getForMessage('msg-1')).toBe('c-1')

  tracker.onRunStarted('run-2', ['in-3'])
  tracker.trackPrompt('in-3', 'c-3')
  const reverseOrder = tracker.consumeForUserMessage(
    'sess-1',
    'run-2',
    'third',
    'msg-2',
  )
  expect(reverseOrder).toEqual(['c-3'])
  expect(tracker.getForMessage('msg-2')).toBe('c-3')
})

test('removeDesktopProject deletes the project and its owned sessions', async () => {
  const { runtime } = await openTestRuntime()
  const cwd = tempDir('vela-unlink-')
  const proj = await openLocalDesktopProject(runtime, { cwd })
  const sess = await createDesktopSession(runtime, {
    projectId: proj.id,
    name: 'Delete history',
  })
  await submitDesktopMessage(runtime, false, new DesktopClientIdTracker(), {
    method: 'submit',
    channel: 'local',
    message: { projectId: proj.id, sessionId: sess.sessionId, text: 'hello' },
  })
  await runtime.waitForIdle(sess.sessionId)

  const removed = await removeDesktopProject(runtime, { projectId: proj.id })
  expect(removed).toBe(true)
  expect(await runtime.projects.get(proj.id)).toBeUndefined()
  expect(await runtime.sessions.get(sess.sessionId)).toBeUndefined()
})

test('projects.remove with deleteSessions closes driver session extensions cleanly before recreating session id', async () => {
  const cwd = tempDir('vela-unlink-ext-')
  let shutdownCount = 0
  let closedTarget: string | undefined
  const runtime = createRuntime({
    agentDir: tempDir('vela-unlink-agent-'),
    defaultModel: createFauxModel(),
    extensions: [
      (api) => {
        api.on('session_shutdown', async (_event, ctx) => {
          shutdownCount += 1
          closedTarget = ctx.session.id
        })
      },
    ],
  })
  cleanups.push(() => runtime.dispose())
  await runtime.ready()

  const proj = await runtime.projects.create({
    name: 'Ext Project',
    cwd,
  })
  const sess = await runtime.sessions.create({
    id: 'reusable-sess-id',
    projectId: proj.id,
    location: { environment: 'local', cwd },
  })
  await runtime.prompt(sess.id, { text: 'init extension runner' })
  await runtime.waitForIdle(sess.id)

  const removed = await runtime.projects.remove(proj.id, {
    deleteSessions: true,
  })
  expect(removed).toBe(true)
  expect(shutdownCount).toBe(1)
  expect(closedTarget).toBe('reusable-sess-id')

  // Recreating a session with the same ID starts fresh without reusing deleted runner state.
  const proj2 = await runtime.projects.create({ name: 'Ext Project 2', cwd })
  const recreated = await runtime.sessions.create({
    id: 'reusable-sess-id',
    projectId: proj2.id,
    location: { environment: 'local', cwd },
  })
  await runtime.prompt(recreated.id, { text: 'fresh session' })
  await runtime.waitForIdle(recreated.id)
})

test('deleteDesktopSession stops running work before deleting the session', async () => {
  const { runtime } = await openTestRuntime()
  const cwd = tempDir('vela-delete-stop-')
  const proj = await openLocalDesktopProject(runtime, { cwd })
  const sess = await createDesktopSession(runtime, {
    projectId: proj.id,
    name: 'Active job session',
  })

  const origStatus = runtime.sessions.status.bind(runtime.sessions)
  const origStop = runtime.stop.bind(runtime)
  let stoppedArgs: { sessionId: string; reason?: string } | undefined
  ;(runtime.sessions as { status: typeof origStatus }).status = async (id) => {
    const base = await origStatus(id)
    return { ...base, runningJobs: 1, activeRunId: undefined }
  }
  ;(runtime as { stop: typeof origStop }).stop = async (sessionId, reason) => {
    stoppedArgs = { sessionId, reason }
    return false
  }

  try {
    const deleted = await deleteDesktopSession(runtime, {
      sessionId: sess.sessionId,
    })
    expect(deleted).toBe(true)
    expect(stoppedArgs).toEqual({
      sessionId: sess.sessionId,
      reason: 'Session deleted',
    })
    expect(await runtime.sessions.get(sess.sessionId)).toBeUndefined()
  } finally {
    ;(runtime.sessions as { status: typeof origStatus }).status = origStatus
    ;(runtime as { stop: typeof origStop }).stop = origStop
  }
})

test('hidden memory custom_message does not consume clientMessageId and session_reset maps cleanly', async () => {
  const tracker = new DesktopClientIdTracker()
  tracker.trackPrompt('in-mem-1', 'cid-1')
  tracker.onRunStarted('run-mem-1', ['in-mem-1'])

  const hidden = toDesktopMessage({
    id: 'm-hidden',
    sessionId: 's-1',
    runId: 'run-mem-1',
    kind: 'custom_message',
    role: 'user',
    text: 'secret memory update',
    content: 'secret memory update',
    display: false,
    createdAt: '2026-11-28T00:00:00.000Z',
  })
  expect(hidden).toBeUndefined()
  const consumed = tracker.consumeForUserMessage(
    's-1',
    'run-mem-1',
    'actual user text',
    'm-real',
  )
  expect(consumed).toEqual(['cid-1'])

  const mappedReset = mapLocalRuntimeEvent(
    {
      seq: 7,
      type: 'session_reset',
      sessionId: 's-1',
      timestamp: '2026-11-28T00:00:01.000Z',
    },
    null,
    {
      channel: 'local',
      sessionId: 's-1',
      chatId: null,
      chatKind: 'quick',
      projectId: null,
      task: 'Reset test',
      state: 'done',
      requester: { id: 'local-user', name: 'You' },
      updatedAt: '2026-11-28T00:00:01.000Z',
    },
  )
  expect(mappedReset[0]).toMatchObject({
    type: 'local',
    value: { type: 'session_reset', sessionId: 's-1' },
  })
})

test('Local hub session marks isHub and disabled Lark rejects fetchDesktopMessages', async () => {
  const { runtime } = await openTestRuntime()
  const cwd = tempDir('vela-hub-ownership-')
  const hubProj = await runtime.projects.create({
    name: 'LegacyHubProj',
    cwd,
    hubSessionId: true,
  })
  const hubSession = await runtime.sessions.get(hubProj.hubSessionId!)
  expect(hubSession?.kind).toBe('hub')
  const ownership = resolveSessionOwnership(hubSession!, [], new Set())!
  expect(toDesktopSession(hubSession!, ownership).isHub).toBe(true)

  const larkProj = await runtime.projects.create({
    name: 'LarkDisabled',
    hubSessionId: true,
  })
  const larkTopic = await runtime.sessions.create({
    projectId: larkProj.id,
    kind: 'topic',
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_disabled_msg',
    kind: 'group',
    projectId: larkProj.id,
    sessionId: larkProj.hubSessionId,
    enabled: false,
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_disabled_msg',
    threadId: 'omt_1',
    kind: 'group',
    projectId: larkProj.id,
    sessionId: larkTopic.id,
    enabled: false,
  })
  await expect(
    fetchDesktopMessages(
      runtime,
      { sessionId: larkTopic.id },
      new DesktopClientIdTracker(),
    ),
  ).rejects.toThrow(/Unknown or disabled Lark/i)
})

test('submitDesktopMessage forwards images when steering an active Local run', async () => {
  const dir = tempDir('vela-steer-img-')
  const socketPath = join(dir, 'test.sock')
  let seenImagesCount = 0
  let releaseTurn!: () => void
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  let markTurnEntered!: () => void
  const turnEntered = new Promise<void>((resolve) => {
    markTurnEntered = resolve
  })
  cleanups.push(() => releaseTurn())

  const { createFauxModel } = await import('@glows777/vela/testing')
  const baseModel = createFauxModel()
  baseModel.push(
    { toolCalls: [{ name: 'bash', input: { command: 'echo ok' } }] },
    { text: 'steered' },
  )
  const slowModel = {
    ...baseModel,
    async doStream(opts: unknown) {
      markTurnEntered()
      await turnGate
      const msgs =
        (opts as { prompt?: Array<{ content?: unknown }> })?.prompt ?? []
      for (const m of msgs) {
        if (Array.isArray(m.content)) {
          seenImagesCount += m.content.filter((part) => {
            const kind = (part as { type?: string })?.type
            return kind === 'file' || kind === 'image'
          }).length
        }
      }
      return baseModel.doStream(
        opts as Parameters<typeof baseModel.doStream>[0],
      )
    },
  }
  const server = await startDaemonServer({
    agentDir: dir,
    socketPath,
    hostEnv: {},
    enableWebhooks: false,
    enableLark: false,
    defaultModel: slowModel,
  })
  const runtime = await connectRuntime({
    agentDir: dir,
    socketPath,
    autoStart: false,
  })
  cleanups.push(async () => {
    releaseTurn()
    await runtime.dispose()
    await server.close('test-cleanup')
  })
  await runtime.ready()

  const cwd = tempDir('vela-steer-proj-')
  const proj = await openLocalDesktopProject(runtime, { cwd })
  await runtime.trust.approve(proj.cwd, true)
  const sess = await createDesktopSession(runtime, { projectId: proj.id })
  const tracker = new DesktopClientIdTracker()
  await submitDesktopMessage(runtime, false, tracker, {
    method: 'submit',
    channel: 'local',
    message: {
      projectId: proj.id,
      sessionId: sess.sessionId,
      text: 'start run',
    },
  })
  await turnEntered

  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  await submitDesktopMessage(runtime, false, tracker, {
    method: 'submit',
    channel: 'local',
    message: {
      sessionId: sess.sessionId,
      text: 'steer with image',
      images: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }],
    },
  })
  releaseTurn()
  await runtime.waitForIdle(sess.sessionId)
  expect(seenImagesCount).toBeGreaterThan(0)
})

test('stopDesktopTarget rejects Lark DM/cross-project target and submitDesktopMessage redirects hub input + preserves non-local location', async () => {
  const rt = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
  })
  cleanups.push(() => rt.dispose())
  await rt.ready()

  // Projectless Lark DM must not be stoppable through channel: 'local'.
  const dm = await rt.sessions.create({
    projectId: null,
    kind: 'chat',
    name: 'Lark DM',
  })
  await rt.bindings.upsert({
    channel: 'lark',
    kind: 'direct',
    externalId: 'dm_1',
    sessionId: dm.id,
    enabled: true,
  })
  await expect(
    stopDesktopTarget(rt, {
      method: 'stop',
      channel: 'local',
      target: { sessionId: dm.id },
      runId: 'run-any',
    }),
  ).resolves.toBe(false)

  // Local project with hub session + non-local defaultLocation.
  const proj = await rt.projects.create({
    name: 'Remote Project',
    defaultLocation: { environment: 'build', cwd: '/worktree' },
  })
  const hub = await rt.sessions.create({
    projectId: proj.id,
    kind: 'hub',
    name: 'Old Hub',
  })
  await rt.projects.update(proj.id, { hubSessionId: hub.id })
  const desktopHub = toDesktopSession(hub, {
    channel: 'local',
    chatId: proj.id,
    chatKind: 'direct',
    projectId: proj.id,
  })
  expect(desktopHub.isHub).toBe(true)
  expect(desktopHub.location).toEqual({
    environment: 'build',
    cwd: '/worktree',
  })

  // Cross-project chatId check rejects wrong project even for Local sessions.
  const otherProj = await rt.projects.create({ name: 'Other', cwd: '/tmp' })
  await expect(
    stopDesktopTarget(rt, {
      method: 'stop',
      channel: 'local',
      target: { sessionId: hub.id, chatId: otherProj.id },
      runId: 'run-any',
    }),
  ).resolves.toBe(false)

  // Explicit Local hub submission redirects into a new work session instead of prompting the hub.
  const receipt = await submitDesktopMessage(
    rt,
    false,
    new DesktopClientIdTracker(),
    {
      method: 'submit',
      channel: 'local',
      message: {
        projectId: proj.id,
        sessionId: hub.id,
        text: 'work prompt',
      },
    },
  )
  expect(receipt.outcome).toBe('posted')
  expect(receipt.sessionId).toBeDefined()
  expect(receipt.sessionId).not.toBe(hub.id)
  const createdWork = await rt.sessions.get(receipt.sessionId!)
  expect(createdWork?.kind).toBe('work')
  expect(createdWork?.location).toEqual({
    environment: 'build',
    cwd: '/worktree',
  })
})
