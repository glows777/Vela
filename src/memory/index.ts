import fs from "node:fs"
import path from "node:path"

export interface MemoryEntry {
  name: string
  description: string
  type: "user" | "feedback" | "project" | "reference"
  content: string
  filePath: string
}

const MEMORY_DIR = ".memory"
const INDEX_FILE = "MEMORY.md"
const MAX_INDEX_LINES = 200
const MAX_FILE_CHARS = 4000

export class MemoryStore {
  private readonly baseDir: string

  constructor(baseDir: string = ".") {
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
      fs.writeFileSync(this.indexPath, "# Memory Index\n", "utf-8")
    }
  }

  save(entry: Omit<MemoryEntry, "filePath">): string {
    this.init()
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-|-$/g, "")
    const filename = `${entry.type}_${slug}.md`
    const filePath = path.join(this.memoryDir, filename)

    const fileContent = [
      "---",
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      "---",
      "",
      entry.content,
    ].join("\n")

    fs.writeFileSync(filePath, fileContent, "utf-8")
    this.updateIndex(entry.name, filename, entry.description)
    return filename
  }

  private updateIndex(
    name: string,
    filename: string,
    description: string,
  ): void {
    const indexContent = fs.readFileSync(this.indexPath, "utf-8")
    const lines = indexContent.split("\n")

    const existingIdx = lines.findIndex((l) => l.includes(`(${filename})`))
    const newLine = `- [${name}](${filename}) — ${description}`

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine
    } else {
      if (lines.length >= MAX_INDEX_LINES) {
        console.log(
          `[memory] Index reached the ${MAX_INDEX_LINES}-line limit; removing the oldest entry`,
        )
        const firstEntry = lines.findIndex((l) => l.startsWith("- "))
        if (firstEntry >= 0) lines.splice(firstEntry, 1)
      }
      lines.push(newLine)
    }

    fs.writeFileSync(this.indexPath, lines.join("\n"), "utf-8")
  }

  list(): MemoryEntry[] {
    this.init()
    const entries: MemoryEntry[] = []
    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md") && f !== INDEX_FILE)

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file)
      const raw = fs.readFileSync(filePath, "utf-8")
      const parsed = this.parseFrontmatter(raw)
      if (parsed) {
        entries.push({ ...parsed, filePath })
      }
    }
    return entries
  }

  search(query: string): MemoryEntry[] {
    const all = this.list()
    const keywords = query.toLowerCase().split(/\s+/)
    return all.filter((entry) => {
      const text =
        `${entry.name} ${entry.description} ${entry.content}`.toLowerCase()
      return keywords.some((kw) => text.includes(kw))
    })
  }

  loadIndex(): string {
    this.init()
    const raw = fs.readFileSync(this.indexPath, "utf-8")
    return raw.length > MAX_FILE_CHARS
      ? `${raw.slice(0, MAX_FILE_CHARS)}\n...(truncated)`
      : raw
  }

  loadFile(filename: string): string | null {
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, "utf-8")
    return raw.length > MAX_FILE_CHARS
      ? `${raw.slice(0, MAX_FILE_CHARS)}\n...(truncated)`
      : raw
  }

  delete(filename: string): boolean {
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)

    const indexContent = fs.readFileSync(this.indexPath, "utf-8")
    const lines = indexContent
      .split("\n")
      .filter((l) => !l.includes(`(${filename})`))
    fs.writeFileSync(this.indexPath, lines.join("\n"), "utf-8")
    return true
  }

  buildPromptSection(): string {
    this.init()
    const index = this.loadIndex()
    const entries = this.list()

    if (entries.length === 0) {
      return "[Memory system] No memories are currently stored. Use the memory tool to save important information."
    }

    const lines = [
      `[Memory system] ${entries.length} memories available`,
      "",
      "Memory index:",
      index,
      "",
      "Use the memory tool's read action to load a specific memory.",
      // Important: Remind the model not to treat memory content as fact; use it as a lead to verify.
      "Memories are clues, not facts—verify their accuracy before relying on them.",
    ]
    return lines.join("\n")
  }

  private parseFrontmatter(raw: string): Omit<MemoryEntry, "filePath"> | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match?.[1] || !match?.[2]) return null

    const meta: Record<string, string> = {}
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":")
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }

    const validTypes = ["user", "feedback", "project", "reference"]
    if (!meta.name || !meta.type || !validTypes.includes(meta.type)) return null

    return {
      name: meta.name,
      description: meta.description || "",
      type: meta.type as MemoryEntry["type"],
      content: match[2].trim(),
    }
  }
}
