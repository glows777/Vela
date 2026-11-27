import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectRuntime,
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
  openLocalDesktopProject,
  removeDesktopProject,
  renameDesktopSession,
  stopDesktopTarget,
  submitDesktopMessage,
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
