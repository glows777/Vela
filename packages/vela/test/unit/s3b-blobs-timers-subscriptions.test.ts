import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import type { ExecutionEnv } from '../../src/driver/execution/types.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { BlobStore, VelaRuntimeEngine } from '../../src/runtime/index.ts'
import { SubscriptionManager } from '../../src/runtime/subscriptions.ts'
import {
  MAX_FOLLOWUP_STREAK,
  MAX_ROUTINES_PER_PROJECT,
  TimerScheduler,
} from '../../src/runtime/timers.ts'

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

test('BlobStore assigns unique paths for duplicate image.png uploads, captures outbound artifacts, and replaces uploads.ts', async () => {
  expect(
    existsSync(join(import.meta.dir, '../../src/driver/session/uploads.ts')),
  ).toBe(false)

  const root = tempRoot('vela-s3b-blobs-')
  const agentDir = join(root, 'agent')
  const workspace = join(root, 'workspace')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  const blobs = new BlobStore(db, join(agentDir, 'blobs'))

  try {
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO sessions (id, kind, driver, state, created_at, updated_at)
       VALUES ('s-blob', 'chat', 'vela', 'idle', ?, ?)`,
      now,
      now,
    )

    const uploadA = join(workspace, 'a.png')
    const uploadB = join(workspace, 'b.png')
    writeFileSync(uploadA, 'first-image-bytes')
    writeFileSync(uploadB, 'second-image-bytes')

    const localEnv = createLocalExecutionEnv({ cwd: workspace })
    const firstLocal = await blobs.materializeHostUpload(localEnv, {
      sessionId: 's-blob',
      name: 'image.png',
      hostPath: uploadA,
      mimeType: 'image/png',
    })
    const secondLocal = await blobs.materializeHostUpload(localEnv, {
      sessionId: 's-blob',
      name: 'image.png',
      hostPath: uploadB,
      mimeType: 'image/png',
    })
    expect(firstLocal.path).not.toBe(secondLocal.path)
    expect(readFileSync(firstLocal.path, 'utf8')).toBe('first-image-bytes')
    expect(readFileSync(secondLocal.path, 'utf8')).toBe('second-image-bytes')

    // Non-local env also gets unique <blobId>-image.png paths
    const remoteRoot = join(root, 'remote-home')
    const remoteEnv = new Proxy(localEnv, {
      get(target, prop) {
        if (prop === 'id') return 'docker:test'
        if (prop === 'absolutePath') {
          return (p: string, sig?: AbortSignal) =>
            p.startsWith('~/')
              ? localEnv.absolutePath(join(remoteRoot, p.slice(2)), sig)
              : localEnv.absolutePath(p, sig)
        }
        const val = Reflect.get(target, prop, target)
        return typeof val === 'function' ? val.bind(target) : val
      },
    }) as ExecutionEnv

    const firstRemotePath = await blobs.materializeIntoEnv(
      firstLocal.blob,
      remoteEnv,
      's-blob',
    )
    const secondRemotePath = await blobs.materializeIntoEnv(
      secondLocal.blob,
      remoteEnv,
      's-blob',
    )
    expect(firstRemotePath).not.toBe(secondRemotePath)
    expect(readFileSync(firstRemotePath, 'utf8')).toBe('first-image-bytes')
    expect(readFileSync(secondRemotePath, 'utf8')).toBe('second-image-bytes')

    // Outbound send_file snapshot survives deletion of workspace source file
    const deliverable = join(workspace, 'report.txt')
    writeFileSync(deliverable, 'final deliverable')
    const outbound = await blobs.storeOutboundFromEnv({
      sessionId: 's-blob',
      env: localEnv,
      sourcePath: deliverable,
      mimeType: 'text/plain',
    })
    rmSync(deliverable)
    expect(readFileSync(outbound.storagePath, 'utf8')).toBe('final deliverable')
    expect(blobs.listBySession('s-blob', 'outbound')).toHaveLength(1)

    // Fork inheritance via SessionStore.seedFrom
    const parentStore = new SessionStore('s-blob', db, {
      blobsDir: blobs.rootDir,
    })
    await parentStore.loadSaved()
    parentStore.appendMessage({
      role: 'user',
      content: `Analyze [file: image.png, saved at ${firstRemotePath}]`,
    })
    const childStore = new SessionStore('s-blob-child', db, {
      blobsDir: blobs.rootDir,
    })
    await childStore.seedFrom(
      parentStore.getBranch(),
      { id: parentStore.id, store: parentStore },
      async () => remoteEnv,
    )
    const childText = JSON.stringify(childStore.buildContext().messages)
    expect(childText).not.toContain(firstRemotePath)
    expect(blobs.listBySession('s-blob-child', 'inbound')).toHaveLength(1)
  } finally {
    db.close()
  }
})

test('TimerScheduler enforces routine limits, single downtime catch-up, and followup 3-streak guardrail', async () => {
  const root = tempRoot('vela-s3b-timers-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir })

  try {
    const project = runtime.projects.create({
      name: 'Timer Project',
      cwd: root,
      hubSessionId: true,
    })
    const sessionId = project.hubSessionId!

    // Max 20 routines per project
    for (let i = 0; i < MAX_ROUTINES_PER_PROJECT; i++) {
      runtime.timers.createRoutine({
        projectId: project.id,
        sessionId,
        message: `Routine ${i}`,
        schedule: { time: '10:00' },
        timezone: 'UTC',
        nowMs: Date.parse('2026-11-25T09:00:00Z'),
      })
    }
    expect(() =>
      runtime.timers.createRoutine({
        projectId: project.id,
        sessionId,
        message: 'Routine 21',
        schedule: { time: '10:00' },
        timezone: 'UTC',
        nowMs: Date.parse('2026-11-25T09:00:00Z'),
      }),
    ).toThrow(/maximum of 20/)

    // Single catch-up after multi-day downtime
    for (const r of runtime.timers.list({ projectId: project.id })) {
      runtime.timers.delete(r.id)
    }
    const catchupRoutine = runtime.timers.createRoutine({
      projectId: project.id,
      sessionId,
      message: 'Daily standup',
      schedule: { time: '09:00' },
      timezone: 'UTC',
      nowMs: Date.parse('2026-11-20T08:00:00Z'),
    })
    const scheduler = new TimerScheduler(db)
    const tick1 = scheduler.tick(Date.parse('2026-11-25T12:00:00Z'))
    expect(tick1.fired).toEqual([catchupRoutine.id])
    const timerInbox = db.all<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM inbox_events WHERE session_id = ? AND source = 'timer'`,
      sessionId,
    )
    expect(timerInbox).toHaveLength(1)
    expect(timerInbox[0]!.dedupe_key).toContain('2026-11-25T09:00:00.000Z')

    // Followup 3-streak hard guardrail
    for (let streak = 1; streak <= MAX_FOLLOWUP_STREAK; streak++) {
      const f = runtime.timers.createFollowup({
        sessionId,
        message: `Self check #${streak}`,
        fireAt: '2026-11-25T12:05:00Z',
      })
      const res = scheduler.tick(Date.parse('2026-11-25T12:06:00Z'))
      expect(res.fired).toContain(f.id)
    }
    expect(runtime.sessions.get(sessionId)?.followupStreak).toBe(3)

    // 4th consecutive followup without human input is rejected
    expect(() =>
      runtime.timers.createFollowup({
        sessionId,
        message: 'Self check #4',
        fireAt: '2026-11-25T12:10:00Z',
      }),
    ).toThrow(/Followup guardrail reached/)

    // Even a pre-scheduled followup cannot fire once streak hits 3
    db.run(`UPDATE sessions SET followup_streak = 2 WHERE id = ?`, sessionId)
    const fA = runtime.timers.createFollowup({
      sessionId,
      message: 'Pre-scheduled A',
      fireAt: '2026-11-25T12:10:00Z',
    })
    const fB = runtime.timers.createFollowup({
      sessionId,
      message: 'Pre-scheduled B',
      fireAt: '2026-11-25T12:11:00Z',
    })
    const resBoth = scheduler.tick(Date.parse('2026-11-25T12:12:00Z'))
    expect(resBoth.fired).toEqual([fA.id])
    expect(resBoth.guardrailBlocked).toEqual([fB.id])

    // Fresh human input resets followup_streak back to 0
    runtime.submitPrompt({
      sessionId,
      text: 'Human checked in',
      source: 'user',
    })
    expect(runtime.sessions.get(sessionId)?.followupStreak).toBe(0)
    const fAfterHuman = runtime.timers.createFollowup({
      sessionId,
      message: 'Allowed again',
      fireAt: '2026-11-25T12:20:00Z',
    })
    expect(fAfterHuman.enabled).toBe(true)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('SubscriptionManager fans external webhook events into inbox_events with deduplication', async () => {
  const root = tempRoot('vela-s3b-subs-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir })

  try {
    const project = runtime.projects.create({ name: 'Webhooks', cwd: root })
    const s1 = runtime.sessions.create({ projectId: project.id, kind: 'work' })
    const s2 = runtime.sessions.create({ projectId: project.id, kind: 'work' })

    const subs = new SubscriptionManager(db)
    subs.create({
      source: 'github',
      eventKey: 'glows777/Vela#579',
      projectId: project.id,
      sessionId: s1.id,
    })
    subs.create({
      source: 'github',
      eventKey: '*',
      projectId: project.id,
      sessionId: s2.id,
    })

    const first = subs.dispatchEvent({
      source: 'github',
      eventKey: 'glows777/Vela#579',
      dedupeKey: 'delivery-1',
      summary: 'CI passed',
      final: true,
    })
    expect(first.enqueuedCount).toBe(2)
    expect(first.matchedSessionIds.sort()).toEqual([s1.id, s2.id].sort())

    // Duplicate delivery is ignored idempotently
    const dup = subs.dispatchEvent({
      source: 'github',
      eventKey: 'glows777/Vela#579',
      dedupeKey: 'delivery-1',
      summary: 'CI passed',
    })
    expect(dup.enqueuedCount).toBe(0)
  } finally {
    await runtime.dispose()
    db.close()
  }
})
