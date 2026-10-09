import fs from 'node:fs'
import path from 'node:path'
import type { VelaLogger } from '../../index.ts'
import { bm25Search, type SearchHit } from './search.ts'
import { lintAll, type ValidationReport } from './validator.ts'

export interface MemoryEntry {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  content: string
  filePath: string
  lastWriteAt?: number
  lastReadAt?: number
}

const INDEX_FILE = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_FILE_CHARS = 4000
const STALE_DAYS = 30

/** Writes a memory file readable only by the owner (0600, like session files); also tightens an existing file. */
function writePrivate(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

export class MemoryStore {
  /**
   * `memoryDir`: directory holding the memory files and MEMORY.md (the memory extension uses `<dataDir>/memory`).
   * `projectDir`: base for relative paths when lint checks whether paths mentioned in memories still exist.
   */
  constructor(
    private readonly memoryDir: string,
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
  ): string {
    this.init()
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '')
    const filename = `${entry.type}_${slug}.md`
    const filePath = path.join(this.memoryDir, filename)
    const now = Date.now()

    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      `lastWriteAt: ${now}`,
      `lastReadAt: ${now}`,
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

    const existingIdx = lines.findIndex((l) => l.includes(`(${filename})`))
    const newLine = `- [${name}](${filename}) — ${description}`

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine
    } else {
      if (lines.length >= MAX_INDEX_LINES) {
        this.logger?.info(
          `[memory] Index reached the ${MAX_INDEX_LINES}-line limit; removing the oldest entry`,
        )
        const firstEntry = lines.findIndex((l) => l.startsWith('- '))
        if (firstEntry >= 0) lines.splice(firstEntry, 1)
      }
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

  search(query: string, topK = 5): SearchHit[] {
    return bm25Search(this.list(), query, topK)
  }

  loadIndex(): string {
    this.init()
    const raw = fs.readFileSync(this.indexPath, 'utf-8')
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(truncated)'
      : raw
  }

  loadFile(filename: string): string | null {
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return null
    this.touchReadAt(filename)
    const raw = fs.readFileSync(filePath, 'utf-8')
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(truncated)'
      : raw
  }

  private touchReadAt(filename: string): void {
    const filePath = path.join(this.memoryDir, filename)
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
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)

    const indexContent = fs.readFileSync(this.indexPath, 'utf-8')
    const lines = indexContent
      .split('\n')
      .filter((l) => !l.includes(`(${filename})`))
    writePrivate(this.indexPath, lines.join('\n'))
    return true
  }

  lint(): ValidationReport[] {
    return lintAll(this.list(), this.projectDir)
  }

  buildPromptSection(): string {
    this.init()
    const index = this.loadIndex()
    const entries = this.list()

    if (entries.length === 0) {
      return '[memory] No memories stored yet. Use the memory tool to save important information.'
    }

    const lines = [
      `[memory] ${entries.length} memories`,
      '',
      'Memory index:',
      index,
      '',
      "Use the memory tool's read action to read a memory; search for BM25 search; lint to check the store's health.",
      '',
      'How to use memory:',
      '- Memories are leads, not facts: verify with tools before relying on them (read_file, grep to confirm paths and content still exist)',
      '- Do not store what the code shows (tech stack, directory layout), what git can tell (who changed what), or what docs already say',
      '- Store only information from the conversation that cannot be derived elsewhere (user preferences, corrections, project decisions, external resources)',
    ]
    return lines.join('\n')
  }

  private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null
    if (!match[1] || !match[2]) {
      return null
    }

    const meta: Record<string, string> = {}
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }

    const validTypes = ['user', 'feedback', 'project', 'reference']
    if (!meta.name || !meta.type || !validTypes.includes(meta.type)) return null

    return {
      name: meta.name,
      description: meta.description || '',
      type: meta.type as MemoryEntry['type'],
      content: match[2].trim(),
      lastWriteAt: meta.lastWriteAt ? Number(meta.lastWriteAt) : undefined,
      lastReadAt: meta.lastReadAt ? Number(meta.lastReadAt) : undefined,
    }
  }
}
