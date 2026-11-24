import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isPlainObject } from '../shared/interpolate.ts'
import {
  isSafeSegment,
  isStrictlyInside,
  legacyChannelSessionId,
  readJsonStrict,
} from './migrate-legacy-sources.ts'

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}

function shortDirHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8)
}

export function discoverLegacyDataDirs(
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

export function collectTranscriptFiles(
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

export function buildSessionIdResolver(
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
    const localRoot = join(dataDir, 'local')
    const projectsFile = join(localRoot, 'projects.json')
    if (existsSync(projectsFile)) {
      const parsed = readJsonStrict(projectsFile)
      if (isPlainObject(parsed) && Array.isArray(parsed.projects)) {
        for (const proj of parsed.projects) {
          if (!isPlainObject(proj) || typeof proj.id !== 'string') continue
          if (typeof proj.sessionId === 'string') {
            register(dataDir, proj.sessionId)
          }
          if (!isSafeSegment(proj.id)) continue
          const logFile = join(localRoot, `${proj.id}.json`)
          if (!isStrictlyInside(logFile, localRoot) || !existsSync(logFile))
            continue
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
    const subsFile = join(dataDir, 'channels', 'subscriptions.json')
    if (existsSync(subsFile)) {
      const parsed = readJsonStrict(subsFile)
      if (isPlainObject(parsed) && Array.isArray(parsed.subscriptions)) {
        for (const sub of parsed.subscriptions) {
          if (
            isPlainObject(sub) &&
            typeof sub.targetKey !== 'string' &&
            typeof sub.channel === 'string' &&
            typeof sub.chatId === 'string'
          ) {
            register(dataDir, legacyChannelSessionId(sub.channel, sub.chatId))
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
