import fs from 'node:fs'
import path from 'node:path'
import { silentLogger, type VelaLogger } from '../logger'
import { bm25Search, type SearchHit } from './search'
import { lintAll, type ValidationReport } from './validator'

export interface MemoryEntry {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  content: string
  filePath: string
  lastWriteAt?: number
  lastReadAt?: number
}

const MEMORY_DIR = '.memory'
const INDEX_FILE = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_FILE_CHARS = 4000
const STALE_DAYS = 30

export class MemoryStore {
  private readonly baseDir: string

  constructor(
    baseDir: string = '.',
    private logger: VelaLogger = silentLogger,
  ) {
    this.baseDir = baseDir
  }

  private get memoryDir(): string {
    return path.join(this.baseDir, MEMORY_DIR)
  }

  private get indexPath(): string {
    return path.join(this.memoryDir, INDEX_FILE)
  }

  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true })
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8')
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

    fs.writeFileSync(filePath, fileContent, 'utf-8')
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
        this.logger.info(
          `[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`,
        )
        const firstEntry = lines.findIndex((l) => l.startsWith('- '))
        if (firstEntry >= 0) lines.splice(firstEntry, 1)
      }
      lines.push(newLine)
    }

    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8')
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
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
      : raw
  }

  loadFile(filename: string): string | null {
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return null
    this.touchReadAt(filename)
    const raw = fs.readFileSync(filePath, 'utf-8')
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
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
    fs.writeFileSync(filePath, updated, 'utf-8')
  }

  delete(filename: string): boolean {
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)

    const indexContent = fs.readFileSync(this.indexPath, 'utf-8')
    const lines = indexContent
      .split('\n')
      .filter((l) => !l.includes(`(${filename})`))
    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8')
    return true
  }

  lint(): ValidationReport[] {
    return lintAll(this.list(), this.baseDir)
  }

  buildPromptSection(): string {
    this.init()
    const index = this.loadIndex()
    const entries = this.list()

    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。'
    }

    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引：',
      index,
      '',
      '使用 memory 工具的 read 操作来读取具体记忆内容；用 search 做 BM25 搜索；用 lint 检查记忆库健康度。',
      '',
      '记忆使用原则：',
      '- 记忆是线索，不是事实——使用前先用工具验证（read_file、grep 确认路径和内容是否还存在）',
      '- 不存代码能推导的（技术栈、目录结构）、git 能查的（谁改了什么）、文档已经写了的',
      '- 只存对话中出现的、其他地方推导不出来的信息（用户偏好、纠正反馈、项目决策、外部资源）',
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
