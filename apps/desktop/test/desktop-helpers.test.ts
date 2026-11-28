import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDisconnectError } from '../src/main/disconnect-error.ts'
import { loadPreferences, savePreferences } from '../src/main/preferences.ts'
import {
  localRoutineInstant,
  nextOccurrence,
  routineLocalTime,
  routineTimezone,
} from '../src/main/routine-time.ts'
import {
  clearLarkCursors,
  readLarkGroupHistory,
} from '../src/renderer/store-history.ts'
import {
  applyChannelEventState,
  initialSnapshot,
  reconcileLocalMessages,
  submitLocalFlow,
} from '../src/renderer/store-state.ts'

const dirs: string[] = []
afterEach(() => {
  delete process.env.VELA_DESKTOP_PREFERENCES_PATH
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preferences default stopDaemonOnQuit to false, persist edits, and ignore corrupt JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-prefs-'))
  dirs.push(dir)
  expect(loadPreferences(dir)).toEqual({ stopDaemonOnQuit: false })

  const saved = savePreferences({ stopDaemonOnQuit: true }, dir)
  expect(saved).toEqual({ stopDaemonOnQuit: true })
  expect(loadPreferences(dir)).toEqual({ stopDaemonOnQuit: true })

  writeFileSync(join(dir, 'desktop-preferences.json'), '{not-json')
  expect(loadPreferences(dir)).toEqual({ stopDaemonOnQuit: false })
})

test('routine-time resolves IANA timezones, wall clock instants, and next occurrence', () => {
  expect(routineTimezone('UTC')).toBe('UTC')
  expect(() => routineTimezone('+08:00')).toThrow()

  const utc = localRoutineInstant('2026-11-28T09:30', 'Asia/Shanghai')
  expect(utc).toBe('2026-11-28T01:30:00.000Z')
  expect(routineLocalTime(Date.parse(utc), 'Asia/Shanghai')).toBe(
    '2026-11-28 09:30',
  )

  const after = Date.parse('2026-11-28T00:00:00.000Z')
  const next = nextOccurrence({ time: '09:30' }, after, 'Asia/Shanghai')
  expect(next).toBe(Date.parse('2026-11-28T01:30:00.000Z'))
})

test('submitLocalFlow rejects disconnected preflight errors and preserves mid-flight transport uncertainty', async () => {
  let snapshot = {
    ...initialSnapshot,
    messages: {} as typeof initialSnapshot.messages,
  }
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
  }
  const mergeMessages = (
    sid: string,
    incoming: (typeof initialSnapshot.messages)[string],
  ) => {
    snapshot = {
      ...snapshot,
      messages: {
        ...snapshot.messages,
        [sid]: [...(snapshot.messages[sid] ?? []), ...incoming],
      },
    }
  }

  let preflightUnknown = false
  let preflightError = ''
  const preflightOutcome = await submitLocalFlow({
    projectId: null,
    sessionId: 's-preflight',
    text: 'draft stays',
    getSnapshot: () => snapshot,
    publish,
    mergeMessages,
    onUnknown: () => {
      preflightUnknown = true
    },
    submit: async () => {
      throw new Error(
        'Background service disconnected and is reconnecting. Please try again.',
      )
    },
    report: (err) => {
      preflightError = err
    },
    formatError: (e) => (e instanceof Error ? e.message : String(e)),
  })
  expect(preflightOutcome).toBe('rejected')
  expect(preflightUnknown).toBe(false)
  expect(preflightError).toContain('reconnecting')
  expect(snapshot.messages['s-preflight']).toEqual([])

  let midflightUnknown = false
  const midflightOutcome = await submitLocalFlow({
    projectId: null,
    sessionId: 's-midflight',
    text: 'may have landed',
    getSnapshot: () => snapshot,
    publish,
    mergeMessages,
    onUnknown: () => {
      midflightUnknown = true
    },
    submit: async () => {
      throw new Error('Disconnected from Vela daemon')
    },
    report: () => {},
    formatError: (e) => (e instanceof Error ? e.message : String(e)),
  })
  expect(midflightOutcome).toBe('unknown')
  expect(midflightUnknown).toBe(true)
  expect(snapshot.messages['s-midflight']).toHaveLength(1)
  expect(snapshot.messages['s-midflight']?.[0]?.text).toBe('may have landed')
})

test('isDisconnectError distinguishes socket disconnects from bare ENOENT errors', () => {
  const enoent = Object.assign(new Error('ENOENT: missing project file'), {
    code: 'ENOENT',
  })
  expect(isDisconnectError(enoent)).toBe(false)

  for (const code of [
    'VELA_DAEMON_DISCONNECTED',
    'ECONNRESET',
    'EPIPE',
    'ECONNREFUSED',
    'ERR_IPC_CHANNEL_CLOSED',
  ]) {
    const err = Object.assign(new Error(`failed ${code}`), { code })
    expect(isDisconnectError(err)).toBe(true)
  }
  expect(isDisconnectError(new Error('Daemon runtime client is closed'))).toBe(
    true,
  )
  expect(
    isDisconnectError(new Error('Daemon client connection is closed')),
  ).toBe(true)
  expect(
    isDisconnectError(new Error('Daemon runtime client has been disposed')),
  ).toBe(true)
})

test('readLarkGroupHistory rebuilds cursor on overlapping refresh after clearLarkCursors so Load earlier continues working', async () => {
  clearLarkCursors()
  const cursorsRequested: Array<string | undefined> = []
  let shown: import('../src/shared/bridge.ts').Message[] = []
  let hasEarlier: boolean | undefined

  const makePage = (cursor?: string) => {
    cursorsRequested.push(cursor)
    if (!cursor) {
      return Promise.resolve({
        messages: [
          {
            id: 'm2',
            sessionId: 'grp-s1',
            role: 'user' as const,
            senderName: 'Alice',
            text: 'latest',
            createdAt: '2026-11-28T00:02:00.000Z',
          },
        ],
        nextCursor: 'cursor-page-2',
      })
    }
    return Promise.resolve({
      messages: [
        {
          id: 'm1',
          sessionId: 'grp-s1',
          role: 'user' as const,
          senderName: 'Alice',
          text: 'older',
          createdAt: '2026-11-28T00:01:00.000Z',
        },
      ],
      nextCursor: undefined,
    })
  }

  const project = {
    id: 'oc_reset_1',
    name: 'Lark Group',
    channel: 'lark' as const,
    sessionId: 'grp-s1',
  }

  await readLarkGroupHistory({
    project,
    shown: () => shown,
    onPage: (_sid, msgs, earlier) => {
      shown = msgs
      if (earlier !== undefined) hasEarlier = earlier
    },
    fetchMessages: ({ cursor }) => makePage(cursor),
  })
  expect(hasEarlier).toBe(true)

  clearLarkCursors()
  await readLarkGroupHistory({
    project,
    shown: () => shown,
    onPage: (_sid, msgs, earlier) => {
      shown = msgs
      if (earlier !== undefined) hasEarlier = earlier
    },
    fetchMessages: ({ cursor }) => makePage(cursor),
  })
  expect(hasEarlier).toBe(true)

  await readLarkGroupHistory({
    project,
    older: true,
    shown: () => shown,
    onPage: (_sid, msgs, earlier) => {
      shown = msgs
      if (earlier !== undefined) hasEarlier = earlier
    },
    fetchMessages: ({ cursor }) => makePage(cursor),
  })
  expect(cursorsRequested).toEqual([undefined, undefined, 'cursor-page-2'])
  expect(shown.map((m) => m.id)).toEqual(['m1', 'm2'])
  expect(hasEarlier).toBe(false)
})

test('reconcileLocalMessages preserves live commits during empty/tie reads and retires matching uncertain optimistic rows', () => {
  const liveReply = {
    id: 'm-live',
    sessionId: 's1',
    role: 'assistant' as const,
    text: 'live reply',
    createdAt: '2026-11-28T00:01:00.000Z',
  }
  expect(reconcileLocalMessages([liveReply], [], new Set(['m-live']))).toEqual([
    liveReply,
  ])

  const olderUser = {
    id: 'm-user-1',
    sessionId: 's1',
    role: 'user' as const,
    text: 'hello',
    createdAt: '2026-11-28T00:01:00.000Z',
  }
  const uncertainPending = {
    id: 'pending:cid-uncertain',
    sessionId: 's1',
    clientMessageId: 'cid-uncertain',
    role: 'user' as const,
    text: 'lost ack prompt',
    createdAt: '2026-11-28T00:01:00.000Z',
  }
  const persistedCopy = {
    id: 'm-user-2',
    sessionId: 's1',
    role: 'user' as const,
    text: 'lost ack prompt',
    createdAt: '2026-11-28T00:01:00.500Z',
  }
  const reconciled = reconcileLocalMessages(
    [uncertainPending, liveReply],
    [olderUser, persistedCopy],
    new Set(['m-live']),
  )
  expect(reconciled.map((m) => m.id)).toEqual([
    'm-user-1',
    'm-live',
    'm-user-2',
  ])
})

test('applyChannelEventState resets local and Lark cursors cleanly and refreshes visible views', async () => {
  let snapshot: typeof initialSnapshot = {
    ...initialSnapshot,
    connections: { local: { connected: false, error: 'Daemon offline' } },
    error: 'Daemon offline',
    sessions: {
      'loc-1': {
        sessionId: 'loc-1',
        projectId: 'proj-1',
        channel: 'local',
        name: 'Local',
        running: false,
        isHub: false,
        topic: false,
        createdAt: '2026-11-28T00:00:00.000Z',
        updatedAt: '2026-11-28T00:00:00.000Z',
      },
    },
  }
  const publish = (change: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...change }
  }
  let invalidated = 0
  let clearedCursors = 0
  let refreshed = 0
  const loadedLocal: string[] = []
  const loadedTopics: string[] = []
  const loadedGroups: string[] = []

  const common = {
    getSnapshot: () => snapshot,
    publish,
    invalidateAllLocalHistory: () => {
      invalidated += 1
    },
    clearLarkCursors: () => {
      clearedCursors += 1
    },
    refresh: async () => {
      refreshed += 1
    },
    loadLocal: async (place: string, sessionId: string) => {
      loadedLocal.push(`${place}:${sessionId}`)
    },
    loadGroupPage: async (project: { id: string }) => {
      loadedGroups.push(project.id)
      return undefined
    },
    loadTopicMessages: async (sessionId: string) => {
      loadedTopics.push(sessionId)
      return undefined
    },
    fetchLarkSessions: async () => [],
    mergeSessions: () => {},
    pageError: () => () => {},
    isCurrentGroup: () => true,
    isCurrentTopic: () => true,
  }

  applyChannelEventState({
    ...common,
    channel: 'local',
    value: { type: 'channel_status', connected: true, reset: true },
    visibleLocal: { place: 'session:loc-1', sessionId: 'loc-1' },
  })
  await new Promise((r) => setTimeout(r, 10))
  expect(snapshot.connections.local).toEqual({ connected: true })
  expect(snapshot.error).toBe('')
  expect(invalidated).toBe(1)
  expect(clearedCursors).toBe(1)
  expect(refreshed).toBe(1)
  expect(loadedLocal).toEqual(['session:loc-1:loc-1'])

  applyChannelEventState({
    ...common,
    channel: 'lark',
    value: {
      type: 'channel_history_changed',
      chatId: 'oc_1',
      sessionId: 'topic-1',
    },
    visibleTopic: {
      projectId: 'oc_1',
      session: {
        sessionId: 'topic-1',
        projectId: 'oc_1',
        channel: 'lark',
        name: 'Topic 1',
        running: false,
        isHub: false,
        topic: true,
        createdAt: '2026-11-28T00:00:00.000Z',
        updatedAt: '2026-11-28T00:00:00.000Z',
      },
      report: () => {},
    },
  })
  expect(loadedTopics).toEqual(['topic-1'])
})
