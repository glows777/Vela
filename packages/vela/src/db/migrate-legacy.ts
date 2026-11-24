import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  migrateLegacyConfigFiles,
  removeConfigIfHashMatches,
} from '../config/index.ts'
import { isPlainObject } from '../shared/interpolate.ts'
import {
  loadLarkAndChannelConfig,
  migrateChannelDirectory,
  migratePendingInboxMessages,
  migrateRemainingLarkChats,
  migrateRoutinesAndSubscriptions,
} from './migrate-legacy-channels.ts'
import { parseLegacyTranscript } from './migrate-legacy-jsonl.ts'
import {
  type DeferredPendingMessages,
  type LarkChatMigrationConfig,
  type LegacyLocalMessage,
  type LegacyMigrationSummary,
  type MigrationOps,
  migrateLocalProjects,
  migrateTrustFile,
  readJsonStrict,
} from './migrate-legacy-sources.ts'
import type { VelaDatabase } from './sqlite.ts'

export type { LegacyMigrationSummary }

const LEGACY_MIGRATION_KEY = 'legacy_migration_v08'
const LEGACY_MIGRATION_STATE_KEY = 'legacy_migration_v08_state'

export interface LegacyMigrationResult {
  skipped: boolean
  migratedAt: string
  summary: LegacyMigrationSummary
  warnings: string[]
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}

function shortDirHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8)
}

function discoverLegacyDataDirs(
  agentDir: string,
  options: { cwd?: string; dataDir?: string },
  warnings: string[],
  incompleteRef: { incomplete: boolean },
): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  const add = (dir: string) => {
    const resolved = resolve(dir)
    if (seen.has(resolved)) return
    seen.add(resolved)
    dirs.push(resolved)
  }

  add(agentDir)
  if (options.dataDir) add(options.dataDir)

  const projectsRoot = join(agentDir, 'projects')
  if (existsSync(projectsRoot)) {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(projectsRoot, entry.name))
    }
  }

  const configFile = join(agentDir, 'config.json')
  const settingsFile = join(agentDir, 'settings.json')
  const primaryConfigFile = existsSync(configFile)
    ? configFile
    : existsSync(settingsFile)
      ? settingsFile
      : undefined
  if (primaryConfigFile) {
    const parsed = readJsonStrict(primaryConfigFile)
    if (isPlainObject(parsed) && typeof parsed.dataDir === 'string') {
      const expanded = expandHomePath(parsed.dataDir)
      if (isAbsolute(expanded)) {
        add(expanded)
      } else if (options.cwd) {
        add(resolve(options.cwd, expanded))
      } else {
        incompleteRef.incomplete = true
        warnings.push(
          `Skipped relative dataDir "${parsed.dataDir}" in ${primaryConfigFile} without cwd`,
        )
      }
    }
  }

  return dirs
}

function collectTranscriptFiles(
  sessionsDir: string,
): { id: string; path: string }[] {
  if (!existsSync(sessionsDir)) return []
  const entries = readdirSync(sessionsDir, { withFileTypes: true })
  const byId = new Map<string, string>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(sessionsDir, entry.name, 'transcript.jsonl')
    if (existsSync(path) && statSync(path).isFile()) {
      byId.set(entry.name, path)
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const id = entry.name.slice(0, -'.jsonl'.length)
    if (!byId.has(id)) {
      byId.set(id, join(sessionsDir, entry.name))
    }
  }
  return [...byId.entries()].map(([id, path]) => ({ id, path }))
}

function buildSessionIdResolver(
  dataDirs: readonly string[],
  warnings: string[],
  priorAllocations: Record<string, string>,
  existingDbSessionIds: ReadonlySet<string>,
): {
  resolveSessionId: (dataDir: string, legacySessionId: string) => string
  allocations: Record<string, string>
} {
  const dirsByRawId = new Map<string, Set<string>>()
  const register = (dataDir: string, sessionId: string) => {
    if (!sessionId) return
    let dirs = dirsByRawId.get(sessionId)
    if (!dirs) {
      dirs = new Set<string>()
      dirsByRawId.set(sessionId, dirs)
    }
    dirs.add(dataDir)
  }

  for (const dataDir of dataDirs) {
    for (const item of collectTranscriptFiles(join(dataDir, 'sessions'))) {
      register(dataDir, item.id)
    }
    const indexFile = join(dataDir, 'channels', 'index.json')
    if (existsSync(indexFile)) {
      const parsed = readJsonStrict(indexFile)
      if (isPlainObject(parsed) && Array.isArray(parsed.records)) {
        for (const rec of parsed.records) {
          if (!isPlainObject(rec)) continue
          if (typeof rec.activeSessionId === 'string') {
            register(dataDir, rec.activeSessionId)
          }
          if (Array.isArray(rec.previousSessionIds)) {
            for (const prev of rec.previousSessionIds) {
              if (typeof prev === 'string') register(dataDir, prev)
            }
          }
        }
      }
    }
    const projectsFile = join(dataDir, 'local', 'projects.json')
    if (existsSync(projectsFile)) {
      const parsed = readJsonStrict(projectsFile)
      if (isPlainObject(parsed) && Array.isArray(parsed.projects)) {
        for (const proj of parsed.projects) {
          if (!isPlainObject(proj) || typeof proj.id !== 'string') continue
          const logFile = join(dataDir, 'local', `${proj.id}.json`)
          if (!existsSync(logFile)) continue
          const rawMessages = readJsonStrict(logFile)
          if (!Array.isArray(rawMessages)) continue
          for (const msg of rawMessages) {
            if (isPlainObject(msg) && typeof msg.sessionId === 'string') {
              register(dataDir, msg.sessionId)
            }
          }
        }
      }
    }
  }

  const allocatedByPair = new Map<string, string>(
    Object.entries(priorAllocations),
  )
  const usedIds = new Set<string>([
    ...existingDbSessionIds,
    ...allocatedByPair.values(),
  ])
  const reservedNames = new Set<string>([...usedIds, ...dirsByRawId.keys()])

  for (const [rawId, dirs] of dirsByRawId) {
    const sortedDirs = [...dirs].sort()
    for (const dataDir of sortedDirs) {
      const pairKey = `${dataDir}\0${rawId}`
      const prior = allocatedByPair.get(pairKey)
      if (prior) {
        usedIds.add(prior)
        reservedNames.add(prior)
        continue
      }
      if (!usedIds.has(rawId)) {
        allocatedByPair.set(pairKey, rawId)
        usedIds.add(rawId)
        reservedNames.add(rawId)
        continue
      }
      let candidate = `${rawId}--${shortDirHash(dataDir)}`
      let suffix = 2
      while (usedIds.has(candidate) || reservedNames.has(candidate)) {
        candidate = `${rawId}--${shortDirHash(dataDir)}-${suffix++}`
      }
      usedIds.add(candidate)
      reservedNames.add(candidate)
      allocatedByPair.set(pairKey, candidate)
      warnings.push(
        `Disambiguated colliding session "${rawId}" in ${dataDir} as "${candidate}"`,
      )
    }
  }

  return {
    resolveSessionId: (dataDir: string, legacySessionId: string): string => {
      const pairKey = `${dataDir}\0${legacySessionId}`
      return allocatedByPair.get(pairKey) ?? legacySessionId
    },
    allocations: Object.fromEntries(allocatedByPair),
  }
}

/**
 * Performs an idempotent, single-transaction, read-only import of legacy `~/.vela/`
 * config, trust decisions, projects, channel bindings, routines, subscriptions,
 * local attachments, and JSONL transcripts into `vela.db`.
 * Legacy source files are never modified or deleted.
 */
export function migrateLegacyVelaDir(options: {
  agentDir: string
  db: VelaDatabase
  includeConfig?: boolean
  cwd?: string
  dataDir?: string
  env?: Record<string, string | undefined>
}): LegacyMigrationResult {
  const { agentDir, db } = options
  const now = new Date().toISOString()
  const createdBlobPaths: string[] = []
  let createdConfigSha256: string | undefined

  try {
    return db.transaction(() => {
      const existing = db.get<{ value_json: string }>(
        'SELECT value_json FROM kv_meta WHERE key = ?',
        LEGACY_MIGRATION_KEY,
      )
      if (existing) {
        const parsed = JSON.parse(existing.value_json) as {
          migratedAt?: string
          summary?: LegacyMigrationSummary
          warnings?: string[]
        }
        return {
          skipped: true,
          migratedAt: parsed.migratedAt ?? now,
          summary: parsed.summary ?? {
            configMigrated: false,
            trustedPaths: 0,
            projects: 0,
            sessions: 0,
            channelBindings: 0,
            messages: 0,
            inboxEvents: 0,
            timers: 0,
            subscriptions: 0,
            blobs: 0,
          },
          warnings: parsed.warnings ?? [],
        }
      }

      const warnings: string[] = []
      const incompleteRef = { incomplete: false }
      let configMigrated = false
      if (options.includeConfig !== false) {
        const cfg = migrateLegacyConfigFiles(agentDir)
        configMigrated = cfg.createdConfig
        if (cfg.createdConfig) createdConfigSha256 = cfg.createdSha256
        warnings.push(...cfg.warnings)
      }

      const summary: LegacyMigrationSummary = {
        configMigrated,
        trustedPaths: 0,
        projects: 0,
        sessions: 0,
        channelBindings: 0,
        messages: 0,
        inboxEvents: 0,
        timers: 0,
        subscriptions: 0,
        blobs: 0,
      }

      const priorStateRow = db.get<{ value_json: string }>(
        'SELECT value_json FROM kv_meta WHERE key = ?',
        LEGACY_MIGRATION_STATE_KEY,
      )
      let priorAllocations: Record<string, string> = {}
      if (priorStateRow) {
        try {
          const parsedState = JSON.parse(priorStateRow.value_json) as {
            sessionAllocations?: unknown
          }
          if (isPlainObject(parsedState.sessionAllocations)) {
            priorAllocations = Object.fromEntries(
              Object.entries(parsedState.sessionAllocations).filter(
                (pair): pair is [string, string] => typeof pair[1] === 'string',
              ),
            )
          }
        } catch {}
      }
      const existingDbSessionIds = new Set(
        db.all<{ id: string }>('SELECT id FROM sessions').map((r) => r.id),
      )

      const dataDirs = discoverLegacyDataDirs(
        agentDir,
        options,
        warnings,
        incompleteRef,
      )
      const { resolveSessionId, allocations: sessionAllocations } =
        buildSessionIdResolver(
          dataDirs,
          warnings,
          priorAllocations,
          existingDbSessionIds,
        )
      const projectByCwd = new Map<string, string>()
      const projectByChat = new Map<string, string>()
      const localProjectIds = new Set<string>()
      const configuredLarkChats = new Set<string>()
      const configuredLarkOwners = new Set<string>()
      const larkChatConfigById = new Map<string, LarkChatMigrationConfig>()
      const boundLarkChats = new Set<string>()
      const channelTimezones = new Map<string, string>()
      const channelSessionByKey = new Map<
        string,
        {
          sessionId: string
          projectId: string | null
          channel: string
          chatId: string
        }
      >()
      const channelSessionDataDirs = new Map<string, string>()
      const consumedInputMessageIdsBySession = new Map<string, Set<string>>()
      const deferredPendingMessages: DeferredPendingMessages[] = []
      const fallbackLocalMessages = new Map<
        string,
        { projectId: string; messages: LegacyLocalMessage[] }
      >()
      const seenSessionIds = new Set<string>()

      const ensureProject: MigrationOps['ensureProject'] = (row) => {
        const present = db.get<{ id: string }>(
          'SELECT id FROM projects WHERE id = ?',
          row.id,
        )
        if (!present) {
          db.run(
            `INSERT INTO projects (
              id, name, cwd, data_dir, hub_session_id, default_driver,
              default_model, default_thinking_level, default_tools_json, config_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'vela', ?, ?, ?, ?, ?, ?)`,
            row.id,
            row.name,
            row.cwd ?? null,
            row.dataDir ?? null,
            row.hubSessionId ?? null,
            row.defaultModel ?? null,
            row.defaultThinkingLevel ?? null,
            row.defaultToolsJson ?? null,
            row.configJson ?? null,
            now,
            now,
          )
          summary.projects += 1
        } else {
          db.run(
            `UPDATE projects SET
              data_dir = COALESCE(data_dir, ?),
              hub_session_id = COALESCE(hub_session_id, ?),
              default_model = COALESCE(default_model, ?),
              default_thinking_level = COALESCE(default_thinking_level, ?),
              default_tools_json = COALESCE(default_tools_json, ?),
              config_json = COALESCE(config_json, ?),
              updated_at = ?
            WHERE id = ?`,
            row.dataDir ?? null,
            row.hubSessionId ?? null,
            row.defaultModel ?? null,
            row.defaultThinkingLevel ?? null,
            row.defaultToolsJson ?? null,
            row.configJson ?? null,
            now,
            row.id,
          )
        }
        if (row.cwd && !projectByCwd.has(row.cwd)) {
          projectByCwd.set(row.cwd, row.id)
        }
      }

      const ensureSession: MigrationOps['ensureSession'] = (row) => {
        const created = row.createdAt ?? now
        const updated = row.updatedAt ?? created
        if (!seenSessionIds.has(row.id)) {
          const existingRow = db.get<{ id: string }>(
            'SELECT id FROM sessions WHERE id = ?',
            row.id,
          )
          if (!existingRow) {
            db.run(
              `INSERT INTO sessions (
                id, project_id, kind, driver, name, archived, model, thinking_level,
                location_json, leaf_message_id, discovered_tools_json, parent_session_id,
                state, waiting_reason, created_at, updated_at
              ) VALUES (?, ?, ?, 'vela', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              row.id,
              row.projectId,
              row.kind,
              row.name ?? null,
              row.archived ? 1 : 0,
              row.model ?? null,
              row.thinkingLevel ?? null,
              row.locationJson ?? null,
              row.leafMessageId ?? null,
              row.discoveredToolsJson ?? null,
              row.parentSessionId ?? null,
              row.state ?? 'idle',
              row.waitingReason ?? null,
              created,
              updated,
            )
            summary.sessions += 1
          }
          seenSessionIds.add(row.id)
          if (!existingRow) return
        }
        db.run(
          `UPDATE sessions SET
            project_id = COALESCE(project_id, ?),
            name = COALESCE(?, name),
            archived = CASE WHEN ? IS NOT NULL THEN ? ELSE archived END,
            model = COALESCE(?, model),
            thinking_level = COALESCE(?, thinking_level),
            location_json = COALESCE(?, location_json),
            leaf_message_id = COALESCE(?, leaf_message_id),
            discovered_tools_json = COALESCE(?, discovered_tools_json),
            parent_session_id = COALESCE(?, parent_session_id),
            updated_at = MAX(updated_at, ?)
          WHERE id = ?`,
          row.projectId,
          row.name ?? null,
          row.archived === undefined ? null : row.archived ? 1 : 0,
          row.archived === undefined ? null : row.archived ? 1 : 0,
          row.model ?? null,
          row.thinkingLevel ?? null,
          row.locationJson ?? null,
          row.leafMessageId ?? null,
          row.discoveredToolsJson ?? null,
          row.parentSessionId ?? null,
          updated,
          row.id,
        )
      }

      const ensureChannelBinding: MigrationOps['ensureChannelBinding'] = (
        row,
      ) => {
        const enabledVal = row.enabled === false ? 0 : 1
        const existingBinding = db.get<{ id: string }>(
          'SELECT id FROM channel_bindings WHERE channel = ? AND external_id = ?',
          row.channel,
          row.externalId,
        )
        if (!existingBinding) {
          db.run(
            `INSERT INTO channel_bindings (
              id, channel, external_id, thread_id, kind, project_id, session_id,
              enabled, config_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            randomUUID(),
            row.channel,
            row.externalId,
            row.threadId ?? null,
            row.kind,
            row.projectId,
            row.sessionId,
            enabledVal,
            row.configJson ?? null,
            now,
            now,
          )
          summary.channelBindings += 1
          return
        }
        db.run(
          `UPDATE channel_bindings SET
            thread_id = COALESCE(thread_id, ?),
            project_id = COALESCE(project_id, ?),
            session_id = COALESCE(session_id, ?),
            enabled = CASE WHEN ? = 1 THEN 1 ELSE enabled END,
            config_json = COALESCE(config_json, ?),
            updated_at = ?
          WHERE id = ?`,
          row.threadId ?? null,
          row.projectId,
          row.sessionId,
          enabledVal,
          row.configJson ?? null,
          now,
          existingBinding.id,
        )
      }

      const ops: MigrationOps = {
        agentDir,
        db,
        env: options.env,
        now,
        summary,
        warnings,
        incompleteRef,
        createdBlobPaths,
        localProjectIds,
        configuredLarkChats,
        configuredLarkOwners,
        larkChatConfigById,
        boundLarkChats,
        channelTimezones,
        projectByChat,
        channelSessionByKey,
        channelSessionDataDirs,
        consumedInputMessageIdsBySession,
        deferredPendingMessages,
        fallbackLocalMessages,
        resolveSessionId,
        ensureProject,
        ensureSession,
        ensureChannelBinding,
      }

      migrateTrustFile(ops)
      migrateLocalProjects(ops, dataDirs)
      loadLarkAndChannelConfig(ops)
      migrateChannelDirectory(ops, dataDirs)
      migrateRemainingLarkChats(ops)
      migrateRoutinesAndSubscriptions(ops, dataDirs)

      const migratedTranscriptSessions = new Set<string>()
      for (const dataDir of dataDirs) {
        for (const item of collectTranscriptFiles(join(dataDir, 'sessions'))) {
          const targetSessionId = resolveSessionId(dataDir, item.id)

          const parsed = parseLegacyTranscript(
            readFileSync(item.path, 'utf8'),
            targetSessionId,
            item.path,
          )
          warnings.push(...parsed.warnings)
          if (parsed.consumedInputMessageIds.length > 0) {
            let consumed = consumedInputMessageIdsBySession.get(targetSessionId)
            if (!consumed) {
              consumed = new Set<string>()
              consumedInputMessageIdsBySession.set(targetSessionId, consumed)
            }
            for (const msgId of parsed.consumedInputMessageIds) {
              consumed.add(msgId)
            }
          }

          if (parsed.channel && !channelSessionDataDirs.has(targetSessionId)) {
            warnings.push(
              `Session "${targetSessionId}" had legacy channel "${parsed.channel}" without a directory binding`,
            )
          }

          const resolvedParentSessionId = parsed.parentSession
            ? resolveSessionId(dataDir, parsed.parentSession)
            : null
          const inferredProjectId =
            (parsed.cwd ? projectByCwd.get(parsed.cwd) : undefined) ??
            fallbackLocalMessages.get(targetSessionId)?.projectId ??
            null
          const locationJson =
            parsed.location !== undefined
              ? JSON.stringify(parsed.location)
              : parsed.cwd
                ? JSON.stringify({ environment: 'local', cwd: parsed.cwd })
                : null

          ensureSession({
            id: targetSessionId,
            projectId: inferredProjectId,
            kind: inferredProjectId ? 'work' : 'chat',
            name: parsed.name ?? null,
            archived: parsed.archived,
            model: parsed.model ?? null,
            thinkingLevel: parsed.thinkingLevel ?? null,
            locationJson,
            leafMessageId: parsed.leafMessageId,
            discoveredToolsJson: parsed.discoveredTools
              ? JSON.stringify(parsed.discoveredTools)
              : null,
            parentSessionId: resolvedParentSessionId,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
          })

          for (const msg of parsed.messages) {
            const res = db.run(
              `INSERT OR IGNORE INTO vela_messages (
                session_id, id, parent_id, seq, kind, role, content_json,
                include_in_context, stop_reason, produced_by, first_kept_id,
                tokens_before, label, details_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              targetSessionId,
              msg.id,
              msg.parentId,
              msg.seq,
              msg.kind,
              msg.role,
              msg.contentJson,
              msg.includeInContext ? 1 : 0,
              msg.stopReason,
              msg.producedBy,
              msg.firstKeptId,
              msg.tokensBefore,
              msg.label,
              msg.detailsJson,
              msg.createdAt,
            )
            if (res.changes > 0) summary.messages += 1
          }
          migratedTranscriptSessions.add(targetSessionId)
        }
      }

      migratePendingInboxMessages(ops)

      for (const [sessionId, bucket] of fallbackLocalMessages) {
        if (migratedTranscriptSessions.has(sessionId)) continue
        if (bucket.messages.length === 0) continue

        let parentId: string | null = null
        let seq = 0
        const firstCreated = bucket.messages[0]?.createdAt ?? now
        const lastCreated = bucket.messages.at(-1)?.createdAt ?? firstCreated
        const lastId = bucket.messages.at(-1)?.id ?? null

        ensureSession({
          id: sessionId,
          projectId: bucket.projectId,
          kind: 'work',
          leafMessageId: lastId,
          createdAt: firstCreated,
          updatedAt: lastCreated,
        })

        for (const msg of bucket.messages) {
          seq += 1
          const kind = msg.role === 'system' ? 'custom_message' : 'message'
          const contentJson =
            kind === 'custom_message'
              ? JSON.stringify({
                  customType: 'local_system',
                  content: msg.text,
                  display: true,
                })
              : JSON.stringify({ role: msg.role, content: msg.text })
          const res = db.run(
            `INSERT OR IGNORE INTO vela_messages (
              session_id, id, parent_id, seq, kind, role, content_json,
              include_in_context, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            sessionId,
            msg.id,
            parentId,
            seq,
            kind,
            msg.role === 'system' ? 'user' : msg.role,
            contentJson,
            msg.createdAt ?? now,
          )
          db.run(
            'UPDATE blobs SET session_id = ? WHERE message_id = ? AND project_id = ?',
            sessionId,
            msg.id,
            bucket.projectId,
          )
          parentId = msg.id
          if (res.changes > 0) summary.messages += 1
        }
      }

      for (const [sessionId, bucket] of fallbackLocalMessages) {
        for (const msg of bucket.messages) {
          if (!msg.file) continue
          const hasSession = db.get<{ id: string }>(
            'SELECT id FROM sessions WHERE id = ?',
            sessionId,
          )
          if (hasSession) {
            db.run(
              'UPDATE blobs SET session_id = COALESCE(session_id, ?) WHERE message_id = ? AND project_id = ?',
              sessionId,
              msg.id,
              bucket.projectId,
            )
          }
        }
      }

      if (!incompleteRef.incomplete) {
        db.run('DELETE FROM kv_meta WHERE key = ?', LEGACY_MIGRATION_STATE_KEY)
        db.run(
          `INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)`,
          LEGACY_MIGRATION_KEY,
          JSON.stringify({
            version: 1,
            migratedAt: now,
            summary,
            warnings,
          }),
          now,
        )
      } else {
        db.run(
          `INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          LEGACY_MIGRATION_STATE_KEY,
          JSON.stringify({ sessionAllocations }),
          now,
        )
      }

      return {
        skipped: false,
        migratedAt: now,
        summary,
        warnings,
      }
    }, 'IMMEDIATE')
  } catch (error) {
    if (createdConfigSha256) {
      removeConfigIfHashMatches(agentDir, createdConfigSha256)
    }
    for (const blobPath of createdBlobPaths) {
      rmSync(blobPath, { force: true })
    }
    throw error
  }
}
