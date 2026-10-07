import fs from 'node:fs'
import path from 'node:path'

export interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  content: string
  dirPath: string
}

const SKILL_FILE = 'SKILL.md'

export class SkillLoader {
  private skills = new Map<string, SkillDefinition>()

  /** `dirs`：skill 目录（每个子目录一个 SKILL.md），后面目录里的同名 skill 覆盖前面的 */
  constructor(private readonly dirs: readonly string[] = ['.skills']) {}

  load(): SkillDefinition[] {
    this.skills.clear()
    for (const dir of this.dirs) this.loadDir(dir)
    return this.list()
  }

  private loadDir(skillsDir: string): void {
    if (!fs.existsSync(skillsDir)) return

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillFile = path.join(skillsDir, entry.name, SKILL_FILE)
      if (!fs.existsSync(skillFile)) continue

      const raw = fs.readFileSync(skillFile, 'utf-8')
      const parsed = this.parseFrontmatter(raw)
      if (!parsed) continue

      const skill: SkillDefinition = {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(skillsDir, entry.name),
      }
      this.skills.set(skill.name, skill)
    }
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  buildPromptSection(activeSkills: ReadonlySet<string>): string | null {
    if (this.skills.size === 0) return null

    // Codex 模式：system prompt 只放 skill 索引（name + description）。
    // 正文永不进 system prompt —— 触发时由 /<skill-name> 以消息注入一次，
    // 避免正文在 system prompt 与对话消息中各出现一次。
    const lines = ['可用的 Skills（输入 /skill load <name> 或直接 /<name> 激活）：']

    for (const skill of this.list()) {
      const hint = skill.whenToUse ? ` (适用场景: ${skill.whenToUse})` : ''
      const active = activeSkills.has(skill.name) ? ' ✓ 已激活' : ''
      lines.push(`  /${skill.name} — ${skill.description}${hint}${active}`)
    }

    return lines.join('\n')
  }

  private parseFrontmatter(
    raw: string,
  ): { description: string; whenToUse?: string; content: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match || !match?.[1] || !match?.[2])
      return { description: '', content: raw }

    const meta: Record<string, string> = {}
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        const key = line.slice(0, idx).trim()
        let value = line.slice(idx + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        meta[key] = value
      }
    }

    return {
      description: meta.description || '',
      whenToUse: meta.when_to_use || undefined,
      content: match[2].trim(),
    }
  }
}
