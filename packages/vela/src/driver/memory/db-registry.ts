import type { VelaDatabase } from '../../db/index.ts'

interface DbEntry {
  db: VelaDatabase
  refs: number
}

const byDataDir = new Map<string, DbEntry>()

/**
 * Registers the `VelaDatabase` backing a `dataDir` while a host (`createVela`) is open,
 * allowing built-in extensions (like `memory()`) to use `vela.db` without exposing it
 * on the public `ExtensionAPI`.
 */
export function registerMemoryDatabase(
  dataDir: string,
  db: VelaDatabase,
): void {
  const existing = byDataDir.get(dataDir)
  if (existing && existing.db === db) {
    existing.refs++
    return
  }
  byDataDir.set(dataDir, { db, refs: 1 })
}

export function unregisterMemoryDatabase(
  dataDir: string,
  db: VelaDatabase,
): void {
  const existing = byDataDir.get(dataDir)
  if (!existing || existing.db !== db) return
  existing.refs--
  if (existing.refs <= 0) {
    byDataDir.delete(dataDir)
  }
}

export function resolveMemoryDatabase(
  dataDir: string,
): VelaDatabase | undefined {
  const entry = byDataDir.get(dataDir)
  if (!entry?.db.open) return undefined
  return entry.db
}
