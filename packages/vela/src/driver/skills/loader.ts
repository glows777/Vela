import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../prompt/frontmatter.ts'
import {
  parseSkill,
  type ResourceDiagnostic,
  type SkillDefinition,
} from './definition.ts'

export type { ResourceDiagnostic, SkillDefinition } from './definition.ts'

const SKILL_FILE = 'SKILL.md'

/**
 * Loads skills like pi (`core/skills.ts`): a directory containing `SKILL.md` is one skill (not searched further);
 * otherwise subdirectories are searched, and `.md` files directly in a listed directory with a `description`
 * are skills too. `.`-prefixed entries and `node_modules` are skipped. On a name collision the first one wins.
 */
export class SkillLoader {
  private skills = new Map<string, SkillDefinition>()
  private problems: ResourceDiagnostic[] = []

  /** `paths`: skill directories or `.md` files, in priority order (the first skill with a name wins) */
  constructor(private readonly paths: readonly string[] = ['.skills']) {}

  load(): SkillDefinition[] {
    this.skills.clear()
    this.problems = []
    const seenFiles = new Set<string>()
    for (const entry of this.paths) {
      const resolved = path.resolve(entry)
      let isDir = false
      try {
        if (!fs.existsSync(resolved)) continue
        isDir = fs.statSync(resolved).isDirectory()
      } catch (error) {
        this.problems.push({
          message: `could not inspect skill path: ${(error as Error).message}`,
          path: resolved,
        })
        continue
      }
      const found = isDir
        ? this.loadDir(resolved, true)
        : resolved.endsWith('.md')
          ? [this.loadFile(resolved)].filter((s) => s !== undefined)
          : []
      for (const skill of found) {
        const real = fs.realpathSync(skill.filePath)
        // The same file reached twice (e.g. via a symlink) is not a collision
        if (seenFiles.has(real)) continue
        const existing = this.skills.get(skill.name)
        if (existing) {
          this.problems.push({
            message: `skill name "${skill.name}" is already used by ${existing.filePath}; skipped`,
            path: skill.filePath,
          })
          continue
        }
        seenFiles.add(real)
        this.skills.set(skill.name, skill)
      }
    }
    return this.list()
  }

  /** Problems found by the last load() (skills skipped or loaded with warnings) */
  get diagnostics(): readonly ResourceDiagnostic[] {
    return this.problems
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  /**
   * The `<skills>` section's content of the system prompt (same text as pi's formatSkillsForPrompt, untagged): name,
   * description and file location of each skill the model may use, which it loads with `readTool` when a task matches.
   * Null when no skill is listed or the session has no tool that can read the file.
   */
  buildPromptSection(activeTools: readonly string[]): string | null {
    return formatSkillsForPrompt(this.list(), activeTools)
  }

  /**
   * `/skill:<name> [args]` → the skill's body wrapped in `<skill>` plus the args (same as pi's _expandSkillCommand).
   * Returns undefined when the text is not a skill command or names no known skill; throws if the file can't be read.
   */
  expand(text: string): string | undefined {
    if (!text.startsWith('/skill:')) return
    const space = text.search(/\s/)
    const name = space === -1 ? text.slice(7) : text.slice(7, space)
    const skill = this.skills.get(name)
    if (!skill) return
    return expandHostSkill(text, skill)
  }

  private loadDir(dir: string, includeRootFiles: boolean): SkillDefinition[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    if (entries.some((e) => e.name === SKILL_FILE && isFile(dir, e))) {
      const skill = this.loadFile(path.join(dir, SKILL_FILE))
      return skill ? [skill] : []
    }
    const skills: SkillDefinition[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (isDirectory(dir, entry)) skills.push(...this.loadDir(full, false))
      else if (
        includeRootFiles &&
        entry.name.endsWith('.md') &&
        isFile(dir, entry)
      ) {
        const skill = this.loadFile(full)
        if (skill) skills.push(skill)
      }
    }
    return skills
  }

  private loadFile(filePath: string): SkillDefinition | undefined {
    try {
      return parseSkill(
        filePath,
        fs.readFileSync(filePath, 'utf-8'),
        (problem) => this.problems.push(problem),
      )
    } catch (error) {
      if (path.basename(filePath) === SKILL_FILE)
        this.problems.push({
          message: (error as Error).message,
          path: filePath,
        })
      return
    }
  }
}

/** Shared prompt format for host and environment resources. */
export function formatSkillsForPrompt(
  skills: readonly SkillDefinition[],
  activeTools: readonly string[],
): string | null {
  const readTool = ['read', 'bash'].find((name) => activeTools.includes(name))
  const visible = skills.filter((s) => !s.disableModelInvocation)
  if (!readTool || visible.length === 0) return null
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    readTool === 'read'
      ? "Use the read tool to load a skill's file when the task matches its description."
      : "Use bash to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ]
  for (const skill of visible) {
    lines.push(
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      '  </skill>',
    )
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

function isDirectory(dir: string, entry: fs.Dirent): boolean {
  if (!entry.isSymbolicLink()) return entry.isDirectory()
  try {
    return fs.statSync(path.join(dir, entry.name)).isDirectory()
  } catch {
    return false
  }
}

function isFile(dir: string, entry: fs.Dirent): boolean {
  if (!entry.isSymbolicLink()) return entry.isFile()
  try {
    return fs.statSync(path.join(dir, entry.name)).isFile()
  } catch {
    return false
  }
}

export function formatSkillExpansion(
  skill: SkillDefinition,
  rawContent: string,
  args: string,
): string {
  const body = parseFrontmatter(rawContent).body
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  return args ? `${block}\n\n${args}` : block
}

export function expandHostSkill(text: string, skill: SkillDefinition): string {
  const space = text.search(/\s/)
  const args = space === -1 ? '' : text.slice(space + 1).trim()
  let raw: string
  try {
    raw = fs.readFileSync(skill.filePath, 'utf-8')
  } catch (error) {
    throw new Error(
      `Could not load skill ${skill.name} from ${skill.filePath}: ${(error as Error).message}`,
    )
  }
  return formatSkillExpansion(skill, raw, args)
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
