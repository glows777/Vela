import { afterEach, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import * as adapter from '@glows777/vela-lark'
import { z } from 'zod'
import { fakeLark } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

const kept: string[] = []
afterEach(async () => {
  await cleanupTestVelas()
  for (const cwd of kept.splice(0))
    await rm(cwd, { recursive: true, force: true })
})
test('canonical Lark factory, config, channel and tools have one public naming scheme', async () => {
  expect(Object.keys(adapter)).toContain('lark')
  expect(Object.keys(adapter)).not.toContain('feishu')
  expect(adapter.larkConfig.name).toBe('lark')
  const lark = (adapter as unknown as { lark: typeof adapter.lark }).lark
  const fake = fakeLark()
  const t = createTestVela({
    responses: [],
    extensions: [lark({ transport: fake.transport, owners: ['ou_alice'] })],
  })
  await t.vela.ready()
  expect(t.vela.channels().map((ch) => ch.name)).toEqual(['lark'])
  const names = t.internals.registry.getAllTools().map((tool) => tool.name)
  expect(names).toContain('lark_start_topic')
  expect(names.some((name) => name.startsWith('feishu_'))).toBe(false)
})
test('legacy Lark environment keys fail before transport startup with actionable cutover names', () => {
  const dir = tempDir('vela-lark-env-')
  try {
    expect(() =>
      adapter.larkConfig.resolve(
        {},
        {
          cwd: dir.path,
          agentDir: dir.path,
          projectDir: join(dir.path, '.vela'),
          trusted: false,
          env: { FEISHU_APP_ID: 'private' },
        },
      ),
    ).toThrow('FEISHU_APP_ID -> LARK_APP_ID')
  } finally {
    dir.cleanup()
  }
})

test('migrated routing resumes the same session in legacy memory/workspace and retains historical usage', async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { channelSessionId } = await import('@glows777/vela-channels')
  const { migrateLark } = await import('../../scripts/lark-migration.ts')
  const fake = fakeLark()
  const lark = (adapter as unknown as { lark: typeof adapter.lark }).lark
  const old = channelSessionId('feishu', 'oc_group', 'root')
  const t = createTestVela({
    sessionId: old,
    responses: [
      fauxToolCall('feishu_legacy_output', {}),
      { text: 'old result' },
    ],
    extensions: [
      function feishu(api) {
        api.registerTool({
          name: 'legacy_output',
          description: 'Pre-rename output fixture',
          inputSchema: z.object({}),
          maxResultChars: 20,
          execute: async () => 'immutable old output '.repeat(1000),
        })
      },
    ],
  })
  await t.run('Historical feishu tool references stay unchanged')
  await t.session.save()
  const file = join(t.dataDir, 'sessions', `${old}.jsonl`)
  const before = await readFile(file, 'utf8')
  const { readdir } = await import('node:fs/promises')
  const artifacts = join(t.dataDir, 'sessions', old)
  const artifactPaths = await readdir(artifacts, {
    recursive: true,
    withFileTypes: true,
  })
  const artifactBytes = await Promise.all(
    artifactPaths
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name)
        return { path, bytes: await readFile(path) }
      }),
  )
  expect(artifactBytes.length).toBeGreaterThan(0)
  expect(before).toContain('feishu_legacy_output')
  const ch = join(t.dataDir, 'channels')
  const oldStore = join(ch, 'feishu-oc_group')
  await mkdir(join(oldStore, 'memory'), { recursive: true })
  await mkdir(join(oldStore, 'workspace'), { recursive: true })
  await writeFile(
    join(oldStore, 'memory/project_fact.md'),
    '---\nname: fact\ndescription: deployment fact\ntype: project\n---\nThe deployment is cobalt.',
  )
  const now = new Date().toISOString()
  await writeFile(
    join(ch, 'index.json'),
    JSON.stringify({
      version: 1,
      createdAt: now,
      records: [
        {
          key: old,
          channel: 'feishu',
          chatId: 'oc_group',
          chatKind: 'group',
          rootId: 'root',
          threadId: 'thread',
          requester: { id: 'ou_alice', name: 'Alice' },
          task: 'task',
          activeSessionId: old,
          previousSessionIds: [],
          state: 'done',
          pendingMessageIds: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  )
  const ledger =
    JSON.stringify({
      key: old,
      chatId: 'oc_group',
      model: 'old/model',
      ts: 1,
      tokens: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }) + '\n'
  await writeFile(join(ch, 'usage.jsonl'), ledger)
  kept.push(t.cwd)
  await t.cleanup({ keepDir: true })
  await migrateLark({ dataDir: t.dataDir, apply: true })
  expect(await readFile(file, 'utf8')).toBe(before)
  for (const artifact of artifactBytes)
    expect(await readFile(artifact.path)).toEqual(artifact.bytes)
  const seen: { cwd: string; scope: unknown }[] = []
  const next = createTestVela({
    cwd: t.cwd,
    responses: [
      fauxToolCall('memory', { action: 'read', filename: 'project_fact.md' }),
      (req) => {
        expect(JSON.stringify(req.toolResults)).toContain('cobalt')
        return { text: 'continued' }
      },
      fauxText('file received'),
      fauxText('new topic shares the original store'),
    ],
    extensions: [
      lark({ chats: ['oc_group'], transport: fake.transport }),
      (vela) => {
        vela.on('session_start', (_event, { session }) => {
          if (session.id === old)
            seen.push({ cwd: session.cwd, scope: session.scope })
        })
      },
    ],
  })
  await next.vela.startChannels()
  const { larkEvent } = await import('../support/lark.ts')
  await fake.deliver(
    larkEvent({
      message_id: 'next',
      chat_id: 'oc_group',
      root_id: 'root',
      thread_id: 'thread',
      content: JSON.stringify({ text: 'continue' }),
    }),
  )
  await (await import('@glows777/vela-channels/testing')).drainChannels(
    next.vela,
  )
  expect(next.vela.sessions().some((session) => session.id === old)).toBe(true)
  expect(seen).toEqual([
    {
      cwd: join(oldStore, 'workspace'),
      scope: { id: 'lark-oc_group', kind: 'shared', dataDir: oldStore },
    },
  ])
  expect(
    next.vela
      .session(old)
      .messages.some((message) =>
        JSON.stringify(message).includes('Historical feishu'),
      ),
  ).toBe(true)
  expect(await readFile(join(ch, 'usage.jsonl'), 'utf8')).toStartWith(ledger)
  expect(fake.sent.some((message) => message.text.includes('continued'))).toBe(
    true,
  )
  fake.resources.set('new-file', [
    Buffer.from('attachment remains in legacy storage'),
  ])
  fake.deliver(
    larkEvent({
      message_id: 'file-msg',
      chat_id: 'oc_group',
      root_id: 'root',
      thread_id: 'thread',
      message_type: 'file',
      content: JSON.stringify({
        file_key: 'new-file',
        file_name: 'sample.txt',
      }),
    }),
  )
  await (await import('@glows777/vela-channels/testing')).drainChannels(
    next.vela,
  )
  expect(
    await readFile(join(oldStore, 'files/file-msg-sample.txt'), 'utf8'),
  ).toBe('attachment remains in legacy storage')
  fake.deliver(
    larkEvent({
      message_id: 'new-topic',
      chat_id: 'oc_group',
      root_id: 'new_root',
      thread_id: 'new-thread',
      content: JSON.stringify({ text: 'a new topic' }),
    }),
  )
  await (await import('@glows777/vela-channels/testing')).drainChannels(
    next.vela,
  )
  expect(next.vela.session('lark-oc_group-new_root').scope?.dataDir).toBe(
    oldStore,
  )
})

test('unfinished migration prevents starting any transport', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const fake = fakeLark()
  let starts = 0
  fake.transport.start = async () => {
    starts++
  }
  const lark = (adapter as unknown as { lark: typeof adapter.lark }).lark
  const t = createTestVela({
    responses: [],
    extensions: [lark({ transport: fake.transport })],
  })
  await mkdir(join(t.dataDir, 'channels'), { recursive: true })
  await writeFile(
    join(t.dataDir, 'channels/migration.json'),
    JSON.stringify({ version: 1, status: 'pending' }),
  )
  await t.vela.startChannels().catch(() => {})
  expect(starts).toBe(0)
  expect(t.vela.runningChannels()).toEqual([])
})

test('migrated pending recovery and overdue one-off run once across two restarts', async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { fauxError } = await import('@glows777/vela-core/testing')
  const { drainChannels } = await import('@glows777/vela-channels/testing')
  const { migrateLark } = await import('../../scripts/lark-migration.ts')
  const old = 'feishu-oc_group-root'
  const t = createTestVela({
    sessionId: old,
    responses: [fauxError('400 interrupted')],
  })
  await t.run('Finish the original task').catch(() => {})
  t.session.appendEntry('channel.input', { messageId: 'trigger', timestamp: 1 })
  await t.session.save()
  const ch = join(t.dataDir, 'channels')
  await mkdir(join(ch, 'feishu-oc_group/workspace'), { recursive: true })
  const createdAt = '2026-01-01T00:00:00.000Z'
  const record = {
    key: old,
    channel: 'feishu',
    chatId: 'oc_group',
    chatKind: 'group',
    rootId: 'root',
    threadId: 'thread',
    requester: { id: 'ou_alice', name: 'Alice' },
    replyTarget: 'trigger',
    task: 'pending task',
    activeSessionId: old,
    previousSessionIds: [],
    state: 'running',
    pendingMessageIds: ['trigger'],
    createdAt,
    updatedAt: createdAt,
  }
  await writeFile(
    join(ch, 'index.json'),
    JSON.stringify({ version: 1, createdAt, records: [record] }),
  )
  await writeFile(
    join(ch, 'routines.json'),
    JSON.stringify({
      version: 1,
      routines: [
        {
          id: 'wake',
          channel: 'feishu',
          chatId: 'oc_group',
          targetKey: old,
          creator: record.requester,
          message: 'wake exactly once',
          schedule: { at: '2026-01-02T00:00:00.000Z' },
          createdAt,
          lastFiredAt: null,
        },
      ],
    }),
  )
  kept.push(t.cwd)
  await t.cleanup({ keepDir: true })
  await migrateLark({ dataDir: t.dataDir, apply: true })
  const fake = fakeLark()
  const next = createTestVela({
    cwd: t.cwd,
    responses: [{ text: 'recovered original' }, { text: 'delivered wake' }],
    extensions: [
      adapter.lark({ chats: ['oc_group'], transport: fake.transport }),
    ],
  })
  await next.vela.startChannels()
  const deadline = Date.now() + 3000
  while (
    !fake.sent.some((message) => message.text.includes('delivered wake'))
  ) {
    if (Date.now() > deadline)
      throw new Error('Migrated recovery/routine did not finish')
    await Bun.sleep(1)
  }
  await drainChannels(next.vela)
  expect(next.model.calls).toHaveLength(2)
  expect(next.model.calls[0]!.lastUserText).toContain(
    'Finish the original task',
  )
  expect(next.model.calls[1]!.lastUserText).toContain('wake exactly once')
  expect(
    JSON.parse(await readFile(join(ch, 'routines.json'), 'utf8')).routines,
  ).toEqual([])
  expect(
    JSON.parse(await readFile(join(ch, 'index.json'), 'utf8')).records[0]
      .pendingMessageIds,
  ).toEqual([])
  await next.cleanup({ keepDir: true })
  const againFake = fakeLark()
  const again = createTestVela({
    cwd: t.cwd,
    responses: [],
    extensions: [
      adapter.lark({ chats: ['oc_group'], transport: againFake.transport }),
    ],
  })
  await again.vela.startChannels()
  await drainChannels(again.vela)
  expect(again.model.calls).toEqual([])
  expect(againFake.sent).toEqual([])
})
