import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../shared/interpolate.ts'
import {
  loadLarkAndChannelConfig,
  migrateChannelDirectory,
  migratePendingInboxMessages,
  migrateRemainingLarkChats,
} from './migrate-legacy-channels.ts'
import {
  migrateLegacyConfigFiles,
  removeConfigIfHashMatches,
} from './migrate-legacy-config.ts'
import {
  buildSessionIdResolver,
  collectTranscriptFiles,
  discoverLegacyDataDirs,
} from './migrate-legacy-discovery.ts'
import { parseLegacyTranscript } from './migrate-legacy-jsonl.ts'
import { migrateRoutinesAndSubscriptions } from './migrate-legacy-routines.ts'
import {
  type DeferredPendingMessages,
  type LarkChatMigrationConfig,
  type LegacyLocalMessage,
  type LegacyMigrationSummary,
  type MigrationOps,
  migrateLocalProjects,
  migrateTrustFile,
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

function mergeJsonObjects(
  existingJson: string | null | undefined,
  incomingJson: string | null | undefined,
): string | null {
  if (!existingJson) return incomingJson ?? null
  if (!incomingJson) return existingJson
  try {
    const existingObj = JSON.parse(existingJson)
    const incomingObj = JSON.parse(incomingJson)
    if (isPlainObject(existingObj) && isPlainObject(incomingObj)) {
      return JSON.stringify({ ...incomingObj, ...existingObj })
    }
  } catch {
    // Keep existing JSON if either side is not a JSON object.
  }
  return existingJson
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
      const unresolvedTimezoneChannels = new Set<string>()
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
          const existingProj = db.get<{ config_json: string | null }>(
            'SELECT config_json FROM projects WHERE id = ?',
            row.id,
          )
          const mergedConfigJson = mergeJsonObjects(
            existingProj?.config_json,
            row.configJson,
          )
          db.run(
            `UPDATE projects SET
              cwd = COALESCE(cwd, ?),
              data_dir = COALESCE(data_dir, ?),
              hub_session_id = COALESCE(hub_session_id, ?),
              default_model = COALESCE(default_model, ?),
              default_thinking_level = COALESCE(default_thinking_level, ?),
              default_tools_json = COALESCE(default_tools_json, ?),
              config_json = ?,
              updated_at = ?
            WHERE id = ?`,
            row.cwd ?? null,
            row.dataDir ?? null,
            row.hubSessionId ?? null,
            row.defaultModel ?? null,
            row.defaultThinkingLevel ?? null,
            row.defaultToolsJson ?? null,
            mergedConfigJson,
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
        const existingBinding = db.get<{
          id: string
          config_json: string | null
        }>(
          'SELECT id, config_json FROM channel_bindings WHERE channel = ? AND external_id = ?',
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
        const mergedConfigJson = mergeJsonObjects(
          existingBinding.config_json,
          row.configJson,
        )
        db.run(
          `UPDATE channel_bindings SET
            thread_id = COALESCE(thread_id, ?),
            project_id = COALESCE(project_id, ?),
            session_id = COALESCE(session_id, ?),
            enabled = CASE WHEN ? = 1 THEN 1 ELSE enabled END,
            config_json = ?,
            updated_at = ?
          WHERE id = ?`,
          row.threadId ?? null,
          row.projectId,
          row.sessionId,
          enabledVal,
          mergedConfigJson,
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
        unresolvedTimezoneChannels,
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

          const existingRows = db.all<{
            id: string
            seq: number
            kind: string
            content_json: string
            parent_id: string | null
            first_kept_id: string | null
          }>(
            'SELECT id, seq, kind, content_json, parent_id, first_kept_id FROM vela_messages WHERE session_id = ? ORDER BY seq ASC',
            targetSessionId,
          )
          const existingIds = new Set(existingRows.map((row) => row.id))
          const claimedRowIds = new Set<string>()
          const matchedRowByMsgId = new Map<
            string,
            (typeof existingRows)[number]
          >()
          const idMap = new Map<string, string>()

          // Pass 1: exact (seq, kind, content_json) matches claim their existing IDs first.
          const rowBySeq = new Map(existingRows.map((row) => [row.seq, row]))
          for (const msg of parsed.messages) {
            const row = rowBySeq.get(msg.seq)
            if (
              row &&
              row.kind === msg.kind &&
              row.content_json === msg.contentJson
            ) {
              claimedRowIds.add(row.id)
              matchedRowByMsgId.set(msg.id, row)
              if (row.id !== msg.id) idMap.set(msg.id, row.id)
            }
          }

          // Pass 2: shifted-seq fallback matches by identical kind + content_json so newly
          // inserted messages never alias an earlier compaction/message ID at the same seq.
          const unmatchedBySignature = new Map<
            string,
            Array<(typeof existingRows)[number]>
          >()
          for (const row of existingRows) {
            if (claimedRowIds.has(row.id)) continue
            const sig = `${row.kind}\0${row.content_json}`
            const bucket = unmatchedBySignature.get(sig)
            if (bucket) bucket.push(row)
            else unmatchedBySignature.set(sig, [row])
          }
          for (const msg of parsed.messages) {
            if (matchedRowByMsgId.has(msg.id)) continue
            const sig = `${msg.kind}\0${msg.contentJson}`
            const row = unmatchedBySignature.get(sig)?.shift()
            if (row) {
              claimedRowIds.add(row.id)
              matchedRowByMsgId.set(msg.id, row)
              if (row.id !== msg.id) idMap.set(msg.id, row.id)
              continue
            }
            if (existingIds.has(msg.id)) {
              const freshId = randomUUID()
              idMap.set(msg.id, freshId)
              existingIds.add(freshId)
            } else {
              existingIds.add(msg.id)
            }
          }
          const usedSeqs = new Set<number>()
          let maxSeq = -1
          for (const row of existingRows) {
            if (!claimedRowIds.has(row.id)) {
              usedSeqs.add(row.seq)
              maxSeq = Math.max(maxSeq, row.seq)
            }
          }
          const remapId = (id: string | null): string | null =>
            id ? (idMap.get(id) ?? id) : null

          ensureSession({
            id: targetSessionId,
            projectId: inferredProjectId,
            kind: inferredProjectId ? 'work' : 'chat',
            name: parsed.name ?? null,
            archived: parsed.archived,
            model: parsed.model ?? null,
            thinkingLevel: parsed.thinkingLevel ?? null,
            locationJson,
            leafMessageId: remapId(parsed.leafMessageId),
            discoveredToolsJson: parsed.discoveredTools
              ? JSON.stringify(parsed.discoveredTools)
              : null,
            parentSessionId: resolvedParentSessionId,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
          })

          const planned = parsed.messages.map((msg) => {
            let targetSeq = msg.seq
            if (usedSeqs.has(targetSeq)) {
              targetSeq = ++maxSeq
            } else {
              maxSeq = Math.max(maxSeq, targetSeq)
            }
            usedSeqs.add(targetSeq)
            return {
              msg,
              targetSeq,
              remappedParent: remapId(msg.parentId),
              remappedFirstKept: remapId(msg.firstKeptId),
              matchedRow: matchedRowByMsgId.get(msg.id),
              mappedId: idMap.get(msg.id) ?? msg.id,
            }
          })

          // Park moving rows above all existing/target seq values so UNIQUE(session_id, seq) never
          // blocks shifting existing rows or inserting new messages into vacated seq slots.
          let parkSeq = existingRows.reduce(
            (max, row) => Math.max(max, row.seq),
            maxSeq,
          )
          for (const item of planned) {
            if (item.matchedRow && item.matchedRow.seq !== item.targetSeq) {
              db.run(
                'UPDATE vela_messages SET seq = ? WHERE session_id = ? AND id = ?',
                ++parkSeq,
                targetSessionId,
                item.matchedRow.id,
              )
            }
          }
          for (const item of planned) {
            if (
              item.matchedRow &&
              (item.matchedRow.seq !== item.targetSeq ||
                item.matchedRow.parent_id !== item.remappedParent ||
                item.matchedRow.first_kept_id !== item.remappedFirstKept)
            ) {
              db.run(
                'UPDATE vela_messages SET parent_id = ?, first_kept_id = ?, seq = ? WHERE session_id = ? AND id = ?',
                item.remappedParent,
                item.remappedFirstKept,
                item.targetSeq,
                targetSessionId,
                item.matchedRow.id,
              )
            }
          }
          for (const item of planned) {
            if (item.matchedRow) continue
            const { msg, mappedId, remappedParent, targetSeq } = item
            const res = db.run(
              `INSERT OR IGNORE INTO vela_messages (
                session_id, id, parent_id, seq, kind, role, content_json,
                include_in_context, stop_reason, produced_by, first_kept_id,
                tokens_before, label, details_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              targetSessionId,
              mappedId,
              remappedParent,
              targetSeq,
              msg.kind,
              msg.role,
              msg.contentJson,
              msg.includeInContext ? 1 : 0,
              msg.stopReason,
              msg.producedBy,
              remapId(msg.firstKeptId),
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
      try {
        removeConfigIfHashMatches(agentDir, createdConfigSha256)
      } catch {}
    }
    for (const blobPath of createdBlobPaths) {
      try {
        rmSync(blobPath, { force: true })
      } catch {}
    }
    throw error
  }
}
