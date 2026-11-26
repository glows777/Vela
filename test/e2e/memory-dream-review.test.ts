import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { MemoryDream } from '../../packages/vela/src/driver/memory/dream.ts'
import { MemoryStore } from '../../packages/vela/src/runtime/memory/store.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

const source = {
  name: 'deploy-source',
  description: 'Unique deployment reminder',
  type: 'project' as const,
  content: 'Release manager approval is required before every deployment.',
}
const target = {
  name: 'deploy-target',
  description: 'Deployment schedule',
  type: 'project' as const,
  content: 'Deployments happen on Monday.',
}
const sourceFile = 'memory/project_deploy-source.md'
const targetFile = 'memory/project_deploy-target.md'
const liveDescription = 'Deployment schedule verified by the release manager'
const result = (ops: unknown[] = []) =>
  fauxText(JSON.stringify({ ops, report: 'Merged deployment reminders' }))
const removeSource = {
  action: 'delete',
  filename: 'project_deploy-source.md',
  reason: 'The target now preserves the unique release approval reminder',
  source: 'default',
}
const mergeTarget = {
  action: 'update',
  filename: 'project_deploy-target.md',
  ...target,
  content: `${target.content}\n${source.content}`,
  reason: 'Keep both deployment facts in one note',
  source: 'default',
}
const notices = (t: TestVela) =>
  t
    .eventsOf('notify')
    .map((event) => event.message)
    .join('\n')
const read = (t: TestVela, path: string) =>
  readFileSync(t.dataPath(path), 'utf8')

function dreamAudit(t: TestVela) {
  const db = openDatabase({ path: join(t.dataDir, 'vela.db'), readonly: true })
  try {
    const memoryDir = t.dataPath('memory')
    const dream = new MemoryDream(new MemoryStore(memoryDir), db, {
      kind: 'tagged',
      key: `dir:${resolve(memoryDir)}`,
    })
    return dream.auditState()
  } finally {
    db.close()
  }
}

function gateGeneration(t: TestVela) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const generate = t.model.doGenerate.bind(t.model)
  const spy = spyOn(t.model, 'doGenerate').mockImplementation(async (opts) => {
    entered.resolve()
    await released.promise
    return generate(opts)
  })
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    restore: () => spy.mockRestore(),
  }
}

for (const deletionOrder of ['before', 'after']) {
  test(`a stale merge target invalidates the whole batch with deletion ${deletionOrder} update, then retries from refreshed notes`, async () => {
    const ops =
      deletionOrder === 'before'
        ? [removeSource, mergeTarget]
        : [mergeTarget, removeSource]
    const t = createTestVela({
      responses: [
        [
          fauxToolCall('memory', { action: 'save', ...source }),
          fauxToolCall('memory', { action: 'save', ...target }),
        ],
        fauxText('Both notes saved'),
        fauxText('Merge requested'),
        fauxToolCall('memory', {
          action: 'save',
          ...target,
          description: liveDescription,
        }),
        fauxText('Updated only the target description'),
      ],
      generate: [result(ops)],
    })
    await t.session.prompt('Save both separate deployment notes')
    await t.session.prompt('Merge the source reminder into the target note')
    const sourceBefore = read(t, sourceFile)
    const gate = gateGeneration(t)
    const dreaming = t.session.prompt('/dream')
    let liveTarget = ''
    let liveIndex = ''
    let queuedIds: string[] = []
    try {
      await gate.entered
      await t.vela
        .session('live')
        .prompt('Change only the description of the deployment target')
      liveTarget = read(t, targetFile)
      liveIndex = read(t, 'memory/MEMORY.md')
      queuedIds = dreamAudit(t).pendingTurns.map((turn) => turn.id)
    } finally {
      gate.release()
      await dreaming
      gate.restore()
    }
    const audit = dreamAudit(t)
    expect({
      sourceStillExists: existsSync(t.dataPath(sourceFile)),
      target: read(t, targetFile),
      index: read(t, 'memory/MEMORY.md'),
      pendingIds: audit.pendingTurns.map((turn) => turn.id),
      hasLegacyDreamDir: existsSync(t.dataPath('memory/.dream')),
    }).toEqual({
      sourceStillExists: true,
      target: liveTarget,
      index: liveIndex,
      pendingIds: queuedIds,
      hasLegacyDreamDir: false,
    })
    expect(read(t, sourceFile)).toBe(sourceBefore)
    expect(notices(t)).toMatch(/skip|conflict/i)
    expect(audit.logs.at(-1)?.report).toMatch(/skip|conflict/i)
    expect(audit.lastRun?.changes).toBe(0)

    t.model.pushGenerate((request) => {
      const input = JSON.parse(request.lastUserText)
      expect(input.notes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: 'project_deploy-source.md',
            content: source.content,
          }),
          expect.objectContaining({
            filename: 'project_deploy-target.md',
            description: liveDescription,
            content: target.content,
          }),
        ]),
      )
      expect(input.inbox).toHaveLength(3)
      return result([
        { ...mergeTarget, description: liveDescription },
        removeSource,
      ])
    })
    t.model.push(fauxText('New conversation stays queued for the next dream'))
    const retryGate = gateGeneration(t)
    const retrying = t.session.prompt('/dream')
    let latestId = ''
    try {
      await retryGate.entered
      await t.vela
        .session('latest')
        .prompt('A new fact after the retry snapshot')
      latestId = dreamAudit(t).pendingTurns.at(-1)!.id
    } finally {
      retryGate.release()
      await retrying
      retryGate.restore()
    }
    expect(existsSync(t.dataPath(sourceFile))).toBe(false)
    expect(read(t, targetFile)).toContain(source.content)
    expect(read(t, targetFile)).toContain(target.content)
    expect(read(t, targetFile)).toContain(liveDescription)
    expect(dreamAudit(t).pendingTurns).toEqual([
      expect.objectContaining({
        id: latestId,
        sessionId: 'latest',
        user: 'A new fact after the retry snapshot',
      }),
    ])
    expect(
      t.model.calls.filter((call) => call.kind === 'generate'),
    ).toHaveLength(2)
  })
}

test('a concurrent create collision prevents an earlier source deletion and retains all inbox evidence', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('memory', { action: 'save', ...source }),
      fauxText('Source note saved'),
      fauxToolCall('memory', { action: 'save', ...target }),
      fauxText('New target saved live'),
    ],
    generate: [result([removeSource, { ...mergeTarget, action: 'create' }])],
  })
  await t.session.prompt('Save the unique release approval reminder')
  const sourceBefore = read(t, sourceFile)
  const gate = gateGeneration(t)
  const dreaming = t.session.prompt('/dream')
  let liveTarget = ''
  let queuedIds: string[] = []
  try {
    await gate.entered
    await t.vela.session('live').prompt('Save the deployment target note now')
    liveTarget = read(t, targetFile)
    queuedIds = dreamAudit(t).pendingTurns.map((turn) => turn.id)
  } finally {
    gate.release()
    await dreaming
    gate.restore()
  }
  const audit = dreamAudit(t)
  expect({
    sourceStillExists: existsSync(t.dataPath(sourceFile)),
    target: read(t, targetFile),
    pendingIds: audit.pendingTurns.map((turn) => turn.id),
    hasLegacyDreamDir: existsSync(t.dataPath('memory/.dream')),
  }).toEqual({
    sourceStillExists: true,
    target: liveTarget,
    pendingIds: queuedIds,
    hasLegacyDreamDir: false,
  })
  expect(read(t, sourceFile)).toBe(sourceBefore)
  expect(notices(t)).toMatch(/skip|conflict/i)
  expect(audit.logs.at(-1)?.report).toMatch(/skip|conflict/i)
})

test('a changed read-only merge destination prevents duplicate deletion and retains the inbox', async () => {
  const duplicateContent = `${target.content}\n${source.content}`
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('memory', { action: 'save', ...source }),
        fauxToolCall('memory', {
          action: 'save',
          ...target,
          content: duplicateContent,
        }),
      ],
      fauxText('Both notes contain the approval requirement'),
      fauxToolCall('memory', { action: 'save', ...target }),
      fauxText('The target now contains only the deployment schedule'),
    ],
    generate: [
      (request) => {
        const input = JSON.parse(request.lastUserText)
        expect(input.notes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              filename: 'project_deploy-source.md',
              content: source.content,
            }),
            expect.objectContaining({
              filename: 'project_deploy-target.md',
              content: duplicateContent,
            }),
          ]),
        )
        return result([removeSource])
      },
    ],
  })
  await t.session.prompt('Save these overlapping deployment notes')
  const sourceBefore = read(t, sourceFile)
  const gate = gateGeneration(t)
  const dreaming = t.session.prompt('/dream')
  let liveTarget = ''
  let liveIndex = ''
  let queuedIds: string[] = []
  try {
    await gate.entered
    await t.vela
      .session('live')
      .prompt('Keep only the deployment schedule in the target note')
    liveTarget = read(t, targetFile)
    liveIndex = read(t, 'memory/MEMORY.md')
    queuedIds = dreamAudit(t).pendingTurns.map((turn) => turn.id)
  } finally {
    gate.release()
    await dreaming
    gate.restore()
  }
  const audit = dreamAudit(t)
  expect(liveTarget).not.toContain(source.content)
  expect({
    sourceStillExists: existsSync(t.dataPath(sourceFile)),
    target: read(t, targetFile),
    index: read(t, 'memory/MEMORY.md'),
    pendingIds: audit.pendingTurns.map((turn) => turn.id),
    hasLegacyDreamDir: existsSync(t.dataPath('memory/.dream')),
  }).toEqual({
    sourceStillExists: true,
    target: liveTarget,
    index: liveIndex,
    pendingIds: queuedIds,
    hasLegacyDreamDir: false,
  })
  expect(read(t, sourceFile)).toBe(sourceBefore)
  expect(notices(t)).toMatch(/skip|conflict/i)
  expect(notices(t)).toContain('project_deploy-target.md')
  expect(audit.logs.at(-1)?.report).toMatch(/skip|conflict/i)
  expect(audit.lastRun?.changes).toBe(0)
})
