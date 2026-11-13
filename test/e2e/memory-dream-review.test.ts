import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
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
const inboxFile = 'memory/.dream/inbox.jsonl'
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
const inbox = (
  t: TestVela,
): { id: string; sessionId: string; user: string }[] =>
  existsSync(t.dataPath(inboxFile))
    ? read(t, inboxFile)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

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
    let queued = ''
    try {
      await gate.entered
      await t.vela
        .session('live')
        .prompt('Change only the description of the deployment target')
      liveTarget = read(t, targetFile)
      liveIndex = read(t, 'memory/MEMORY.md')
      queued = read(t, inboxFile)
    } finally {
      gate.release()
      await dreaming
      gate.restore()
    }
    expect({
      sourceStillExists: existsSync(t.dataPath(sourceFile)),
      target: read(t, targetFile),
      index: read(t, 'memory/MEMORY.md'),
      inbox: read(t, inboxFile),
    }).toEqual({
      sourceStillExists: true,
      target: liveTarget,
      index: liveIndex,
      inbox: queued,
    })
    expect(read(t, sourceFile)).toBe(sourceBefore)
    expect(notices(t)).toMatch(/skip|conflict/i)
    expect(read(t, 'memory/.dream/log.md')).toMatch(/skip|conflict/i)
    expect(
      JSON.parse(read(t, 'memory/.dream/state.json')).lastRun.changes,
    ).toBe(0)

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
      latestId = inbox(t).at(-1)!.id
    } finally {
      retryGate.release()
      await retrying
      retryGate.restore()
    }
    expect(existsSync(t.dataPath(sourceFile))).toBe(false)
    expect(read(t, targetFile)).toContain(source.content)
    expect(read(t, targetFile)).toContain(target.content)
    expect(read(t, targetFile)).toContain(liveDescription)
    expect(inbox(t)).toEqual([
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
  let queued = ''
  try {
    await gate.entered
    await t.vela.session('live').prompt('Save the deployment target note now')
    liveTarget = read(t, targetFile)
    queued = read(t, inboxFile)
  } finally {
    gate.release()
    await dreaming
    gate.restore()
  }
  expect({
    sourceStillExists: existsSync(t.dataPath(sourceFile)),
    target: read(t, targetFile),
    inbox: read(t, inboxFile),
  }).toEqual({
    sourceStillExists: true,
    target: liveTarget,
    inbox: queued,
  })
  expect(read(t, sourceFile)).toBe(sourceBefore)
  expect(notices(t)).toMatch(/skip|conflict/i)
  expect(read(t, 'memory/.dream/log.md')).toMatch(/skip|conflict/i)
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
  let queued = ''
  try {
    await gate.entered
    await t.vela
      .session('live')
      .prompt('Keep only the deployment schedule in the target note')
    liveTarget = read(t, targetFile)
    liveIndex = read(t, 'memory/MEMORY.md')
    queued = read(t, inboxFile)
  } finally {
    gate.release()
    await dreaming
    gate.restore()
  }
  expect(liveTarget).not.toContain(source.content)
  expect({
    sourceStillExists: existsSync(t.dataPath(sourceFile)),
    target: read(t, targetFile),
    index: read(t, 'memory/MEMORY.md'),
    inbox: read(t, inboxFile),
  }).toEqual({
    sourceStillExists: true,
    target: liveTarget,
    index: liveIndex,
    inbox: queued,
  })
  expect(read(t, sourceFile)).toBe(sourceBefore)
  expect(notices(t)).toMatch(/skip|conflict/i)
  expect(notices(t)).toContain('project_deploy-target.md')
  expect(read(t, 'memory/.dream/log.md')).toMatch(/skip|conflict/i)
  expect(JSON.parse(read(t, 'memory/.dream/state.json')).lastRun.changes).toBe(
    0,
  )
})
