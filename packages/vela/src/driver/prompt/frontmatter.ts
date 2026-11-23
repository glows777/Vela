import { parse } from 'yaml'

/** Splits a markdown file into YAML frontmatter and body (same rules as pi's `utils/frontmatter.ts`); throws on invalid YAML. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const normalized = content
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  if (!normalized.startsWith('---'))
    return { frontmatter: {}, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: {}, body: normalized }
  const parsed: unknown = parse(normalized.slice(4, end))
  return {
    frontmatter:
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: normalized.slice(end + 4).trim(),
  }
}
