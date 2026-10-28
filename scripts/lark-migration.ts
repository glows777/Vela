/** One-off, dry-run-first v1 migration. Session histories and usage ledgers are immutable. */
import { chmod, cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { channelSessionId } from '@glows777/vela-channels'
import { writeAtomicJson } from '../packages/channels/src/atomic-json.ts'
import { channelIndexSchema } from '../packages/channels/src/directory.ts'
import { channelRoutinesSchema } from '../packages/channels/src/routines.ts'
import { channelUsageRowSchema } from '../packages/channels/src/usage.ts'

type ObjectValue = Record<string, unknown>
type Change = { path: string; before: string; after: string }
interface Journal {
  version: 1
  status: 'pending' | 'complete'
  settingsFiles: string[]
  changes: Change[]
}
const encode = (value: unknown) => `${JSON.stringify(value)}\n`
const object = (value: unknown): value is ObjectValue =>
  !!value && typeof value === 'object' && !Array.isArray(value)
async function text(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
}
const renamedTool = (name: string) => name.replace(/^([+-]?)feishu_/, '$1lark_')
const oldTool = (name: string) => /^[+-]?feishu_/.test(name)

function toolList(value: unknown, label: string): unknown {
  if (value === undefined) return value
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string'))
    throw new Error(`Invalid tool list ${label}`)
  const names = value as string[]
  if (names.some(oldTool) && names.some((name) => /^[+-]?lark_/.test(name)))
    throw new Error(
      `Ambiguous old/new tool permissions in ${label}; resolve manually`,
    )
  return names.map(renamedTool)
}
function renameSettings(value: unknown, file: string): unknown {
  if (!object(value)) throw new Error(`Settings must be an object: ${file}`)
  const next = structuredClone(value)
  if (Array.isArray(next.extensions)) {
    const old = next.extensions.filter(
      (name) => typeof name === 'string' && /^[+-]?builtin:feishu$/.test(name),
    )
    if (
      old.length &&
      next.extensions.some(
        (name) => typeof name === 'string' && /^[+-]?builtin:lark$/.test(name),
      )
    )
      throw new Error(`Built-in selector collision: ${file}`)
    next.extensions = next.extensions.map((name) =>
      typeof name === 'string'
        ? name.replace(/^([+-]?)builtin:feishu$/, '$1builtin:lark')
        : name,
    )
  }
  if (next.defaultTools !== undefined)
    next.defaultTools = toolList(next.defaultTools, `${file}: defaultTools`)
  const config = next.extensionConfig
  if (object(config)) {
    if ('feishu' in config && 'lark' in config)
      throw new Error(`Config collision extensionConfig.feishu/lark: ${file}`)
    if ('feishu' in config) {
      config.lark = config.feishu
      delete config.feishu
    }
    if (object(config.lark)) {
      for (const key of ['appId', 'appSecret', 'owners']) {
        const ref = config.lark[key]
        if (typeof ref === 'string')
          config.lark[key] = ref.replace(
            /\$(\{?)FEISHU_(APP_ID|APP_SECRET|OWNERS)(\}?)(?=$|[^A-Z0-9_])/g,
            '$$$1LARK_$2$3',
          )
      }
      if (Array.isArray(config.lark.chats))
        for (const chat of config.lark.chats)
          if (object(chat) && chat.tools !== undefined)
            chat.tools = toolList(chat.tools, `${file}: chat ${chat.id}`)
    }
  }
  // No VelaSettings permission-map field exists. SDK/custom-extension rules need their owner,
  // not an untyped recursive replacement that might reinterpret a deny or arbitrary text.
  const remaining = JSON.stringify(next)
  if (
    /feishu_|builtin:feishu|FEISHU_(?:APP_ID|APP_SECRET|OWNERS)/.test(remaining)
  )
    throw new Error(
      `Ambiguous legacy permissions or custom references in ${file}; migrate these explicitly before applying`,
    )
  return next
}

export async function migrateLark(options: {
  dataDir: string
  settingsFiles?: string[]
  apply?: boolean
}): Promise<{ applied: boolean; changed: string[]; backup?: string }> {
  const dataDir = resolve(options.dataDir)
  const settingsFiles = [
    ...new Set((options.settingsFiles ?? []).map((path) => resolve(path))),
  ].sort()
  const marker = join(dataDir, 'channels/migration.json')
  const markerText = await text(marker)
  const prior = markerText ? (JSON.parse(markerText) as Journal) : undefined
  if (
    prior &&
    (prior.version !== 1 || !['pending', 'complete'].includes(prior.status))
  )
    throw new Error('Unknown channel migration version/status')
  if (prior?.status === 'pending') {
    if (JSON.stringify(settingsFiles) !== JSON.stringify(prior.settingsFiles))
      throw new Error('Resume migration with the same explicit settings files')
    // Validate every planned file before resuming the first write; external edits never get overwritten.
    for (const change of prior.changes) {
      const current = await text(change.path)
      if (current !== change.before && current !== change.after)
        throw new Error(
          `Migration collision after interruption: ${change.path}`,
        )
    }
    if (options.apply) await commit(marker, prior)
    return {
      applied: !!options.apply,
      changed: prior.changes.map((change) => change.path),
      backup: `${dataDir}.pre-lark-v1`,
    }
  }
  const changes: Change[] = []
  const add = (path: string, before: string, value: unknown) => {
    const after = encode(value)
    if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(value))
      changes.push({ path, before, after })
  }
  const indexPath = join(dataDir, 'channels/index.json')
  const indexText = await text(indexPath)
  const data = indexText
    ? JSON.parse(indexText)
    : { version: 1, createdAt: new Date().toISOString(), records: [] }
  channelIndexSchema.parse(data)
  const records = data.records as ReturnType<
    typeof channelIndexSchema.parse
  >['records']
  const map = new Map<string, string>()
  const knownSessions = new Set<string>()
  const sessionOwners = new Map<string, string>()
  const knownStores = new Set<string>()
  const allKeys = new Set(records.map((record) => record.key))
  if (allKeys.size !== records.length)
    throw new Error('Route collision: duplicate keys')
  const chats = new Set<string>()
  const canonicalChats = new Set(
    records
      .filter((record) => record.channel === 'lark')
      .map((record) => record.chatId),
  )
  for (const record of records) {
    if (record.channel !== 'feishu' && record.channel !== 'lark') continue
    const expected = channelSessionId(
      record.channel,
      record.chatId,
      record.rootId,
    )
    if (record.key !== expected)
      throw new Error(`Orphan routing tuple ${record.key}`)
    for (const id of [record.activeSessionId, ...record.previousSessionIds]) {
      const owner = sessionOwners.get(id)
      if (owner && owner !== record.key)
        throw new Error(
          `Physical session collision ${id}: ${owner} / ${record.key}`,
        )
      sessionOwners.set(id, record.key)
      knownSessions.add(id)
    }
    if (record.channel === 'lark') {
      if (record.legacyKey) map.set(record.legacyKey, record.key)
      if (record.storageKey) knownStores.add(record.storageKey)
      continue
    }
    if (canonicalChats.has(record.chatId))
      throw new Error(
        `Ambiguous old/new routing collision for chat ${record.chatId}`,
      )
    const next = channelSessionId('lark', record.chatId, record.rootId)
    if (allKeys.has(next))
      throw new Error(`Route collision ${record.key} -> ${next}`)
    if (record.legacyKey || record.storageKey)
      throw new Error(`Ambiguous existing migration metadata ${record.key}`)
    map.set(record.key, next)
    const storage = channelSessionId('feishu', record.chatId)
    knownStores.add(storage)
    chats.add(record.chatId)
    record.legacyKey = record.key
    record.storageKey = storage
    record.key = next
    record.channel = 'lark'
  }
  for (const chatId of chats) {
    const canonical = join(
      dataDir,
      'channels',
      channelSessionId('lark', chatId),
    )
    try {
      await stat(canonical)
      throw new Error(`Storage collision ${canonical}; do not merge stores`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const file of await entries(join(dataDir, 'sessions')))
    if (
      file.startsWith('feishu-') &&
      !knownSessions.has(file.endsWith('.jsonl') ? file.slice(0, -6) : file)
    )
      throw new Error(`Orphan legacy session ${file}`)
  for (const directory of await entries(join(dataDir, 'channels')))
    if (directory.startsWith('feishu-') && !knownStores.has(directory))
      throw new Error(`Orphan legacy storage ${directory}`)
  if (indexText) add(indexPath, indexText, data)
  const routinePath = join(dataDir, 'channels/routines.json')
  const routineText = await text(routinePath)
  if (routineText) {
    const routines = JSON.parse(routineText)
    for (const routine of routines.routines ?? []) {
      if (routine.channel !== 'feishu') continue
      const target = map.get(routine.targetKey)
      const record = records.find((record) => record.key === target)
      if (!record || record.chatId !== routine.chatId)
        throw new Error(`Orphan routine target ${routine.targetKey}`)
      routine.channel = 'lark'
      routine.targetKey = target
    }
    channelRoutinesSchema.parse(routines)
    add(routinePath, routineText, routines)
  }
  const ledger = await text(join(dataDir, 'channels/usage.jsonl'))
  for (const line of ledger?.split('\n').filter(Boolean) ?? []) {
    const row = JSON.parse(line)
    if (
      typeof row.key === 'string' &&
      row.key.startsWith('feishu-') &&
      !map.has(row.key)
    )
      throw new Error(`Orphan usage key ${row.key}`)
    channelUsageRowSchema.parse(row)
  }
  const settings = await Promise.all(
    settingsFiles.map(async (path) => {
      const before = await text(path)
      if (before === undefined)
        throw new Error(`Settings file not found: ${path}`)
      return { path, before, value: JSON.parse(before) as ObjectValue }
    }),
  )
  const sections = settings
    .map(({ value }) => value.extensionConfig)
    .filter(object)
  const selectors = settings.flatMap(({ value }) =>
    Array.isArray(value.extensions) ? value.extensions : [],
  )
  if (
    (sections.some((section) => 'feishu' in section) &&
      sections.some((section) => 'lark' in section)) ||
    (selectors.some(
      (entry) =>
        typeof entry === 'string' && /^[+-]?builtin:feishu$/.test(entry),
    ) &&
      selectors.some(
        (entry) =>
          typeof entry === 'string' && /^[+-]?builtin:lark$/.test(entry),
      ))
  )
    throw new Error(
      'Old/new configuration collision across supplied settings files; resolve explicitly',
    )
  toolList(
    settings.flatMap(({ value }) =>
      Array.isArray(value.defaultTools) ? value.defaultTools : [],
    ),
    'combined defaultTools settings layers',
  )
  for (const { path, before, value } of settings)
    add(path, before, renameSettings(value, path))
  // A complete marker is evidence of a prior apply; new legacy state requires explicit investigation.
  if (prior && changes.length)
    throw new Error(
      'Migration collision: legacy state appeared after completed migration',
    )
  if (!options.apply || !changes.length)
    return {
      applied: !!options.apply,
      changed: changes.map((change) => change.path),
    }
  const backup = `${dataDir}.pre-lark-v1`
  await mkdir(backup, { mode: 0o700 }) // Existing backup is a stop, never overwrite it.
  let hasData = true
  try {
    await stat(dataDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    hasData = false
  }
  if (hasData)
    await cp(dataDir, join(backup, 'data'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
  await mkdir(join(backup, 'settings'), { mode: 0o700 })
  for (const [index, path] of settingsFiles.entries()) {
    const target = join(backup, 'settings', `${index}.json`)
    await cp(path, target)
    await chmod(target, 0o600)
  }
  // Stop on source drift after backup and before installing the write barrier.
  for (const change of changes)
    if ((await text(change.path)) !== change.before)
      throw new Error(
        `Migration collision: file changed during preflight ${change.path}`,
      )
  const journal: Journal = {
    version: 1,
    status: 'pending',
    settingsFiles,
    changes,
  }
  await writeAtomicJson(marker, journal)
  await commit(marker, journal)
  return {
    applied: true,
    changed: changes.map((change) => change.path),
    backup,
  }
}
async function commit(marker: string, journal: Journal): Promise<void> {
  for (const change of journal.changes)
    await writeAtomicJson(change.path, JSON.parse(change.after))
  await writeAtomicJson(marker, { ...journal, status: 'complete' })
}
