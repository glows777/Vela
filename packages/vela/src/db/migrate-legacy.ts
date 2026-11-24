import { randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { migrateLegacyConfigFiles } from '../config/index.ts'
import { isPlainObject } from '../shared/interpolate.ts'
import { parseLegacyTranscript } from './migrate-legacy-jsonl.ts'
import {
  type LegacyLocalMessage,
  type LegacyMigrationSummary,
  type MigrationOps,
  migrateChannelDirectory,
  migrateLarkChats,
  migrateLocalProjects,
  migrateRoutinesAndSubscriptions,
  migrateTrustFile,
  readJsonStrict,
} from './migrate-legacy-sources.ts'
import type { VelaDatabase } from './sqlite.ts'

export type { LegacyMigrationSummary }

const LEGACY_MIGRATION_KEY = 'legacy_migration_v08'

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

function discoverLegacyDataDirs(agentDir: string): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  const add = (dir: string) => {
    const resolved = resolve(dir)
    if (seen.has(resolved)) return
    seen.add(resolved)
    dirs.push(resolved)
  }

  add(agentDir)
  const projectsRoot = join(agentDir, 'projects')
  if (existsSync(projectsRoot)) {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(projectsRoot, entry.name))
    }
  }

  for (const configName of ['config.json', 'settings.json'] as const) {
    const file = join(agentDir, configName)
    if (!existsSync(file)) continue
    const parsed = readJsonStrict(file)
    if (isPlainObject(parsed) && typeof parsed.dataDir === 'string') {
      const expanded = expandHomePath(parsed.dataDir)
      if (isAbsolute(expanded)) add(expanded)
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
}): LegacyMigrationResult {
  const { agentDir, db } = options
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
      migratedAt: parsed.migratedAt ?? new Date().toISOString(),
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
  let configMigrated = false
  if (options.includeConfig !== false) {
    const cfg = migrateLegacyConfigFiles(agentDir)
    configMigrated = cfg.createdConfig
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

  const now = new Date().toISOString()
  const dataDirs = discoverLegacyDataDirs(agentDir)
  const createdBlobPaths: string[] = []

  try {
    db.transaction(() => {
      const projectByCwd = new Map<string, string>()
      const projectByChat = new Map<string, string>()
      const channelSessionByKey = new Map<
        string,
        { sessionId: string; projectId: string | null }
      >()
      const fallbackLocalMessages = new Map<
        string,
        { projectId: string; messages: LegacyLocalMessage[] }
      >()
      const seenSessionIds = new Set<string>()
      const seenChannelBindings = new Set<string>()

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
              updated_at = ?
            WHERE id = ?`,
            row.dataDir ?? null,
            row.hubSessionId ?? null,
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
                location_json, leaf_message_id, parent_session_id, state, waiting_reason,
                created_at, updated_at
              ) VALUES (?, ?, ?, 'vela', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              row.id,
              row.projectId,
              row.kind,
              row.name ?? null,
              row.archived ? 1 : 0,
              row.model ?? null,
              row.thinkingLevel ?? null,
              row.locationJson ?? null,
              row.leafMessageId ?? null,
              row.parentSessionId ?? null,
              row.state ?? 'idle',
              row.waitingReason ?? null,
              created,
              updated,
            )
            summary.sessions += 1
          }
          seenSessionIds.add(row.id)
          return
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
          row.parentSessionId ?? null,
          updated,
          row.id,
        )
      }

      const ensureChannelBinding: MigrationOps['ensureChannelBinding'] = (
        row,
      ) => {
        const key = `${row.channel}\0${row.externalId}`
        if (seenChannelBindings.has(key)) return
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            randomUUID(),
            row.channel,
            row.externalId,
            row.threadId ?? null,
            row.kind,
            row.projectId,
            row.sessionId,
            row.configJson ?? null,
            now,
            now,
          )
          summary.channelBindings += 1
        }
        seenChannelBindings.add(key)
      }

      const ops: MigrationOps = {
        agentDir,
        db,
        now,
        summary,
        warnings,
        createdBlobPaths,
        projectByChat,
        channelSessionByKey,
        fallbackLocalMessages,
        ensureProject,
        ensureSession,
        ensureChannelBinding,
      }

      migrateTrustFile(ops)
      migrateLocalProjects(ops, dataDirs)
      migrateLarkChats(ops)
      migrateChannelDirectory(ops, dataDirs)
      migrateRoutinesAndSubscriptions(ops, dataDirs)

      const migratedTranscriptSessions = new Set<string>()
      for (const dataDir of dataDirs) {
        for (const item of collectTranscriptFiles(join(dataDir, 'sessions'))) {
          if (migratedTranscriptSessions.has(item.id)) {
            warnings.push(
              `Skipped duplicate transcript for session "${item.id}" at ${item.path}`,
            )
            continue
          }
          const parsed = parseLegacyTranscript(
            readFileSync(item.path, 'utf8'),
            item.id,
            item.path,
          )
          warnings.push(...parsed.warnings)

          const inferredProjectId =
            (parsed.cwd ? projectByCwd.get(parsed.cwd) : undefined) ??
            fallbackLocalMessages.get(item.id)?.projectId ??
            null
          const locationJson =
            parsed.location !== undefined
              ? JSON.stringify(parsed.location)
              : parsed.cwd
                ? JSON.stringify({ environment: 'local', cwd: parsed.cwd })
                : null

          ensureSession({
            id: item.id,
            projectId: inferredProjectId,
            kind: inferredProjectId ? 'work' : 'chat',
            name: parsed.name ?? null,
            archived: parsed.archived,
            model: parsed.model ?? null,
            thinkingLevel: parsed.thinkingLevel ?? null,
            locationJson,
            leafMessageId: parsed.leafMessageId,
            parentSessionId: parsed.parentSession ?? null,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
          })

          for (const msg of parsed.messages) {
            db.run(
              `INSERT INTO vela_messages (
                session_id, id, parent_id, seq, kind, role, content_json,
                include_in_context, stop_reason, produced_by, first_kept_id,
                tokens_before, label, details_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              item.id,
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
            summary.messages += 1
          }
          migratedTranscriptSessions.add(item.id)
        }
      }

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
          db.run(
            `INSERT INTO vela_messages (
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
          summary.messages += 1
        }
      }

      for (const [sessionId, bucket] of fallbackLocalMessages) {
        for (const msg of bucket.messages) {
          if (!msg.file) continue
          db.run(
            'UPDATE blobs SET session_id = COALESCE(session_id, ?) WHERE message_id = ? AND project_id = ?',
            sessionId,
            msg.id,
            bucket.projectId,
          )
        }
      }

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
    }, 'IMMEDIATE')
  } catch (error) {
    for (const blobPath of createdBlobPaths) {
      rmSync(blobPath, { force: true })
    }
    throw error
  }

  return {
    skipped: false,
    migratedAt: now,
    summary,
    warnings,
  }
}
