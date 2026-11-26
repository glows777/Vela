import type { VelaDatabase } from '../../db/index.ts'

interface DbEntry {
  db: VelaDatabase
  refs: number
}

const byDataDir = new Map<string, DbEntry[]>()

/**
 * Registers the `VelaDatabase` backing a `dataDir` while a host (`createVela`) is open,
 * allowing built-in extensions (like `memory()`) to use `vela.db` without exposing it
 * on the public `ExtensionAPI`. Maintains a ref-counted stack per `dataDir` so nested
 * or multi-host openings never clobber an active host's database handle.
 */
export function registerMemoryDatabase(
  dataDir: string,
  db: VelaDatabase,
): void {
  const stack = byDataDir.get(dataDir) ?? []
  const existing = stack.find((entry) => entry.db === db)
  if (existing) {
    existing.refs++
  } else {
    stack.push({ db, refs: 1 })
    byDataDir.set(dataDir, stack)
  }
}

export function unregisterMemoryDatabase(
  dataDir: string,
  db: VelaDatabase,
): void {
  const stack = byDataDir.get(dataDir)
  if (!stack) return
  const index = stack.findIndex((entry) => entry.db === db)
  if (index === -1) return
  stack[index]!.refs--
  if (stack[index]!.refs <= 0) {
    stack.splice(index, 1)
  }
  if (stack.length === 0) {
    byDataDir.delete(dataDir)
  }
}

export function resolveMemoryDatabase(
  dataDir: string,
): VelaDatabase | undefined {
  const stack = byDataDir.get(dataDir)
  if (!stack) return undefined
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.db.open) return stack[i]!.db
  }
  return undefined
}
