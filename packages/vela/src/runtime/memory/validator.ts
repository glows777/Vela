import fs from 'node:fs'
import path from 'node:path'

/** The fields lint reads; MemoryStore's entry satisfies it. */
interface ValidatableEntry {
  name: string
  type: string
  content: string
  lastReadAt?: number
}

interface ValidationIssue {
  kind: 'stale_path' | 'duplicate_name'
  message: string
}

export interface ValidationReport<T> {
  entry: T
  issues: ValidationIssue[]
}

const PATH_RE =
  /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g

function extractPaths(content: string): string[] {
  const paths = new Set<string>()
  for (const match of content.matchAll(PATH_RE)) {
    paths.add(match[1]!)
  }
  return Array.from(paths)
}

function validateEntry(
  entry: ValidatableEntry,
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

  return issues
}

function buildDuplicateCounts<T extends ValidatableEntry>(
  entries: readonly T[],
): Map<string, number> {
  const nameCount = new Map<string, number>()
  for (const e of entries) {
    nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1)
  }
  return nameCount
}

function appendDuplicateIssue<T extends ValidatableEntry>(
  entry: T,
  issues: ValidationIssue[],
  nameCount: ReadonlyMap<string, number>,
): void {
  const count = nameCount.get(entry.name) || 0
  if (count > 1) {
    issues.push({
      kind: 'duplicate_name',
      message: `${count} memories share this name; consider merging`,
    })
  }
}

export function lintAll<T extends ValidatableEntry>(
  entries: T[],
  baseDir = '.',
): ValidationReport<T>[] {
  const reports: ValidationReport<T>[] = []
  const nameCount = buildDuplicateCounts(entries)

  for (const entry of entries) {
    const issues = validateEntry(entry, baseDir)
    appendDuplicateIssue(entry, issues, nameCount)
    if (issues.length > 0) reports.push({ entry, issues })
  }

  return reports
}

export async function lintAllAsync<T extends ValidatableEntry>(
  entries: T[],
  pathExists: (candidate: string) => Promise<boolean>,
): Promise<ValidationReport<T>[]> {
  const reports: ValidationReport<T>[] = []
  const nameCount = buildDuplicateCounts(entries)

  for (const entry of entries) {
    const issues: ValidationIssue[] = []
    for (const p of extractPaths(entry.content)) {
      if (!(await pathExists(p))) {
        issues.push({
          kind: 'stale_path',
          message: `Referenced path does not exist: ${p}`,
        })
      }
    }
    appendDuplicateIssue(entry, issues, nameCount)
    if (issues.length > 0) reports.push({ entry, issues })
  }

  return reports
}
