import path from 'node:path'
import { parseFrontmatter } from '../prompt/frontmatter.ts'

/** A skill in the Agent Skills format (same fields as pi's `Skill`). The body is read from `filePath` when used. */
export interface SkillDefinition {
  /** Frontmatter `name`, or the skill directory's name */
  name: string
  description: string
  /** Absolute path of the skill file (usually `SKILL.md`) */
  filePath: string
  /** Directory the skill's relative paths resolve against */
  baseDir: string
  /** `disable-model-invocation: true`: not listed to the model, only `/skill:<name>` runs it */
  disableModelInvocation: boolean
}

/** A problem found while loading resources (skipped skill, invalid name, name collision, ...). */
export interface ResourceDiagnostic {
  message: string
  path: string
}

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024

/** Apply the same skill metadata and warning rules to host and workspace files. */
export function parseSkill(
  filePath: string,
  content: string,
  report: (problem: ResourceDiagnostic) => void,
): SkillDefinition | undefined {
  const declared = path.basename(filePath) === 'SKILL.md'
  let frontmatter: Record<string, unknown>
  try {
    ;({ frontmatter } = parseFrontmatter(content))
  } catch (error) {
    if (declared) report({ message: (error as Error).message, path: filePath })
    return
  }
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description.trim()
      : ''
  // A plain .md file without a description is just a document, not a skill
  if (!description) {
    if (declared)
      report({
        message: 'description is required; skipped',
        path: filePath,
      })
    return
  }
  if (description.length > MAX_DESCRIPTION_LENGTH)
    report({
      message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
      path: filePath,
    })
  const baseDir = path.dirname(filePath)
  const name =
    typeof frontmatter.name === 'string' && frontmatter.name
      ? frontmatter.name
      : declared
        ? path.basename(baseDir)
        : path.basename(filePath, '.md')
  for (const message of nameProblems(name)) report({ message, path: filePath })
  return {
    name,
    description,
    filePath,
    baseDir,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
  }
}

/** Agent Skills naming rules; violations are warnings only (the skill still loads, like pi). */
function nameProblems(name: string): string[] {
  const problems: string[] = []
  if (name.length > MAX_NAME_LENGTH)
    problems.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`)
  if (!/^[a-z0-9-]+$/.test(name))
    problems.push(
      'name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)',
    )
  if (name.startsWith('-') || name.endsWith('-'))
    problems.push('name must not start or end with a hyphen')
  if (name.includes('--'))
    problems.push('name must not contain consecutive hyphens')
  return problems
}
