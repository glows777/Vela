import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  larkStartupDiagnostic,
  larkState,
  prepareLarkWrite,
} from '../src/main/lark-settings.ts'

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
    const write = await prepareLarkWrite(
      agentDir,
      effective,
      { appId: 'new' },
      verify,
    )
    await write(effective)
    const saved = JSON.parse(await readFile(path, 'utf8')).extensionConfig.lark
    expect(saved).toEqual({ ...raw, appId: 'new' })
    const before = await readFile(path, 'utf8')
    await expect(
      prepareLarkWrite(agentDir, effective, { appId: 'new' }, async () => {
        throw new Error(effective.appSecret)
      }),
    ).rejects.toThrow(/^Could not verify Lark credentials/)
    expect(() => write({ ...effective, appSecret: 'rotated' })).toThrow(
      'changed during verification',
    )
    expect(await readFile(path, 'utf8')).toBe(before)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a startup diagnostic gives a repair step without returning untrusted error details', () => {
  const secret = crypto.randomUUID()
  const reason = larkStartupDiagnostic(
    new Error(`Unknown Lark tool "${secret}" for chat example`),
  )
  expect(reason).toContain('tools')
  expect(reason).toContain('settings.json')
  expect(reason.includes(secret)).toBe(false)
  const generic = larkStartupDiagnostic(new Error(secret))
  expect(generic).toContain('extensionConfig.lark')
  expect(generic.includes(secret)).toBe(false)
})
