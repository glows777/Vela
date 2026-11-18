import { parseFrontmatter } from './frontmatter.ts'

/** A prompt template: `/<name> args` expands to its body (same as pi's `PromptTemplate`). */
export interface PromptTemplate {
  /** File name without `.md` */
  name: string
  /** Frontmatter `description`, or the body's first line (at most 60 characters) */
  description: string
  /** Frontmatter `argument-hint`, shown in completion */
  argumentHint?: string
  content: string
  filePath: string
}

export function parseTemplate(
  name: string,
  filePath: string,
  source: string,
): PromptTemplate {
  const { frontmatter, body } = parseFrontmatter(source)
  let description =
    typeof frontmatter.description === 'string' ? frontmatter.description : ''
  if (!description) {
    const firstLine = body.split('\n').find((line) => line.trim())
    if (firstLine)
      description =
        firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine
  }
  const hint = frontmatter['argument-hint']
  return {
    name,
    description,
    ...(typeof hint === 'string' && hint ? { argumentHint: hint } : {}),
    content: body,
    filePath,
  }
}
