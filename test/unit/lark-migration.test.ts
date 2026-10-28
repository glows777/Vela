import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelSessionId } from '@glows777/vela-channels'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture(chatId = 'oc_group', rootId = 'root/hashed') {
  const root = await mkdtemp(join(tmpdir(), 'vela-lark-migration-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  const key = channelSessionId('feishu', chatId, rootId)
  const nextKey = channelSessionId('lark', chatId, rootId)
  const storageKey = channelSessionId('feishu', chatId)
  const record = {
    key,
    channel: 'feishu',
    chatId,
    chatKind: 'group',
    rootId,
    threadId: 'thread',
    requester: { id: 'ou_owner', name: 'Owner' },
    task: 'Original feishu title',
    activeSessionId: key,
    previousSessionIds: ['channel-previous'],
    state: 'running',
    pendingMessageIds: ['pending'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const json = async (path: string, value: unknown) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${JSON.stringify(value)}\n`)
  }
  const index = join(dataDir, 'channels/index.json')
  await json(index, {
    version: 1,
    createdAt: record.createdAt,
    records: [record],
  })
  await json(join(dataDir, 'channels/routines.json'), {
    version: 1,
    routines: [
      {
        id: 'wake',
        channel: 'feishu',
        chatId,
        targetKey: key,
        creator: record.requester,
        message: 'Keep feishu in user text',
        schedule: { at: '2026-01-02T00:00:00.000Z' },
        createdAt: record.createdAt,
        lastFiredAt: null,
      },
    ],
  })
  const ledger = `${JSON.stringify({ key, chatId, model: 'faux/model', ts: 1, tokens: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } })}\n`
  await writeFile(join(dataDir, 'channels/usage.jsonl'), ledger)
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  const history =
    'IMMUTABLE: feishu_start_topic / old tool result / physical path\n'
  await writeFile(join(dataDir, 'sessions', `${key}.jsonl`), history)
  await writeFile(join(dataDir, 'sessions/channel-previous.jsonl'), history)
  const store = join(dataDir, 'channels', storageKey)
  await mkdir(join(store, 'memory'), { recursive: true })
  await mkdir(join(store, 'workspace'), { recursive: true })
  await writeFile(join(store, 'memory/fact.md'), 'old durable fact')
  await writeFile(join(store, 'workspace/kept.txt'), 'kept')
  const settings = join(root, 'settings.json')
  await json(settings, {
    extensions: ['+builtin:feishu'],
    defaultTools: ['feishu_*'],
    extensionConfig: {
      feishu: {
        appId: '$FEISHU_APP_ID',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy settings interpolation data
        appSecret: '${FEISHU_APP_SECRET}',
        owners: '$FEISHU_OWNERS',
        chats: [{ id: chatId, tools: ['feishu_search_history'] }],
      },
    },
  })
  return {
    root,
    dataDir,
    key,
    nextKey,
    storageKey,
    record,
    index,
    ledger,
    history,
    store,
    settings,
    json,
  }
}
async function migration() {
  return import('../../scripts/lark-migration.ts')
}

test('Lark migration defaults to dry run, preserves physical histories/storage/evidence and is repeatable', async () => {
  const f = await fixture()
  const { migrateLark } = await migration()
  const before = await readFile(f.index, 'utf8')
  const dry = await migrateLark({
    dataDir: f.dataDir,
    settingsFiles: [f.settings],
  })
  expect(dry.applied).toBe(false)
  expect(await readFile(f.index, 'utf8')).toBe(before)
  expect(await readdir(join(f.dataDir, 'channels'))).not.toContain(
    'migration.json',
  )
  const result = await migrateLark({
    dataDir: f.dataDir,
    settingsFiles: [f.settings],
    apply: true,
  })
  expect(result.applied).toBe(true)
  const data = JSON.parse(await readFile(f.index, 'utf8'))
  expect(data.records[0]).toMatchObject({
    ...f.record,
    key: f.nextKey,
    channel: 'lark',
    legacyKey: f.key,
    storageKey: f.storageKey,
  })
  expect(
    await readFile(join(f.dataDir, 'sessions', `${f.key}.jsonl`), 'utf8'),
  ).toBe(f.history)
  expect(await readFile(join(f.dataDir, 'channels/usage.jsonl'), 'utf8')).toBe(
    f.ledger,
  )
  expect(await readFile(join(f.store, 'workspace/kept.txt'), 'utf8')).toBe(
    'kept',
  )
  const routines = JSON.parse(
    await readFile(join(f.dataDir, 'channels/routines.json'), 'utf8'),
  )
  expect(routines.routines[0]).toMatchObject({
    channel: 'lark',
    targetKey: f.nextKey,
    lastFiredAt: null,
    message: 'Keep feishu in user text',
  })
  const settings = JSON.parse(await readFile(f.settings, 'utf8'))
  expect(settings.extensions).toEqual(['+builtin:lark'])
  expect(settings.defaultTools).toEqual(['lark_*'])
  expect(settings.extensionConfig.lark).toMatchObject({
    appId: '$LARK_APP_ID',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: canonical settings interpolation data
    appSecret: '${LARK_APP_SECRET}',
    owners: '$LARK_OWNERS',
  })
  expect(
    (
      await migrateLark({
        dataDir: f.dataDir,
        settingsFiles: [f.settings],
        apply: true,
      })
    ).changed,
  ).toEqual([])
})

test.each([
  'route',
  'storage',
  'config',
  'permission',
  'orphan-session',
  'orphan-artifacts',
  'orphan-storage',
  'orphan-usage',
  'orphan-routine',
])(
  'Lark migration preflights %s collisions/orphans before any write',
  async (kind) => {
    const f = await fixture()
    const index = JSON.parse(await readFile(f.index, 'utf8'))
    if (kind === 'route') {
      index.records.push({
        ...f.record,
        key: f.nextKey,
        channel: 'lark',
        activeSessionId: f.nextKey,
      })
      await f.json(f.index, index)
    }
    if (kind === 'storage')
      await mkdir(
        join(f.dataDir, 'channels', channelSessionId('lark', f.record.chatId)),
      )
    if (kind === 'config')
      await f.json(f.settings, { extensionConfig: { feishu: {}, lark: {} } })
    if (kind === 'permission')
      await f.json(f.settings, {
        extensionConfig: {
          'permission-gate': {
            rules: { 'feishu_*': 'deny', lark_search_history: 'allow' },
          },
        },
      })
    if (kind === 'orphan-session')
      await writeFile(
        join(f.dataDir, 'sessions/feishu-unknown.jsonl'),
        'unknown',
      )
    if (kind === 'orphan-artifacts')
      await mkdir(join(f.dataDir, 'sessions/feishu-unknown'))
    if (kind === 'orphan-storage')
      await mkdir(join(f.dataDir, 'channels/feishu-unknown'))
    if (kind === 'orphan-usage')
      await writeFile(
        join(f.dataDir, 'channels/usage.jsonl'),
        `${JSON.stringify({ key: 'feishu-unknown' })}\n`,
      )
    if (kind === 'orphan-routine')
      await f.json(join(f.dataDir, 'channels/routines.json'), {
        version: 1,
        routines: [{ channel: 'feishu', targetKey: 'feishu-unknown' }],
      })
    const before = await readFile(f.index, 'utf8')
    await expect(
      (await migration()).migrateLark({
        dataDir: f.dataDir,
        settingsFiles: [f.settings],
        apply: true,
      }),
    ).rejects.toThrow(/collision|orphan|ambiguous/i)
    expect(await readFile(f.index, 'utf8')).toBe(before)
    expect(await readdir(join(f.dataDir, 'channels'))).not.toContain(
      'migration.json',
    )
  },
)

test('migration stops mixed old/new chats even when their topic keys differ', async () => {
  const f = await fixture()
  const data = JSON.parse(await readFile(f.index, 'utf8'))
  data.records.push({
    ...f.record,
    key: channelSessionId('lark', f.record.chatId, 'another'),
    channel: 'lark',
    rootId: 'another',
    activeSessionId: 'canonical',
  })
  await f.json(f.index, data)
  await expect(
    (await migration()).migrateLark({ dataDir: f.dataDir, apply: true }),
  ).rejects.toThrow(/collision|ambiguous/i)
})

test('interrupted per-file apply resumes only with unchanged planned files and explicit settings', async () => {
  const f = await fixture()
  const afterIndex = JSON.parse(await readFile(f.index, 'utf8'))
  Object.assign(afterIndex.records[0], {
    channel: 'lark',
    key: f.nextKey,
    legacyKey: f.key,
    storageKey: f.storageKey,
  })
  const before = await readFile(f.index, 'utf8')
  const change = {
    path: f.index,
    before,
    after: JSON.stringify(afterIndex) + '\n',
  }
  const marker = join(f.dataDir, 'channels/migration.json')
  await f.json(marker, {
    version: 1,
    status: 'pending',
    settingsFiles: [f.settings],
    changes: [change],
  })
  await expect(
    (await migration()).migrateLark({ dataDir: f.dataDir, apply: true }),
  ).rejects.toThrow('same explicit settings')
  await writeFile(f.index, 'externally edited')
  await expect(
    (await migration()).migrateLark({
      dataDir: f.dataDir,
      settingsFiles: [f.settings],
      apply: true,
    }),
  ).rejects.toThrow('collision after interruption')
  expect(JSON.parse(await readFile(marker, 'utf8')).status).toBe('pending')
  await writeFile(f.index, change.after)
  const result = await (await migration()).migrateLark({
    dataDir: f.dataDir,
    settingsFiles: [f.settings],
    apply: true,
  })
  expect(result.applied).toBe(true)
  expect(JSON.parse(await readFile(marker, 'utf8')).status).toBe('complete')
})

test('migration refuses shared physical session ownership across different routing tuples', async () => {
  const f = await fixture()
  const data = JSON.parse(await readFile(f.index, 'utf8'))
  data.records.push({
    ...f.record,
    key: channelSessionId('feishu', f.record.chatId, 'another'),
    rootId: 'another',
  })
  await f.json(f.index, data)
  await expect(
    (await migration()).migrateLark({ dataDir: f.dataDir, apply: true }),
  ).rejects.toThrow(/session collision/i)
})

test('malformed historical usage stops preflight without changing the append-only ledger', async () => {
  const f = await fixture()
  const path = join(f.dataDir, 'channels/usage.jsonl')
  const invalid = `${JSON.stringify({ key: f.key, chatId: f.record.chatId, ts: -1 })}\n`
  await writeFile(path, invalid)
  await expect(
    (await migration()).migrateLark({ dataDir: f.dataDir, apply: true }),
  ).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(invalid)
  expect(await readdir(join(f.dataDir, 'channels'))).not.toContain(
    'migration.json',
  )
})

test('old and canonical configuration in different supplied layers also stops rather than merging', async () => {
  const f = await fixture()
  const project = join(f.root, 'project.json')
  await f.json(project, { extensionConfig: { lark: { chats: ['another'] } } })
  const before = await readFile(f.index, 'utf8')
  await expect(
    (await migration()).migrateLark({
      dataDir: f.dataDir,
      settingsFiles: [f.settings, project],
      apply: true,
    }),
  ).rejects.toThrow(/collision/i)
  expect(await readFile(f.index, 'utf8')).toBe(before)
})

test('legacy settings can migrate before the first data directory is created', async () => {
  const f = await fixture()
  await rm(f.dataDir, { recursive: true })
  const result = await (await migration()).migrateLark({
    dataDir: f.dataDir,
    settingsFiles: [f.settings],
    apply: true,
  })
  expect(result.applied).toBe(true)
  expect(
    JSON.parse(await readFile(f.settings, 'utf8')).extensionConfig.lark,
  ).toBeDefined()
})

test('an actual interrupted atomic apply resumes its own already-installed files', async () => {
  const { spyOn } = await import('bun:test')
  const writer = await import('../../packages/channels/src/atomic-json.ts')
  const original = writer.writeAtomicJson
  const f = await fixture()
  const fail = spyOn(writer, 'writeAtomicJson').mockImplementation(
    async (path, value) => {
      if (path === join(f.dataDir, 'channels/routines.json'))
        throw new Error('simulated process interruption')
      return original(path, value)
    },
  )
  try {
    await expect(
      (await migration()).migrateLark({
        dataDir: f.dataDir,
        settingsFiles: [f.settings],
        apply: true,
      }),
    ).rejects.toThrow('simulated process interruption')
  } finally {
    fail.mockRestore()
  }
  const journal = JSON.parse(
    await readFile(join(f.dataDir, 'channels/migration.json'), 'utf8'),
  )
  expect(journal.status).toBe('pending')
  expect(await readFile(f.index, 'utf8')).toBe(
    journal.changes.find((change: { path: string }) => change.path === f.index)
      .after,
  )
  await (await migration()).migrateLark({
    dataDir: f.dataDir,
    settingsFiles: [f.settings],
    apply: true,
  })
  expect(
    JSON.parse(
      await readFile(join(f.dataDir, 'channels/migration.json'), 'utf8'),
    ).status,
  ).toBe('complete')
})

test.each([
  'feishu-oc_group-ou_alice',
  'feishu-ou_alice',
  'feishu-oc_group-unknown',
])(
  'retained pre-shared sender archive %s never becomes shared routing',
  async (id) => {
    const f = await fixture()
    const header =
      id === 'feishu-ou_alice'
        ? {
            type: 'checkpoint',
            messages: [{ role: 'user', content: 'private legacy fact' }],
          }
        : {
            type: 'session',
            version: 2,
            id,
            timestamp: '2026-01-01T00:00:00.000Z',
          }
    const transcript = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'custom', id: 'entry', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', customType: 'private-note', data: 'Private pre-shared transcript' })}\n`
    const path = join(f.dataDir, 'sessions', `${id}.jsonl`)
    await writeFile(path, transcript)
    await mkdir(join(f.dataDir, 'sessions', id), { recursive: true })
    await writeFile(
      join(f.dataDir, 'sessions', id, 'kept.txt'),
      'old tool artifact',
    )
    await (await migration()).migrateLark({
      dataDir: f.dataDir,
      settingsFiles: [f.settings],
      apply: true,
    })
    expect(await readFile(path, 'utf8')).toBe(transcript)
    expect(
      await readFile(join(f.dataDir, 'sessions', id, 'kept.txt'), 'utf8'),
    ).toBe('old tool artifact')
    const index = JSON.parse(await readFile(f.index, 'utf8'))
    expect(index.records).toHaveLength(1)
    expect(
      index.records.some(
        (record: { activeSessionId: string }) => record.activeSessionId === id,
      ),
    ).toBe(false)
    const { assertLarkState } = await import(
      '../../packages/lark/src/legacy.ts'
    )
    expect(() => assertLarkState(f.dataDir)).not.toThrow()
  },
)

test.each(['root', 'channels', 'settings'] as const)(
  'migration backup snapshots linked %s contents independently of live state',
  async (location) => {
    const { symlink, rename, lstat, cp } = await import('node:fs/promises')
    const f = await fixture()
    const beforeIndex = await readFile(f.index, 'utf8')
    const beforeRoutines = await readFile(
      join(f.dataDir, 'channels/routines.json'),
      'utf8',
    )
    const beforeSettings = await readFile(f.settings, 'utf8')
    const source =
      location === 'root'
        ? f.dataDir
        : location === 'channels'
          ? join(f.dataDir, 'channels')
          : f.settings
    const actual = `${source}.actual`
    await rename(source, actual)
    await symlink(actual, source, location === 'settings' ? 'file' : 'dir')
    const result = await (await migration()).migrateLark({
      dataDir: f.dataDir,
      settingsFiles: [f.settings],
      apply: true,
    })
    const backup = result.backup!
    expect(
      await readFile(join(backup, 'data/channels/index.json'), 'utf8'),
    ).toBe(beforeIndex)
    expect(
      await readFile(join(backup, 'data/channels/routines.json'), 'utf8'),
    ).toBe(beforeRoutines)
    await writeFile(
      location === 'settings' ? actual : f.settings,
      'later external edit',
    )
    expect(await readFile(join(backup, 'settings/0.json'), 'utf8')).toBe(
      beforeSettings,
    )
    expect((await lstat(join(backup, 'data'))).isSymbolicLink()).toBe(false)
    expect((await lstat(join(backup, 'data/channels'))).isSymbolicLink()).toBe(
      false,
    )
    expect(
      (await lstat(join(backup, 'settings/0.json'))).isSymbolicLink(),
    ).toBe(false)
    // Restore the snapshot bytes through the original paths, preserving administrator-owned links.
    await cp(join(backup, 'data/channels/index.json'), f.index)
    await cp(
      join(backup, 'data/channels/routines.json'),
      join(f.dataDir, 'channels/routines.json'),
    )
    expect(await readFile(f.index, 'utf8')).toBe(beforeIndex)
    expect(
      await readFile(join(f.dataDir, 'channels/routines.json'), 'utf8'),
    ).toBe(beforeRoutines)
  },
)

test('late omitted settings get an actionable stop without deleting or changing the completed journal', async () => {
  const f = await fixture()
  await (await migration()).migrateLark({ dataDir: f.dataDir, apply: true })
  const marker = join(f.dataDir, 'channels/migration.json')
  const before = await readFile(marker, 'utf8')
  await expect(
    (await migration()).migrateLark({
      dataDir: f.dataDir,
      settingsFiles: [f.settings],
      apply: true,
    }),
  ).rejects.toThrow(/settings.*omitted|additional settings/i)
  expect(await readFile(marker, 'utf8')).toBe(before)
  expect(await readFile(f.settings, 'utf8')).toContain('builtin:feishu')
})
