import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelSessionId } from '@glows777/vela-channels'

const instruction =
  'Stop Vela and run bun scripts/migrate-lark.ts --data-dir <dataDir> --settings <settings.json> (dry run first, then --apply).'

/** Old state must be explicitly migrated; never silently open a second conversation/store. */
export function assertLarkState(dataDir: string): void {
  const directory = join(dataDir, 'channels')
  const index = join(directory, 'index.json')
  const records: {
    channel: string
    chatId: string
    rootId?: string
    key: string
    legacyKey?: string
    storageKey?: string
    activeSessionId: string
    previousSessionIds: string[]
  }[] = existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')).records : []
  if (records.some((record) => record.channel === 'feishu'))
    throw new Error(
      `Legacy Feishu routing requires migration to Lark. ${instruction}`,
    )
  const stores = new Set<string>()
  const sessions = new Set<string>()
  for (const record of records.filter((entry) => entry.channel === 'lark')) {
    if (
      record.legacyKey &&
      record.legacyKey !==
        channelSessionId('feishu', record.chatId, record.rootId)
    )
      throw new Error('Invalid legacy Lark routing metadata')
    if (record.storageKey) {
      if (record.storageKey !== channelSessionId('feishu', record.chatId))
        throw new Error('Invalid legacy Lark storage metadata')
      if (existsSync(join(directory, channelSessionId('lark', record.chatId))))
        throw new Error(
          'Lark storage collision; resolve old/new stores before startup',
        )
      stores.add(record.storageKey)
    }
    sessions.add(record.activeSessionId)
    for (const id of record.previousSessionIds) sessions.add(id)
  }
  for (const entry of existsSync(directory) ? readdirSync(directory) : [])
    if (entry.startsWith('feishu-') && !stores.has(entry))
      throw new Error(`Orphaned legacy Feishu storage ${entry}. ${instruction}`)
  const sessionDir = join(dataDir, 'sessions')
  for (const file of existsSync(sessionDir) ? readdirSync(sessionDir) : [])
    if (
      file.startsWith('feishu-') &&
      !sessions.has(file.endsWith('.jsonl') ? file.slice(0, -6) : file)
    )
      throw new Error(`Orphaned legacy Feishu session ${file}. ${instruction}`)
}

export function assertLarkEnv(env: Record<string, string | undefined>): void {
  const old = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_OWNERS'].filter(
    (name) => env[name] !== undefined,
  )
  if (old.length)
    throw new Error(
      `Legacy environment names: ${old.map((name) => `${name} -> ${name.replace('FEISHU_', 'LARK_')}`).join(', ')}. Remove old names after administrator cutover; values were not changed.`,
    )
}
