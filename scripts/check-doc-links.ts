/** Relative Markdown links in the repo's own docs must point at a file, and at a heading when they carry a #fragment. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { $ } from 'bun'

const FENCE = /^(```|~~~)/

/** Prose lines only: links inside fenced code are examples, not navigation. */
function prose(markdown: string): string[] {
  const lines: string[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line.trimStart())) fenced = !fenced
    else if (!fenced) lines.push(line)
  }
  return lines
}

/** GitHub's heading anchors, plus explicit `<a id="…">` targets. */
export function anchors(markdown: string): Set<string> {
  const found = new Set<string>()
  for (const line of prose(markdown)) {
    for (const id of line.matchAll(/<a\s+id="([^"]+)"/g)) found.add(id[1]!)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (!heading) continue
    const slug = heading[1]!
      .trim()
      .toLowerCase()
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[^\p{L}\p{N}\- _]/gu, '')
      .replace(/ /g, '-')
    let unique = slug
    for (let n = 1; found.has(unique); n++) unique = `${slug}-${n}`
    found.add(unique)
  }
  return found
}

/** Broken links in one file, as `target: reason`. `read` returns undefined for a missing file. */
export function brokenLinks(
  file: string,
  markdown: string,
  read: (path: string) => string | undefined,
): string[] {
  const broken: string[] = []
  for (const line of prose(markdown))
    for (const link of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = link[1]!
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      const [path, fragment] = target.split('#') as [string, string?]
      const resolved = path ? resolve(dirname(file), path) : file
      const content = path ? read(resolved) : markdown
      if (content === undefined) broken.push(`${target}: no such file`)
      else if (
        fragment &&
        resolved.endsWith('.md') &&
        !anchors(content).has(fragment)
      )
        broken.push(`${target}: no such heading`)
    }
  return broken
}

/** Every tracked Markdown file under `root`; returns `file: target: reason` lines. */
export async function checkDocLinks(root: string): Promise<string[]> {
  const problems: string[] = []
  const cache = new Map<string, string | undefined>()
  const read = (path: string) => {
    if (!cache.has(path)) cache.set(path, existsSync(path) ? '' : undefined)
    return cache.get(path)
  }
  // Tracked files only: the build copies docs/ and examples/ into packages/vela/, gitignored.
  const tracked = await $`git ls-files -z -- '*.md'`.cwd(root).text()
  const files = tracked.split('\0').filter(Boolean)
  for (const file of files)
    cache.set(join(root, file), await readFile(join(root, file), 'utf8'))
  for (const file of files.sort())
    for (const problem of brokenLinks(
      join(root, file),
      cache.get(join(root, file))!,
      read,
    ))
      problems.push(`${relative(root, join(root, file))}: ${problem}`)
  return problems
}
