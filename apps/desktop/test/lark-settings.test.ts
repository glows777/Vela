import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { larkState, writeLark } from '../src/main/lark-settings.ts'

test('an ID-only edit verifies with the saved secret and keeps its expression on disk', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'vela-lark-settings-'))
  const path = join(agentDir, 'settings.json')
  const raw = { appId: 'old', appSecret: '$SAVED', chats: '$GROUPS' }
  const effective = { ...raw, appSecret: crypto.randomUUID(), chats: 'a,b' }
  try {
    await writeFile(path, JSON.stringify({ extensionConfig: { lark: raw } }))
    const state = larkState(raw, effective, false)
    expect(state).toEqual({
      appId: 'old',
      appSecretSaved: true,
      chats: ['a', 'b'],
      envExpression: true,
      runInApp: true,
      loaded: false,
    })
    const verify = async (id: string, secret: string) => {
      expect(id).toBe('new')
      expect(secret === effective.appSecret).toBe(true)
    }
    await writeLark(agentDir, effective, { appId: 'new' }, verify, () => {})
    const saved = JSON.parse(await readFile(path, 'utf8')).extensionConfig.lark
    expect(saved).toEqual({ ...raw, appId: 'new' })
    const before = await readFile(path, 'utf8')
    await expect(
      writeLark(
        agentDir,
        effective,
        { appId: 'new' },
        async () => {
          throw new Error(effective.appSecret)
        },
        () => {},
      ),
    ).rejects.toThrow(/^Could not verify Lark credentials/)
    await expect(
      writeLark(agentDir, effective, { runInApp: false }, verify, () => {
        throw new Error('Busy')
      }),
    ).rejects.toThrow('Busy')
    expect(await readFile(path, 'utf8')).toBe(before)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})
