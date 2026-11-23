import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/** An extension to load: built-ins by name, others by file path. */
export type ExtensionEntry =
  | { name: string; builtin: true }
  | { name: string; path: string }

const EXTENSION_FILE = /\.(ts|js|mjs)$/

/**
 * Expands an extension path into entry files: a file is itself; a directory with
 * index.ts / index.js is one extension; in any other directory, each `*.ts` and each
 * subdirectory with an index is one extension. With `explicit`, a missing path throws.
 */
export function discoverExtensions(path: string, explicit = false): string[] {
  if (!existsSync(path)) {
    if (explicit) throw new Error(`Extension path does not exist: ${path}`)
    return []
  }
  if (!statSync(path).isDirectory()) return [path]
  const index = indexFile(path)
  if (index) return [index]
  const found: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(path, entry.name)
    if (
      entry.isFile() &&
      EXTENSION_FILE.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    )
      found.push(full)
    else if (entry.isDirectory()) {
      const nested = indexFile(full)
      if (nested) found.push(nested)
    }
  }
  return found
}

function indexFile(dir: string): string | undefined {
  for (const name of ['index.ts', 'index.js', 'index.mjs']) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
}

/** Extension name: the file name without extension, or the directory name for index files. Sets the tool prefix and config section. */
/** @experimental Shared frontend contract. */
export function extensionName(path: string): string {
  const file = basename(path, extname(path))
  return file === 'index' ? basename(dirname(path)) : file
}

/** Resolve one source layer without importing any extension code. */
export function resolveExtensionEntries(
  entries: readonly string[],
  discovered: readonly string[],
  builtins: readonly string[] = [],
  defaultOff: readonly string[] = [],
): ExtensionEntry[] {
  const disabled = new Set(defaultOff)
  const paths = [...discovered]
  for (const entry of entries) {
    const builtin = /^([+-]?)builtin:(.+)$/.exec(entry)
    if (builtin) {
      const name = builtin[2]!
      if (!builtins.includes(name)) {
        // Accept legacy opt-outs for the retired built-in `rag` so upgrading users don't fail startup.
        if (builtin[1] === '-' && name === 'rag') continue
        throw new Error(`Unknown built-in extension builtin:${name}`)
      }
      if (builtin[1] === '-') disabled.add(name)
      else disabled.delete(name)
    } else paths.push(...discoverExtensions(entry, true))
  }
  return [
    ...builtins
      .filter((name) => !disabled.has(name))
      .map((name) => ({ name, builtin: true as const })),
    ...[...new Set(paths)].map((path) => ({ name: extensionName(path), path })),
  ]
}
