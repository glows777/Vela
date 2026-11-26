import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../../shared/frontmatter.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import { bm25Search, type SearchHit } from './search.ts'
import { lintAll, lintAllAsync, type ValidationReport } from './validator.ts'

export interface MemoryEntry {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  content: string
  filePath: string
  lastWriteAt?: number
  lastReadAt?: number
  sources?: string[]
}

export const MAX_NOTE_CHARS = 16_000
const INDEX_FILE = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_FILE_CHARS = 4000
const SAFE_PLAIN_NAME_RE = /^[a-zA-Z0-9\u4e00-\u9fff\s_-]+$/

/** Fixed usage rules for the system prompt; only the index (buildIndex) changes between turns. */
export const MEMORY_RULES = [
  '[memory] How to use memory:',
  '- Save durable facts, preferences and decisions with the memory tool; saving the same name and type overwrites',
  '- Memories are leads, not facts: verify with tools before relying on them (read, grep to confirm paths and content still exist)',
  '- Do not store what the code shows (tech stack, directory layout), what git can tell (who changed what), or what docs already say',
  '- Store only information from the conversation that cannot be derived elsewhere (user preferences, corrections, project decisions, external resources)',
  "- Use the memory tool's read action to read a memory; search for BM25 search; lint to check the store's health.",
].join('\n')

/** Writes a memory file readable only by the owner (0600, like session files); also tightens an existing file. */
function writePrivate(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

/**
 * Generates a collision-safe, cross-platform filename slug for a memory name.
 * Preserves legacy readable slugs for plain ASCII/CJK names while adding a deterministic
 * short hash whenever symbols, punctuation, or non-ASCII scripts could collide (e.g. `C++` vs `C#`).
 */
export function memorySlug(name: string): string {
  const normalized = name.normalize('NFKC').toLowerCase()
  const full = normalized.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
  const base = full.slice(0, 64).replace(/-+$/g, '')
  if (SAFE_PLAIN_NAME_RE.test(name) && full.length > 0 && full.length <= 64) {
    return base
  }
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return base ? `${base}-${hash}` : `note-${hash}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function indexEntryPattern(filename: string): RegExp {
  return new RegExp(
    `^\\s*-\\s+\\[[^\\]]*\\]\\(${escapeRegExp(filename)}\\)(?:\\s|$)`,
  )
}

const YAML_NUMBER_RE =
  /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?$|^0[xbo][\da-f_]+$/i
const YAML_KEYWORD_RE =
  /^(?:true|false|yes|no|on|off|y|n|null|~|\.inf|-\.inf|\+\.inf|\.nan)$/i
const YAML_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/

function formatYamlScalar(value: string): string {
  if (
    value.length > 0 &&
    !/[\r\n:#{}[\],&*!|>'"%@`]|^\s|\s$|^(?:-|\?)(?:\s|$)/.test(value) &&
    !YAML_KEYWORD_RE.test(value) &&
    !YAML_NUMBER_RE.test(value) &&
    !YAML_DATE_RE.test(value)
  ) {
    return value
  }
  return JSON.stringify(value)
}

export class MemoryStore {
  /**
   * `memoryDir`: directory holding the memory files and MEMORY.md.
   * `projectDir`: base for relative paths when lint checks whether paths mentioned in memories still exist.
   */
  constructor(
    readonly memoryDir: string,
    private logger?: VelaLogger,
    private readonly projectDir = '.',
  ) {}

  private get indexPath(): string {
    return path.join(this.memoryDir, INDEX_FILE)
  }

  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true, mode: 0o700 })
    } else {
      // A store written by an older version has default permissions: tighten the directory and its files
      fs.chmodSync(this.memoryDir, 0o700)
      for (const entry of fs.readdirSync(this.memoryDir, {
        withFileTypes: true,
      }))
        if (entry.isFile() && entry.name.endsWith('.md'))
          fs.chmodSync(path.join(this.memoryDir, entry.name), 0o600)
    }
    if (!fs.existsSync(this.indexPath)) {
      writePrivate(this.indexPath, '# Memory Index\n')
    }
  }

  save(
    entry: Omit<MemoryEntry, 'filePath' | 'lastWriteAt' | 'lastReadAt'>,
    targetFilename?: string,
  ): string {
    if (entry.content.length > MAX_NOTE_CHARS) {
      throw new Error(
        `Memory content exceeds maximum length of ${MAX_NOTE_CHARS} characters (got ${entry.content.length})`,
      )
    }
    this.init()
    const slug = memorySlug(entry.name)
    let resolvedTarget = targetFilename
    if (!resolvedTarget) {
      const canonicalName = `${entry.type}_${slug}.md`
      const canonicalPath = this.memoryFile(canonicalName)
      if (!fs.existsSync(canonicalPath)) {
        const existing = this.list().find(
          (item) => item.type === entry.type && item.name === entry.name,
        )
        if (existing) resolvedTarget = path.basename(existing.filePath)
      } else {
        const occupant = this.parseFrontmatter(
          fs.readFileSync(canonicalPath, 'utf-8'),
        )
        if (
          occupant &&
          (occupant.type !== entry.type || occupant.name !== entry.name)
        ) {
          const existing = this.list().find(
            (item) => item.type === entry.type && item.name === entry.name,
          )
          if (existing) {
            resolvedTarget = path.basename(existing.filePath)
          } else {
            const hash = createHash('sha256')
              .update(entry.name)
              .digest('hex')
              .slice(0, 8)
            const shortBase = slug.slice(0, 55).replace(/-+$/g, '') || 'note'
            let candidate = `${entry.type}_${shortBase}-${hash}.md`
            let counter = 2
            while (fs.existsSync(this.memoryFile(candidate))) {
              const other = this.parseFrontmatter(
                fs.readFileSync(this.memoryFile(candidate), 'utf-8'),
              )
              if (
                !other ||
                (other.type === entry.type && other.name === entry.name)
              ) {
                break
              }
              candidate = `${entry.type}_${shortBase}-${hash}-${counter++}.md`
            }
            resolvedTarget = candidate
          }
        }
      }
    }
    const filename = resolvedTarget ?? `${entry.type}_${slug}.md`
    const filePath = this.memoryFile(filename)
    const previous = fs.existsSync(filePath)
      ? this.parseFrontmatter(fs.readFileSync(filePath, 'utf-8'))
      : null
    // Same-millisecond saves must still invalidate an in-flight dream snapshot.
    const now = Math.max(Date.now(), (previous?.lastWriteAt ?? 0) + 1)
    const sources = entry.sources ?? previous?.sources

    const fileContent = [
      '---',
      `name: ${formatYamlScalar(entry.name)}`,
      `description: ${formatYamlScalar(entry.description)}`,
      `type: ${entry.type}`,
      `lastWriteAt: ${now}`,
      `lastReadAt: ${now}`,
      ...(sources?.length
        ? [`sources: ${JSON.stringify(sources.slice(-5))}`]
        : []),
      '---',
      '',
      entry.content,
    ].join('\n')

    writePrivate(filePath, fileContent)
    this.updateIndex(entry.name, filename, entry.description)
    return filename
  }

  private updateIndex(
    name: string,
    filename: string,
    description: string,
  ): void {
    const indexContent = fs.readFileSync(this.indexPath, 'utf-8')
    const lines = indexContent.split('\n')

    const pattern = indexEntryPattern(filename)
    const existingIdx = lines.findIndex((l) => pattern.test(l))
    const safeName = name.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '')
    const safeDesc = description.replace(/[\r\n]+/g, ' ')
    const newLine = `- [${safeName}](${filename}) — ${safeDesc}`

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine
    } else {
      if (
        lines.filter((line) => line.startsWith('- ')).length === MAX_INDEX_LINES
      )
        this.logger?.info(
          '[memory] Index exceeds 200 entries; all entries are preserved. Run /dream to consolidate.',
        )
      lines.push(newLine)
    }

    writePrivate(this.indexPath, lines.join('\n'))
  }

  list(): MemoryEntry[] {
    this.init()
    const entries: MemoryEntry[] = []
    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith('.md') && f !== INDEX_FILE)

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file)
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = this.parseFrontmatter(raw)
      if (parsed) {
        entries.push({ ...parsed, filePath })
      }
    }
    return entries
  }

  search(query: string, topK = 5): SearchHit<MemoryEntry>[] {
    return bm25Search(this.list(), query, topK)
  }

  loadIndex(maxChars = MAX_FILE_CHARS): string {
    this.init()
    const raw = fs.readFileSync(this.indexPath, 'utf-8')
    if (raw.length <= maxChars) return raw
    const lines = raw.split('\n')
    const total = lines.filter((line) => line.startsWith('- ')).length
    const kept: string[] = []
    let shown = 0
    for (const line of lines) {
      const nextShown = shown + (line.startsWith('- ') ? 1 : 0)
      const marker = `\n${total - nextShown} more entries not shown; use memory search`
      if ([...kept, line].join('\n').length + marker.length > maxChars) break
      kept.push(line)
      shown = nextShown
    }
    return `${kept.join('\n')}\n${total - shown} more entries not shown; use memory search`
  }

  indexWarnings(): string[] {
    const count = this.list().length
    return [
      ...(count > MAX_INDEX_LINES
        ? [
            `Index exceeds the ${MAX_INDEX_LINES}-entry limit (${count}); run /dream to consolidate.`,
          ]
        : []),
      ...(this.loadIndex().includes('more entries not shown')
        ? ['Injected index is truncated; use memory search to find all notes.']
        : []),
    ]
  }

  /**
   * Path of a memory file named by the model. Only a plain `*.md` file name directly in the memory directory
   * (not the index) is accepted: `../`, separators and absolute paths would reach files outside the store.
   */
  memoryFile(filename: string): string {
    if (
      filename !== path.basename(filename) ||
      filename.includes('\\') ||
      !filename.endsWith('.md') ||
      filename === INDEX_FILE ||
      filename.startsWith('.')
    )
      throw new Error(
        `Invalid memory filename "${filename}": use a file name from the memory index, such as user_example.md`,
      )
    return path.join(this.memoryDir, filename)
  }

  loadFile(
    filename: string,
    options?: { offset?: number; limit?: number },
  ): string | null {
    const filePath = this.memoryFile(filename)
    if (!fs.existsSync(filePath)) return null
    this.touchReadAt(filePath)
    const raw = fs.readFileSync(filePath, 'utf-8')
    const offset = Math.max(0, Math.floor(options?.offset ?? 0))
    const limit = Math.max(1, Math.floor(options?.limit ?? MAX_FILE_CHARS))
    if (offset >= raw.length) {
      return `Offset ${offset} is past end of file (length ${raw.length} chars).`
    }
    const end = Math.min(raw.length, offset + limit)
    const slice = raw.slice(offset, end)
    if (offset === 0 && end === raw.length) return slice
    if (end < raw.length) {
      return `${slice}\n...(truncated: showing chars ${offset}-${end} of ${raw.length}; pass offset=${end} to continue)`
    }
    return `${slice}\n...(chars ${offset}-${end} of ${raw.length})`
  }

  private touchReadAt(filePath: string): void {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const now = Date.now()
    let updated: string
    if (/^lastReadAt:.*$/m.test(raw)) {
      updated = raw.replace(/^lastReadAt:.*$/m, `lastReadAt: ${now}`)
    } else {
      updated = raw.replace(/^---\n/, `---\nlastReadAt: ${now}\n`)
    }
    writePrivate(filePath, updated)
  }

  delete(filename: string): boolean {
    const filePath = this.memoryFile(filename)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)

    const pattern = indexEntryPattern(filename)
    const indexContent = fs.readFileSync(this.indexPath, 'utf-8')
    const lines = indexContent.split('\n').filter((l) => !pattern.test(l))
    writePrivate(this.indexPath, lines.join('\n'))
    return true
  }

  lint(): ValidationReport<MemoryEntry>[] {
    return lintAll(this.list(), this.projectDir)
  }

  lintAsync(
    pathExists: (candidate: string) => Promise<boolean>,
  ): Promise<ValidationReport<MemoryEntry>[]> {
    return lintAllAsync(this.list(), pathExists)
  }

  /** The changing part: count and index; null when the store is empty (the fixed rules explain how to save). */
  buildIndex(maxChars = MAX_FILE_CHARS): string | null {
    const entries = this.list()
    if (entries.length === 0) return null
    const prefix = `[memory] ${entries.length} memories\n\nMemory index:\n`
    return prefix + this.loadIndex(maxChars - prefix.length)
  }

  private parseLegacyFrontmatter(
    normalized: string,
  ): { frontmatter: Record<string, unknown>; body: string } | null {
    const endIdx = normalized.indexOf('\n---', 3)
    if (endIdx === -1) return null
    const header = normalized.slice(4, endIdx)
    const afterDelim = normalized.slice(endIdx + 4)
    const body = afterDelim.replace(/^\n+/, '').trim()
    if (!body) return null
    const frontmatter: Record<string, unknown> = {}
    for (const rawLine of header.split('\n')) {
      const colon = rawLine.indexOf(':')
      if (colon <= 0) continue
      const key = rawLine.slice(0, colon).trim()
      const val = rawLine.slice(colon + 1).trim()
      if (!key) continue
      if (key === 'sources' && val.startsWith('[')) {
        try {
          frontmatter.sources = JSON.parse(val)
          continue
        } catch {
          /* fall through */
        }
      }
      frontmatter[key] = val
    }
    return { frontmatter, body }
  }

  private parseRawScalarFields(normalized: string): Map<string, string> {
    const endIdx = normalized.indexOf('\n---', 3)
    const rawScalars = new Map<string, string>()
    if (endIdx === -1) return rawScalars
    const header = normalized.slice(4, endIdx)
    for (const rawLine of header.split('\n')) {
      const colon = rawLine.indexOf(':')
      if (colon <= 0) continue
      const key = rawLine.slice(0, colon).trim()
      const val = rawLine.slice(colon + 1).trim()
      if (!key || !val) continue
      // Only treat unquoted single-line values (old writer format) as literal raw scalars.
      if (!/^["'[|>]/.test(val)) {
        rawScalars.set(key, val)
      }
    }
    return rawScalars
  }

  private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
    try {
      const normalized = raw.replace(/\r\n/g, '\n')
      if (!normalized.startsWith('---\n')) return null
      const rawScalars = this.parseRawScalarFields(normalized)
      let frontmatter: Record<string, unknown>
      let body: string
      try {
        const parsed = parseFrontmatter(normalized)
        frontmatter = parsed.frontmatter
        body = parsed.body
      } catch {
        const legacy = this.parseLegacyFrontmatter(normalized)
        if (!legacy) return null
        frontmatter = legacy.frontmatter
        body = legacy.body
      }
      if (!body) return null

      const coerceScalar = (key: string, value: unknown): string => {
        const rawFallback = rawScalars.get(key)
        if (rawFallback !== undefined) return rawFallback
        if (typeof value === 'string') return value.trim()
        if (typeof value === 'number' || typeof value === 'boolean') {
          return String(value)
        }
        return ''
      }
      const name = coerceScalar('name', frontmatter.name)
      const type = coerceScalar('type', frontmatter.type)
      const validTypes = ['user', 'feedback', 'project', 'reference']
      if (!name || !type || !validTypes.includes(type)) return null

      const description = coerceScalar('description', frontmatter.description)
      let sources: string[] | undefined
      if (
        Array.isArray(frontmatter.sources) &&
        frontmatter.sources.every((item) => typeof item === 'string')
      ) {
        sources = frontmatter.sources.slice(-5)
      }
      const lastWriteAt =
        typeof frontmatter.lastWriteAt === 'number' ||
        typeof frontmatter.lastWriteAt === 'string'
          ? Number(frontmatter.lastWriteAt)
          : undefined
      const lastReadAt =
        typeof frontmatter.lastReadAt === 'number' ||
        typeof frontmatter.lastReadAt === 'string'
          ? Number(frontmatter.lastReadAt)
          : undefined

      return {
        ...(sources ? { sources } : {}),
        name,
        description,
        type: type as MemoryEntry['type'],
        content: body,
        lastWriteAt:
          lastWriteAt !== undefined && Number.isFinite(lastWriteAt)
            ? lastWriteAt
            : undefined,
        lastReadAt:
          lastReadAt !== undefined && Number.isFinite(lastReadAt)
            ? lastReadAt
            : undefined,
      }
    } catch {
      return null
    }
  }
}
