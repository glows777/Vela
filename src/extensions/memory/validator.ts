import fs from 'node:fs'
import path from 'node:path'
import type { MemoryEntry } from './store.ts'

export interface ValidationIssue {
  kind: 'stale_path' | 'never_used' | 'duplicate_name'
  message: string
}

export interface ValidationReport {
  entry: MemoryEntry
  issues: ValidationIssue[]
}

const PATH_RE =
  /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g

export function extractPaths(content: string): string[] {
  const paths = new Set<string>()
  for (const match of content.matchAll(PATH_RE)) {
    paths.add(match[1]!)
  }
  return Array.from(paths)
}

// Shelf life in days per memory type
const TTL_BY_TYPE: Record<string, number> = {
  user: 365, // user preferences barely expire
  feedback: 90, // corrections: 3 months
  project: 30, // project decisions change fast: 1 month
  reference: 14, // external references need frequent refreshing
}

export function validateEntry(
  entry: MemoryEntry,
  baseDir = '.',
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const paths = extractPaths(entry.content)
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p)
    if (!fs.existsSync(abs)) {
      issues.push({
        kind: 'stale_path',
        message: `Referenced path does not exist: ${p}`,
      })
    }
  }

  if (entry.lastReadAt) {
    const staleDays = TTL_BY_TYPE[entry.type] ?? 30
    const days = (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24)
    if (days > staleDays) {
      issues.push({
        kind: 'never_used',
        message: `Not read for ${Math.floor(days)} days, past the ${staleDays}-day shelf life for type ${entry.type}`,
      })
    }
  }

  return issues
}

export function lintAll(
  entries: MemoryEntry[],
  baseDir = '.',
): ValidationReport[] {
  const reports: ValidationReport[] = []

  const nameCount = new Map<string, number>()
  for (const e of entries) {
    nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1)
  }

  for (const entry of entries) {
    const issues = validateEntry(entry, baseDir)
    if ((nameCount.get(entry.name) || 0) > 1) {
      issues.push({
        kind: 'duplicate_name',
        message: `${nameCount.get(entry.name)} memories share this name; consider merging`,
      })
    }
    if (issues.length > 0) reports.push({ entry, issues })
  }

  return reports
}
