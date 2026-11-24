import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { interpolate, isPlainObject } from '../shared/interpolate.ts'
import {
  latestOccurrence,
  nextOccurrence,
  type RoutineSchedule,
  routineTimezone,
} from '../shared/routine-time.ts'
import {
  isSafeSegment,
  isStrictlyInside,
  type LarkChatMigrationConfig,
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
  requester?: { id?: string; name?: string }
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

function interpolateIfEnv(
  value: string,
  env: Record<string, string | undefined> | undefined,
): string {
  return env ? interpolate(value, env) : value
}

function resolveConfiguredToken(
  rawValue: string,
  label: string,
  ops: MigrationOps,
): string | undefined {
  if (!rawValue.includes('$')) return rawValue.trim() || undefined
  if (!ops.env) {
    ops.incompleteRef.incomplete = true
    ops.warnings.push(
      `Skipped env-expression ${label} entry "${rawValue}" during offline database migration`,
    )
    return undefined
  }
  const expanded = interpolate(rawValue, ops.env).trim()
  if (!expanded) {
    ops.warnings.push(
      `Skipped empty expanded ${label} entry "${rawValue}" during database migration`,
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

function parseLarkOwners(
  larkSection: Record<string, unknown> | undefined,
  ops: MigrationOps,
): void {
  const rawOwners = larkSection?.owners ?? ops.env?.LARK_OWNERS
  if (rawOwners === undefined) return
  if (typeof rawOwners === 'string') {
    const resolved = resolveConfiguredToken(rawOwners, 'lark.owners', ops)
    if (!resolved) return
    for (const part of resolved.split(',')) {
      const id = part.trim()
      if (id) ops.configuredLarkOwners.add(id)
    }
    return
  }
  if (!Array.isArray(rawOwners)) return
  for (const item of rawOwners) {
    if (typeof item !== 'string') continue
    const id = resolveConfiguredToken(item, 'lark.owners', ops)
    if (id) ops.configuredLarkOwners.add(id)
  }
}

function parseLarkChats(
  larkSection: Record<string, unknown> | undefined,
  ops: MigrationOps,
): Record<string, unknown>[] {
  const rawChats = larkSection?.chats
  if (rawChats === undefined) return []

  if (typeof rawChats === 'string') {
    const resolved = resolveConfiguredToken(rawChats, 'lark.chats', ops)
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
      const id = resolveConfiguredToken(item, 'lark.chats', ops)
      if (id) chats.push({ id })
    } else if (isPlainObject(item) && typeof item.id === 'string') {
      const id = resolveConfiguredToken(item.id, 'lark.chats', ops)
      if (id) chats.push({ ...item, id })
    }
  }
  return chats
}

function buildLarkChatConfig(
  chat: Record<string, unknown>,
  env: Record<string, string | undefined> | undefined,
): LarkChatMigrationConfig {
  const extraConfig: Record<string, unknown> = {}
  for (const key of [
    'environment',
    'readUntagged',
    'topicModel',
    'topicThinkingLevel',
  ] as const) {
    const raw = chat[key]
    if (raw !== undefined) {
      extraConfig[key] =
        typeof raw === 'string' ? interpolateIfEnv(raw, env) : raw
    }
  }
  const tools = Array.isArray(chat.tools)
    ? chat.tools.map((item) =>
        typeof item === 'string' ? interpolateIfEnv(item, env) : item,
      )
    : undefined

  return {
    defaultModel:
      typeof chat.model === 'string' ? interpolateIfEnv(chat.model, env) : null,
    defaultThinkingLevel:
      typeof chat.thinkingLevel === 'string'
        ? interpolateIfEnv(chat.thinkingLevel, env)
        : null,
    defaultToolsJson: tools ? JSON.stringify(tools) : null,
    configJson:
      Object.keys(extraConfig).length > 0 ? JSON.stringify(extraConfig) : null,
  }
}

export function loadLarkAndChannelConfig(ops: MigrationOps): void {
  for (const name of ['lark', 'local'] as const) {
    const sec = readChannelSection(ops.agentDir, name)
    if (sec && typeof sec.timezone === 'string' && sec.timezone.trim()) {
      const tz = interpolateIfEnv(sec.timezone, ops.env).trim()
      try {
        ops.channelTimezones.set(name, routineTimezone(tz))
      } catch {
        ops.warnings.push(`Ignored invalid ${name}.timezone "${sec.timezone}"`)
      }
    }
  }

  const larkSection = readChannelSection(ops.agentDir, 'lark')
  parseLarkOwners(larkSection, ops)
  for (const chat of parseLarkChats(larkSection, ops)) {
    const chatId = String(chat.id)
    ops.configuredLarkChats.add(chatId)
    ops.larkChatConfigById.set(chatId, buildLarkChatConfig(chat, ops.env))
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
      const activeSessionId = ops.resolveSessionId(dataDir, rec.activeSessionId)
      const isLocalChannel = rec.channel === 'local'
      const isGroup = rec.chatKind === 'group'
      const isTopic = Boolean(rec.rootId && rec.threadId)
      const larkConfig =
        rec.channel === 'lark'
          ? ops.larkChatConfigById.get(rec.chatId)
          : undefined
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
          hubSessionId: !isTopic ? activeSessionId : null,
          defaultModel: larkConfig?.defaultModel ?? null,
          defaultThinkingLevel: larkConfig?.defaultThinkingLevel ?? null,
          defaultToolsJson: larkConfig?.defaultToolsJson ?? null,
          configJson: larkConfig?.configJson ?? null,
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
        id: activeSessionId,
        projectId,
        kind: sessionKind,
        name: typeof rec.task === 'string' && rec.task ? rec.task : null,
        state: mapChannelState(rec.state),
        waitingReason: rec.waitingReason ?? null,
        createdAt: rec.createdAt ?? ops.now,
        updatedAt: rec.updatedAt ?? rec.createdAt ?? ops.now,
      })

      if (!isLocalChannel) {
        if (rec.channel === 'lark') ops.boundLarkChats.add(rec.chatId)
        const groupAllowed =
          rec.channel !== 'lark' || ops.configuredLarkChats.has(rec.chatId)
        if (isGroup) {
          ops.ensureChannelBinding({
            channel: rec.channel,
            externalId: rec.chatId,
            kind: 'group',
            projectId,
            sessionId: !isTopic ? activeSessionId : null,
            enabled: groupAllowed,
            configJson: larkConfig?.configJson ?? null,
          })
        }
        if (isTopic && rec.rootId) {
          ops.ensureChannelBinding({
            channel: rec.channel,
            externalId: `${rec.chatId}:${rec.rootId}`,
            threadId: rec.threadId ?? null,
            kind: 'group',
            projectId,
            sessionId: activeSessionId,
            enabled: groupAllowed,
            configJson: larkConfig?.configJson ?? null,
          })
        } else if (!isGroup) {
          const requesterId =
            isPlainObject(rec.requester) && typeof rec.requester.id === 'string'
              ? rec.requester.id
              : undefined
          const dmEnabled =
            rec.channel !== 'lark' ||
            ops.configuredLarkChats.has(rec.chatId) ||
            (requesterId !== undefined &&
              ops.configuredLarkOwners.has(requesterId))
          ops.ensureChannelBinding({
            channel: rec.channel,
            externalId: rec.chatId,
            kind: 'direct',
            projectId: null,
            sessionId: activeSessionId,
            enabled: dmEnabled,
            configJson: larkConfig?.configJson ?? null,
          })
        }
      }

      const keyEntry = {
        sessionId: activeSessionId,
        projectId,
        channel: rec.channel,
        chatId: rec.chatId,
      }
      ops.channelSessionByKey.set(rec.key, keyEntry)
      ops.channelSessionDataDirs.set(activeSessionId, dataDir)
      if (rec.legacyKey) {
        ops.channelSessionByKey.set(rec.legacyKey, keyEntry)
      }

      for (const rawPrevId of rec.previousSessionIds ?? []) {
        if (typeof rawPrevId !== 'string' || !rawPrevId) continue
        const prevId = ops.resolveSessionId(dataDir, rawPrevId)
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

      const pendingEntries: { id: string; passive: boolean }[] = []
      for (const rawPending of rec.pendingMessageIds ?? []) {
        const pendingId =
          typeof rawPending === 'string'
            ? rawPending
            : isPlainObject(rawPending) && typeof rawPending.id === 'string'
              ? rawPending.id
              : undefined
        if (!pendingId) continue
        pendingEntries.push({
          id: pendingId,
          passive: isPlainObject(rawPending) && rawPending.passive === true,
        })
      }
      if (pendingEntries.length > 0) {
        ops.deferredPendingMessages.push({
          sessionId: activeSessionId,
          projectId,
          channel: rec.channel,
          chatId: rec.chatId,
          channelKey: rec.key,
          updatedAt: rec.updatedAt ?? ops.now,
          entries: pendingEntries,
        })
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

export function migrateRemainingLarkChats(ops: MigrationOps): void {
  for (const [chatId, cfg] of ops.larkChatConfigById) {
    if (ops.boundLarkChats.has(chatId)) continue
    const projectId = `lark-group:${chatId}`
    ops.projectByChat.set(`lark\0${chatId}`, projectId)
    ops.ensureProject({
      id: projectId,
      name: chatId,
      defaultModel: cfg.defaultModel,
      defaultThinkingLevel: cfg.defaultThinkingLevel,
      defaultToolsJson: cfg.defaultToolsJson,
      configJson: cfg.configJson,
    })
    ops.ensureChannelBinding({
      channel: 'lark',
      externalId: chatId,
      kind: 'group',
      projectId,
      sessionId: null,
      enabled: true,
      configJson: cfg.configJson,
    })
  }
}

export function migratePendingInboxMessages(ops: MigrationOps): void {
  for (const item of ops.deferredPendingMessages) {
    const consumed = ops.consumedInputMessageIdsBySession.get(item.sessionId)
    for (const entry of item.entries) {
      const nonWaking = entry.passive || consumed?.has(entry.id) === true
      const wake = nonWaking ? 0 : 1
      const passive = entry.passive ? 1 : 0
      const status = nonWaking ? 'dropped' : 'pending'
      const res = ops.db.run(
        `INSERT OR IGNORE INTO inbox_events (
          id, session_id, project_id, source, dedupe_key, wake, passive, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        item.sessionId,
        item.projectId,
        item.channel,
        `${item.channel}:${item.chatId}:${entry.id}`,
        wake,
        passive,
        status,
        JSON.stringify({
          type: 'legacy_pending_message',
          messageId: entry.id,
          channelKey: item.channelKey,
        }),
        item.updatedAt,
      )
      if (res.changes > 0) ops.summary.inboxEvents += 1
    }
  }
}

function resolveChannelTarget(
  ops: MigrationOps,
  channel: string,
  chatId: string,
  explicitTargetKey: unknown,
):
  | {
      resolved: { sessionId: string; projectId: string | null }
      missingExplicit: false
    }
  | { resolved: undefined; missingExplicit: boolean } {
  if (typeof explicitTargetKey === 'string') {
    const hit = ops.channelSessionByKey.get(explicitTargetKey)
    if (hit && hit.channel === channel && hit.chatId === chatId) {
      return {
        resolved: { sessionId: hit.sessionId, projectId: hit.projectId },
        missingExplicit: false,
      }
    }
    return { resolved: undefined, missingExplicit: true }
  }
  const hit = ops.channelSessionByKey.get(
    legacyChannelSessionId(channel, chatId),
  )
  if (hit && hit.channel === channel && hit.chatId === chatId) {
    return {
      resolved: { sessionId: hit.sessionId, projectId: hit.projectId },
      missingExplicit: false,
    }
  }
  return { resolved: undefined, missingExplicit: false }
}

export function migrateRoutinesAndSubscriptions(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  const nowParsed = Date.parse(ops.now)
  const nowMs = Number.isFinite(nowParsed) ? nowParsed : Date.now()

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
        const { resolved, missingExplicit } = resolveChannelTarget(
          ops,
          r.channel,
          r.chatId,
          r.targetKey,
        )
        if (missingExplicit) {
          ops.warnings.push(
            `Imported routine "${r.id}" disabled because target "${String(r.targetKey)}" is unavailable`,
          )
        }
        const projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${r.channel}\0${r.chatId}`) ??
          (ops.localProjectIds.has(r.chatId) ? r.chatId : null)
        const creator = isPlainObject(r.creator) ? r.creator : undefined
        const createdAt =
          typeof r.createdAt === 'string' ? r.createdAt : ops.now
        const timezone =
          ops.channelTimezones.get(r.channel) ?? routineTimezone()
        const createdMs = Date.parse(createdAt)
        const lastFiredMs =
          typeof r.lastFiredAt === 'string'
            ? Date.parse(r.lastFiredAt)
            : Number.NaN
        const editedMs =
          typeof r.scheduleUpdatedAt === 'string'
            ? Date.parse(r.scheduleUpdatedAt)
            : Number.NaN
        const baseCreatedMs = Number.isFinite(createdMs) ? createdMs : 0
        const floorMs = Math.max(
          Number.isFinite(lastFiredMs) ? lastFiredMs : baseCreatedMs,
          Number.isFinite(editedMs) ? editedMs : baseCreatedMs,
        )
        const schedule = r.schedule as unknown as RoutineSchedule
        const catchUpMs = latestOccurrence(schedule, floorMs, nowMs, timezone)
        const nextMs =
          catchUpMs !== undefined
            ? catchUpMs
            : nextOccurrence(schedule, Math.max(nowMs, floorMs), timezone)
        const nextFireAt =
          nextMs !== undefined ? new Date(nextMs).toISOString() : null
        const enabled = !missingExplicit && nextFireAt !== null ? 1 : 0

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
        const { resolved, missingExplicit } = resolveChannelTarget(
          ops,
          sub.channel,
          sub.chatId,
          sub.targetKey,
        )
        if (missingExplicit) {
          ops.warnings.push(
            `Skipped subscription "${sub.id}" because target "${String(sub.targetKey)}" is unavailable`,
          )
          continue
        }
        let projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${sub.channel}\0${sub.chatId}`) ??
          (ops.localProjectIds.has(sub.chatId) ? sub.chatId : null)
        let sessionId = resolved?.sessionId
        if (!sessionId) {
          sessionId = legacyChannelSessionId(sub.channel, sub.chatId)
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
