import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { interpolate, isPlainObject } from '../shared/interpolate.ts'
import {
  nextOccurrence,
  type RoutineSchedule,
  routineTimezone,
} from '../shared/routine-time.ts'
import {
  isSafeSegment,
  isStrictlyInside,
  legacyChannelSessionId,
  type MigrationOps,
  readJsonStrict,
} from './migrate-legacy-sources.ts'

interface LegacyChannelRecord {
  key: string
  legacyKey?: string
  channel: string
  storageKey?: string
  chatId: string
  chatKind: 'group' | 'direct'
  rootId?: string
  threadId?: string
  task?: string
  activeSessionId: string
  previousSessionIds?: string[]
  state?: 'running' | 'waiting' | 'done' | 'stopped'
  waitingReason?: string
  pendingMessageIds?: (string | { id: string; passive?: boolean })[]
  createdAt?: string
  updatedAt?: string
}

function mapChannelState(
  state: LegacyChannelRecord['state'],
): 'idle' | 'waiting_human' | 'stopped' {
  if (state === 'waiting') return 'waiting_human'
  if (state === 'stopped') return 'stopped'
  return 'idle'
}

function resolveConfiguredChatId(
  rawId: string,
  env: Record<string, string | undefined> | undefined,
  warnings: string[],
): string | undefined {
  if (!rawId.includes('$')) return rawId.trim() || undefined
  if (!env) {
    warnings.push(
      `Skipped env-expression lark.chats entry "${rawId}" during offline database migration`,
    )
    return undefined
  }
  const expanded = interpolate(rawId, env).trim()
  if (!expanded) {
    warnings.push(
      `Skipped empty expanded lark.chats entry "${rawId}" during database migration`,
    )
    return undefined
  }
  return expanded
}

function readChannelSection(
  agentDir: string,
  sectionName: 'lark' | 'local',
): Record<string, unknown> | undefined {
  const configFile = join(agentDir, 'config.json')
  if (existsSync(configFile)) {
    const parsed = readJsonStrict(configFile)
    if (isPlainObject(parsed) && isPlainObject(parsed[sectionName])) {
      return parsed[sectionName] as Record<string, unknown>
    }
    return undefined
  }
  const settingsFile = join(agentDir, 'settings.json')
  if (existsSync(settingsFile)) {
    const parsed = readJsonStrict(settingsFile)
    if (
      isPlainObject(parsed) &&
      isPlainObject(parsed.extensionConfig) &&
      isPlainObject(parsed.extensionConfig[sectionName])
    ) {
      return parsed.extensionConfig[sectionName] as Record<string, unknown>
    }
  }
  return undefined
}

function readLarkChatsConfig(ops: MigrationOps): Record<string, unknown>[] {
  for (const name of ['lark', 'local'] as const) {
    const sec = readChannelSection(ops.agentDir, name)
    if (sec && typeof sec.timezone === 'string' && sec.timezone.trim()) {
      try {
        ops.channelTimezones.set(name, routineTimezone(sec.timezone))
      } catch {
        ops.warnings.push(`Ignored invalid ${name}.timezone "${sec.timezone}"`)
      }
    }
  }

  const larkSection = readChannelSection(ops.agentDir, 'lark')
  const rawChats = larkSection?.chats
  if (rawChats === undefined) return []

  if (typeof rawChats === 'string') {
    const resolved = resolveConfiguredChatId(rawChats, ops.env, ops.warnings)
    if (!resolved) return []
    return resolved
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id }))
  }
  if (!Array.isArray(rawChats)) return []

  const chats: Record<string, unknown>[] = []
  for (const item of rawChats) {
    if (typeof item === 'string') {
      const id = resolveConfiguredChatId(item, ops.env, ops.warnings)
      if (id) chats.push({ id })
    } else if (isPlainObject(item) && typeof item.id === 'string') {
      const id = resolveConfiguredChatId(item.id, ops.env, ops.warnings)
      if (id) chats.push({ ...item, id })
    }
  }
  return chats
}

export function migrateLarkChats(ops: MigrationOps): void {
  for (const chat of readLarkChatsConfig(ops)) {
    const chatId = String(chat.id)
    ops.configuredLarkChats.add(chatId)
    const projectId = `lark-group:${chatId}`
    ops.projectByChat.set(`lark\0${chatId}`, projectId)

    const extraConfig: Record<string, unknown> = {}
    for (const key of [
      'environment',
      'readUntagged',
      'topicModel',
      'topicThinkingLevel',
    ] as const) {
      if (chat[key] !== undefined) extraConfig[key] = chat[key]
    }
    const configJson =
      Object.keys(extraConfig).length > 0 ? JSON.stringify(extraConfig) : null

    ops.ensureProject({
      id: projectId,
      name: chatId,
      defaultModel: typeof chat.model === 'string' ? chat.model : null,
      defaultThinkingLevel:
        typeof chat.thinkingLevel === 'string' ? chat.thinkingLevel : null,
      defaultToolsJson: Array.isArray(chat.tools)
        ? JSON.stringify(chat.tools)
        : null,
      configJson,
    })
    ops.ensureChannelBinding({
      channel: 'lark',
      externalId: chatId,
      kind: 'group',
      projectId,
      sessionId: null,
      enabled: true,
      configJson,
    })
  }
}

export function migrateChannelDirectory(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  for (const dataDir of dataDirs) {
    const channelsRoot = join(dataDir, 'channels')
    const indexFile = join(channelsRoot, 'index.json')
    if (!existsSync(indexFile)) continue
    const parsed = readJsonStrict(indexFile)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
      throw new Error(`Invalid channel directory ${indexFile}`)
    }

    for (const rawRecord of parsed.records) {
      if (
        !isPlainObject(rawRecord) ||
        typeof rawRecord.key !== 'string' ||
        typeof rawRecord.channel !== 'string' ||
        typeof rawRecord.chatId !== 'string' ||
        typeof rawRecord.activeSessionId !== 'string'
      ) {
        continue
      }
      const rec = rawRecord as unknown as LegacyChannelRecord
      const isLocalChannel = rec.channel === 'local'
      const isGroup = rec.chatKind === 'group'
      const isTopic = Boolean(rec.rootId && rec.threadId)
      let projectId: string | null = null

      if (isLocalChannel) {
        projectId = rec.chatId
        if (!ops.localProjectIds.has(projectId)) {
          ops.ensureProject({
            id: projectId,
            name: projectId,
            dataDir,
            hubSessionId: null,
          })
          ops.localProjectIds.add(projectId)
        }
      } else if (isGroup) {
        const chatKey = `${rec.channel}\0${rec.chatId}`
        projectId =
          ops.projectByChat.get(chatKey) ??
          (rec.channel === 'lark'
            ? `lark-group:${rec.chatId}`
            : `channel-group:${rec.channel}:${rec.chatId}`)
        ops.projectByChat.set(chatKey, projectId)

        let validatedDataDir: string | null = null
        const candidateStorage =
          rec.storageKey ?? `${rec.channel}-${rec.chatId}`
        if (isSafeSegment(candidateStorage)) {
          const assetDir = join(channelsRoot, candidateStorage)
          if (
            isStrictlyInside(assetDir, channelsRoot) &&
            (rec.storageKey !== undefined || existsSync(assetDir))
          ) {
            validatedDataDir = assetDir
          }
        } else if (rec.storageKey !== undefined) {
          ops.warnings.push(
            `Ignored unsafe storageKey "${rec.storageKey}" in ${indexFile}`,
          )
        }

        ops.ensureProject({
          id: projectId,
          name: rec.chatId,
          dataDir: validatedDataDir,
          hubSessionId: !isTopic ? rec.activeSessionId : null,
        })
      }

      const sessionKind = isLocalChannel
        ? 'work'
        : isTopic
          ? 'topic'
          : isGroup
            ? 'hub'
            : 'chat'

      ops.ensureSession({
        id: rec.activeSessionId,
        projectId,
        kind: sessionKind,
        name: typeof rec.task === 'string' && rec.task ? rec.task : null,
        state: mapChannelState(rec.state),
        waitingReason: rec.waitingReason ?? null,
        createdAt: rec.createdAt ?? ops.now,
        updatedAt: rec.updatedAt ?? rec.createdAt ?? ops.now,
      })

      if (!isLocalChannel) {
        const groupAllowed =
          rec.channel !== 'lark' || ops.configuredLarkChats.has(rec.chatId)
        if (isGroup) {
          ops.ensureChannelBinding({
            channel: rec.channel,
            externalId: rec.chatId,
            kind: 'group',
            projectId,
            sessionId: !isTopic ? rec.activeSessionId : null,
            enabled: groupAllowed,
          })
        }
        if (isTopic && rec.rootId) {
          ops.ensureChannelBinding({
            channel: rec.channel,
            externalId: `${rec.chatId}:${rec.rootId}`,
            threadId: rec.threadId ?? null,
            kind: 'group',
            projectId,
            sessionId: rec.activeSessionId,
            enabled: groupAllowed,
          })
        } else if (!isGroup) {
          ops.ensureChannelBinding({
            channel: rec.channel,
            externalId: rec.chatId,
            kind: 'direct',
            projectId: null,
            sessionId: rec.activeSessionId,
            enabled: true,
          })
        }
      }

      ops.channelSessionByKey.set(rec.key, {
        sessionId: rec.activeSessionId,
        projectId,
      })
      ops.channelSessionDataDirs.set(rec.activeSessionId, dataDir)
      if (rec.legacyKey) {
        ops.channelSessionByKey.set(rec.legacyKey, {
          sessionId: rec.activeSessionId,
          projectId,
        })
      }

      for (const prevId of rec.previousSessionIds ?? []) {
        if (typeof prevId !== 'string' || !prevId) continue
        ops.ensureSession({
          id: prevId,
          projectId,
          kind: sessionKind,
          archived: true,
          state: 'stopped',
          createdAt: rec.createdAt ?? ops.now,
          updatedAt: rec.updatedAt ?? ops.now,
        })
        ops.channelSessionDataDirs.set(prevId, dataDir)
      }

      for (const rawPending of rec.pendingMessageIds ?? []) {
        const pendingId =
          typeof rawPending === 'string'
            ? rawPending
            : isPlainObject(rawPending) && typeof rawPending.id === 'string'
              ? rawPending.id
              : undefined
        if (!pendingId) continue
        const passive =
          isPlainObject(rawPending) && rawPending.passive === true ? 1 : 0
        const res = ops.db.run(
          `INSERT OR IGNORE INTO inbox_events (
            id, session_id, project_id, source, dedupe_key, wake, passive, status, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?)`,
          randomUUID(),
          rec.activeSessionId,
          projectId,
          rec.channel,
          `${rec.channel}:${rec.chatId}:${pendingId}`,
          passive,
          JSON.stringify({
            type: 'legacy_pending_message',
            messageId: pendingId,
            channelKey: rec.key,
          }),
          rec.updatedAt ?? ops.now,
        )
        if (res.changes > 0) ops.summary.inboxEvents += 1
      }
    }

    if (isPlainObject(parsed.notes)) {
      for (const [groupKey, rawNotes] of Object.entries(parsed.notes)) {
        if (!Array.isArray(rawNotes)) continue
        const target = ops.channelSessionByKey.get(groupKey)
        let noteProjectId = target?.projectId ?? null
        if (!noteProjectId) {
          const dash = groupKey.indexOf('-')
          if (dash > 0) {
            const chatKey = `${groupKey.slice(0, dash)}\0${groupKey.slice(dash + 1)}`
            noteProjectId = ops.projectByChat.get(chatKey) ?? null
          }
        }
        for (let idx = 0; idx < rawNotes.length; idx++) {
          const note = rawNotes[idx]
          if (typeof note !== 'string') continue
          const dedupeKey = `legacy-note:${groupKey}:${idx}`
          const res = ops.db.run(
            `INSERT OR IGNORE INTO inbox_events (
              id, session_id, project_id, source, dedupe_key, wake, passive, status, payload_json, created_at
            ) VALUES (?, ?, ?, 'handoff', ?, 0, 0, 'pending', ?, ?)`,
            randomUUID(),
            target?.sessionId ?? null,
            noteProjectId,
            dedupeKey,
            JSON.stringify({ type: 'handoff_note', groupKey, text: note }),
            ops.now,
          )
          if (res.changes > 0) ops.summary.inboxEvents += 1
        }
      }
    }
  }
}

export function migrateRoutinesAndSubscriptions(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  for (const dataDir of dataDirs) {
    const routinesFile = join(dataDir, 'channels', 'routines.json')
    if (existsSync(routinesFile)) {
      const parsed = readJsonStrict(routinesFile)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.routines)) {
        throw new Error(`Invalid channel routines ${routinesFile}`)
      }
      for (const r of parsed.routines) {
        if (
          !isPlainObject(r) ||
          typeof r.id !== 'string' ||
          typeof r.channel !== 'string' ||
          typeof r.chatId !== 'string' ||
          typeof r.message !== 'string' ||
          !isPlainObject(r.schedule)
        ) {
          continue
        }
        const targetKey =
          typeof r.targetKey === 'string'
            ? r.targetKey
            : legacyChannelSessionId(r.channel, r.chatId)
        const resolved =
          ops.channelSessionByKey.get(targetKey) ??
          ops.channelSessionByKey.get(
            legacyChannelSessionId(r.channel, r.chatId),
          )
        const projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${r.channel}\0${r.chatId}`) ??
          (ops.localProjectIds.has(r.chatId) ? r.chatId : null)
        const creator = isPlainObject(r.creator) ? r.creator : undefined
        const createdAt =
          typeof r.createdAt === 'string' ? r.createdAt : ops.now
        const timezone =
          ops.channelTimezones.get(r.channel) ?? routineTimezone()
        const floorMs = Math.max(
          Date.parse(ops.now),
          typeof r.lastFiredAt === 'string' ? Date.parse(r.lastFiredAt) : 0,
          typeof r.scheduleUpdatedAt === 'string'
            ? Date.parse(r.scheduleUpdatedAt)
            : 0,
        )
        const nextMs = nextOccurrence(
          r.schedule as unknown as RoutineSchedule,
          Number.isFinite(floorMs) ? floorMs : Date.now(),
          timezone,
        )
        const nextFireAt =
          nextMs !== undefined ? new Date(nextMs).toISOString() : null
        const enabled = nextFireAt !== null ? 1 : 0

        const res = dbInsertTimer(ops, {
          id: r.id,
          projectId,
          sessionId: resolved?.sessionId ?? null,
          channel: r.channel,
          creatorId: typeof creator?.id === 'string' ? creator.id : null,
          creatorName: typeof creator?.name === 'string' ? creator.name : null,
          message: r.message,
          scheduleJson: JSON.stringify(r.schedule),
          timezone,
          enabled,
          nextFireAt,
          lastFiredAt: typeof r.lastFiredAt === 'string' ? r.lastFiredAt : null,
          scheduleUpdatedAt:
            typeof r.scheduleUpdatedAt === 'string'
              ? r.scheduleUpdatedAt
              : null,
          createdAt,
        })
        if (res > 0) ops.summary.timers += 1
      }
    }

    const subsFile = join(dataDir, 'channels', 'subscriptions.json')
    if (existsSync(subsFile)) {
      const parsed = readJsonStrict(subsFile)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.subscriptions)) {
        throw new Error(`Invalid channel subscriptions ${subsFile}`)
      }
      for (const sub of parsed.subscriptions) {
        if (
          !isPlainObject(sub) ||
          typeof sub.id !== 'string' ||
          typeof sub.source !== 'string' ||
          typeof sub.key !== 'string' ||
          typeof sub.channel !== 'string' ||
          typeof sub.chatId !== 'string'
        ) {
          continue
        }
        const targetKey =
          typeof sub.targetKey === 'string'
            ? sub.targetKey
            : legacyChannelSessionId(sub.channel, sub.chatId)
        const resolved =
          ops.channelSessionByKey.get(targetKey) ??
          ops.channelSessionByKey.get(
            legacyChannelSessionId(sub.channel, sub.chatId),
          )
        let projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${sub.channel}\0${sub.chatId}`) ??
          (ops.localProjectIds.has(sub.chatId) ? sub.chatId : null)
        let sessionId = resolved?.sessionId
        if (!sessionId) {
          sessionId = targetKey
          if (!projectId && sub.channel === 'lark') {
            projectId = `lark-group:${sub.chatId}`
            ops.ensureProject({ id: projectId, name: sub.chatId })
          }
          ops.ensureSession({
            id: sessionId,
            projectId,
            kind: projectId ? 'hub' : 'chat',
            state: 'idle',
          })
        }
        const creator = isPlainObject(sub.creator) ? sub.creator : undefined
        const res = ops.db.run(
          `INSERT OR IGNORE INTO subscriptions (
            id, source, event_key, project_id, session_id, creator_id, creator_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sub.id,
          sub.source,
          sub.key,
          projectId,
          sessionId,
          typeof creator?.id === 'string' ? creator.id : null,
          typeof creator?.name === 'string' ? creator.name : null,
          ops.now,
        )
        if (res.changes > 0) ops.summary.subscriptions += 1
      }
    }
  }
}

function dbInsertTimer(
  ops: MigrationOps,
  row: {
    id: string
    projectId: string | null
    sessionId: string | null
    channel: string
    creatorId: string | null
    creatorName: string | null
    message: string
    scheduleJson: string
    timezone: string
    enabled: number
    nextFireAt: string | null
    lastFiredAt: string | null
    scheduleUpdatedAt: string | null
    createdAt: string
  },
): number {
  return ops.db.run(
    `INSERT OR IGNORE INTO timers (
      id, kind, project_id, session_id, channel, creator_id, creator_name,
      message, schedule_json, timezone, enabled, next_fire_at, last_fired_at,
      schedule_updated_at, created_at, updated_at
    ) VALUES (?, 'routine', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.projectId,
    row.sessionId,
    row.channel,
    row.creatorId,
    row.creatorName,
    row.message,
    row.scheduleJson,
    row.timezone,
    row.enabled,
    row.nextFireAt,
    row.lastFiredAt,
    row.scheduleUpdatedAt,
    row.createdAt,
    ops.now,
  ).changes
}
