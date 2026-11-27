import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela/legacy-desktop'
import { createFauxModel } from '@glows777/vela/testing'
import { wrapLarkAdapter } from '../src/main/lark-adapter-bridge.ts'
import {
  DesktopClientIdTracker,
  fetchLarkDesktopMessages,
  fetchLocalDesktopMessages,
  openLocalDesktopProject,
  stopDesktopTarget,
  submitDesktopMessage,
} from '../src/main/runtime-bridge.ts'
import { handleDesktopRoutineRequest } from '../src/main/runtime-routines.ts'
import type { Event } from '../src/shared/bridge.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('openLocalDesktopProject deduplicates concurrent opens for the same canonical path', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  const dir = tempDir('vela-open-proj-')
  try {
    await runtime.ready()
    const [a, b] = await Promise.all([
      openLocalDesktopProject(runtime, { cwd: dir }),
      openLocalDesktopProject(runtime, { cwd: `${dir}/.` }),
    ])
    expect(a.id).toBe(b.id)
    expect(a.sessionId).toBe(b.sessionId)
    expect(a.cwd).toBe(realpathSync(dir))
    const all = await runtime.projects.list()
    expect(all.filter((p) => p.cwd === a.cwd).length).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('cancelRoutine and stopDesktopTarget enforce project and session ownership boundaries', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  try {
    await runtime.ready()
    const projA = await runtime.projects.create({
      name: 'A',
      hubSessionId: true,
    })
    const projB = await runtime.projects.create({
      name: 'B',
      hubSessionId: true,
    })
    const childB = await runtime.sessions.create({
      projectId: projB.id,
      kind: 'work',
      name: 'Child B',
    })
    const routineB = await runtime.timers.createRoutine({
      projectId: projB.id,
      sessionId: projB.hubSessionId,
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
  } finally {
    await runtime.dispose()
  }
})

test('fetchLocalDesktopMessages paginates >100 messages alongside failed runs and enforces project bounds', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  try {
    await runtime.ready()
    const proj = await runtime.projects.create({
      name: 'Pag',
      hubSessionId: true,
    })
    const other = await runtime.projects.create({
      name: 'Other',
      hubSessionId: true,
    })
    const sessionId = proj.hubSessionId!

    await expect(
      fetchLocalDesktopMessages(
        runtime,
        { projectId: other.id, sessionId, limit: 10 },
        new Map(),
      ),
    ).rejects.toThrow(/does not belong/)

    const total = 105
    const syntheticRows = Array.from({ length: total }, (_, idx) => ({
      id: `msg-${String(idx + 1).padStart(3, '0')}`,
      sessionId,
      runId: 'run-hist',
      seq: idx + 1,
      kind: 'message',
      role: 'user' as const,
      text: `Message ${idx + 1}`,
      content: `Message ${idx + 1}`,
      createdAt: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    }))
    const mockRuntime = {
      ...runtime,
      sessions: {
        ...runtime.sessions,
        messages: async ({
          cursor,
          limit = 100,
        }: {
          sessionId: string
          cursor?: string
          limit?: number
        }) => {
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
        list: async ({
          afterSeq,
        }: {
          sessionId?: string
          afterSeq?: number
        } = {}) => {
          const all = [
            {
              seq: 1,
              sessionId,
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

    const page1 = await fetchLocalDesktopMessages(
      mockRuntime,
      { projectId: proj.id, sessionId, limit: 100 },
      new DesktopClientIdTracker(),
    )
    expect(page1.messages.length).toBe(100)
    expect(page1.nextCursor).toBeDefined()

    const page2 = await fetchLocalDesktopMessages(
      mockRuntime,
      { projectId: proj.id, sessionId, after: page1.nextCursor, limit: 100 },
      new DesktopClientIdTracker(),
    )
    expect(page2.messages.length).toBe(6)
    expect(page2.messages.at(-1)?.id).toBe('failed-run-fail-1')
    expect(page2.nextCursor).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
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

  // When run_started emits synchronously before trackPrompt records the inbox event ID
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

test('fetchLarkDesktopMessages rejects disabled topic even under enabled group, reset drops old failures, and routines enforce local creation + project timezone', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  try {
    await runtime.ready()
    const proj = await runtime.projects.create({
      name: 'TZProj',
      hubSessionId: true,
      config: { timezone: 'Pacific/Honolulu' },
    })
    const larkGroup = await runtime.projects.create({
      name: 'GroupProj',
      hubSessionId: true,
    })
    const topicSess = await runtime.sessions.create({
      projectId: larkGroup.id,
      kind: 'topic',
      name: 'Disabled topic',
    })
    await runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'oc_grp_en',
      kind: 'group',
      projectId: larkGroup.id,
      sessionId: larkGroup.hubSessionId,
      enabled: true,
    })
    await runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'oc_grp_en',
      threadId: 'omt_dis',
      kind: 'group',
      projectId: larkGroup.id,
      sessionId: topicSess.id,
      enabled: false,
    })
    await expect(
      fetchLarkDesktopMessages(runtime, {
        chatId: 'oc_grp_en',
        sessionId: topicSess.id,
      }),
    ).rejects.toThrow(/does not belong/)

    await expect(
      handleDesktopRoutineRequest(
        runtime,
        {},
        {
          method: 'createRoutine',
          channel: 'lark',
          target: { chatId: 'oc_grp_en' },
          input: { message: 'nope', schedule: { time: '09:00' } },
        },
      ),
    ).rejects.toThrow(/Local projects/)

    const listed = (await handleDesktopRoutineRequest(
      runtime,
      {},
      {
        method: 'listRoutines',
        channel: 'local',
        chatId: proj.id,
      },
    )) as { timezone: string }
    const created = (await handleDesktopRoutineRequest(
      runtime,
      {},
      {
        method: 'createRoutine',
        channel: 'local',
        target: { chatId: proj.id },
        input: { message: 'Honolulu routine', schedule: { time: '09:00' } },
      },
    )) as { timezone: string }
    expect(listed.timezone).toBe('Pacific/Honolulu')
    expect(created.timezone).toBe('Pacific/Honolulu')

    await runtime.sessions.reset(proj.hubSessionId!)
    const hist = await fetchLocalDesktopMessages(
      {
        ...runtime,
        events: {
          ...runtime.events,
          list: async () => [
            {
              seq: 1,
              sessionId: proj.hubSessionId!,
              projectId: proj.id,
              runId: 'old-fail',
              timestamp: '2026-01-01T00:00:00.000Z',
              type: 'run_finished' as const,
              status: 'failed' as const,
              error: 'Old error',
            },
            {
              seq: 2,
              sessionId: proj.hubSessionId!,
              projectId: proj.id,
              timestamp: '2026-01-02T00:00:00.000Z',
              type: 'session_reset' as const,
            },
          ],
        },
      },
      { projectId: proj.id, sessionId: proj.hubSessionId!, limit: 50 },
      new DesktopClientIdTracker(),
    )
    expect(hist.messages).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

test('wrapLarkAdapter emits reset on reconnect and isolates post-deliver publish failures', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  const events: Event[] = []
  let throwOnDeliverPublish = false
  const publish = (evt: Event) => {
    if (throwOnDeliverPublish && evt.type === 'lark') {
      throw new Error('window gone')
    }
    events.push(evt)
  }
  let report:
    | ((state: { connected: boolean; error?: string }) => void)
    | undefined
  try {
    await runtime.ready()
    const wrapped = wrapLarkAdapter(
      {
        name: 'lark',
        async start(ctx) {
          report = ctx.reportStatus
          report?.({ connected: true })
          report?.({ connected: false, error: 'lost' })
          report?.({ connected: true })
        },
        async stop() {},
        async deliver() {
          return { externalMessageId: 'om_ok' }
        },
      },
      runtime,
      publish,
    )
    await runtime.registerChannel(wrapped)
    expect(events).toContainEqual({
      type: 'lark',
      channel: 'lark',
      value: { type: 'reset' },
    })
    throwOnDeliverPublish = true
    const receipt = await wrapped.deliver({
      outboxId: 'o1',
      channel: 'lark',
      externalChatId: 'oc_1',
      text: 'hi',
    })
    expect(receipt).toEqual({ externalMessageId: 'om_ok' })
  } finally {
    await runtime.dispose()
  }
})

test('fetchLarkDesktopMessages rejects disabled or mismatched chat sessions', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  try {
    await runtime.ready()
    const proj = await runtime.projects.create({
      name: 'LarkProj',
      hubSessionId: true,
    })
    await runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'oc_disabled',
      kind: 'group',
      projectId: proj.id,
      sessionId: proj.hubSessionId,
      enabled: false,
    })
    await expect(
      fetchLarkDesktopMessages(runtime, {
        chatId: 'oc_disabled',
        sessionId: proj.hubSessionId!,
      }),
    ).rejects.toThrow(/Unknown or disabled/)
  } finally {
    await runtime.dispose()
  }
})
