import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ResourceDiagnostic } from '../skills/loader.ts'
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

/**
 * Loads templates from `.md` files in the given directories (not recursive) or given `.md` files, like pi
 * (`core/prompt-templates.ts`). Missing paths are skipped. A later template with the same name is dropped.
 */
export function loadPromptTemplates(paths: readonly string[]): {
  templates: PromptTemplate[]
  diagnostics: ResourceDiagnostic[]
} {
  const templates = new Map<string, PromptTemplate>()
  const diagnostics: ResourceDiagnostic[] = []
  const add = (filePath: string) => {
    const result = loadTemplate(filePath)
    if ('message' in result) return diagnostics.push(result)
    const existing = templates.get(result.name)
    if (existing)
      return diagnostics.push({
        message: `prompt template name "${result.name}" is already used by ${existing.filePath}; skipped`,
        path: filePath,
      })
    templates.set(result.name, result)
  }
  for (const entry of paths) {
    const path = resolve(entry)
    if (!existsSync(path)) continue
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        const file = join(path, name)
        if (name.endsWith('.md') && isFile(file)) add(file)
      }
    } else if (path.endsWith('.md')) add(path)
  }
  return { templates: [...templates.values()], diagnostics }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function loadTemplate(filePath: string): PromptTemplate | ResourceDiagnostic {
  let frontmatter: Record<string, unknown>
  let body: string
  try {
    ;({ frontmatter, body } = parseFrontmatter(readFileSync(filePath, 'utf-8')))
  } catch (error) {
    return { message: (error as Error).message, path: filePath }
  }
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
    name: basename(filePath, '.md'),
    description,
    ...(typeof hint === 'string' && hint ? { argumentHint: hint } : {}),
    content: body,
    filePath,
  }
}

/** Splits arguments like a shell: whitespace separates, single or double quotes group (same as pi). */
export function parseCommandArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") quote = char
    else if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else current += char
  }
  if (current) args.push(current)
  return args
}

/**
 * Replaces placeholders like pi: `$1` `$2` …, `$@` / `$ARGUMENTS` (all args), `${N:-default}`,
 * `${@:-default}`, `${@:N}` (from the Nth on), `${@:N:L}` (L args from the Nth). Values are not substituted again.
 */
export function substituteArgs(content: string, args: string[]): string {
  const all = args.join(' ')
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultTarget) {
        const value =
          defaultTarget === '@' || defaultTarget === 'ARGUMENTS'
            ? all
            : args[Number.parseInt(defaultTarget, 10) - 1]
        return value ? value : defaultValue
      }
      if (sliceStart) {
        const start = Math.max(Number.parseInt(sliceStart, 10) - 1, 0)
        return (
          sliceLength
            ? args.slice(start, start + Number.parseInt(sliceLength, 10))
            : args.slice(start)
        ).join(' ')
      }
      if (simple === 'ARGUMENTS' || simple === '@') return all
      return args[Number.parseInt(simple, 10) - 1] ?? ''
    },
  )
}

/** `/<name> args` → the template's body with args substituted; undefined when no template has that name. */
export function expandPromptTemplate(
  text: string,
  templates: readonly PromptTemplate[],
): string | undefined {
  if (!text.startsWith('/')) return
  const space = text.search(/\s/)
  const name = space === -1 ? text.slice(1) : text.slice(1, space)
  const template = templates.find((t) => t.name === name)
  if (!template) return
  const args = space === -1 ? '' : text.slice(space + 1)
  return substituteArgs(template.content, parseCommandArgs(args))
}
