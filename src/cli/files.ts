import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { imageMimeType } from '../images/metadata.ts'
import type { ImageContent } from '../messages.ts'

/** Command-line attachments are added to the first prompt, like pi. Core normalizes images once. */
export async function readAttachments(paths: string[]): Promise<{
  text: string
  images: ImageContent[]
}> {
  const text: string[] = []
  const images: ImageContent[] = []
  for (const input of paths) {
    try {
      const path = resolveReadPath(input)
      if (!(await stat(path)).isFile()) throw new Error('Not a regular file')
      const bytes = await readFile(path)
      const mimeType = imageMimeType(bytes)
      const name = path
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
      if (mimeType) {
        text.push(`<file name="${name}"></file>`)
        images.push({ type: 'image', data: bytes.toString('base64'), mimeType })
      } else {
        const content = bytes.toString('utf8').replace(/^\ufeff/, '')
        if (content) text.push(`<file name="${name}">\n${content}\n</file>`)
      }
    } catch (error) {
      throw new Error(
        `Cannot attach ${input}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { text: text.join('\n\n'), images }
}

/** Shells don't expand ~ after @; screenshot names may use a narrow space before AM/PM. */
function resolveReadPath(input: string): string {
  const path = resolve(
    input === '~'
      ? homedir()
      : input.startsWith('~/') ||
          (process.platform === 'win32' && input.startsWith('~\\'))
        ? join(homedir(), input.slice(2))
        : input,
  )
  // Prefer an exact filename when both space variants exist.
  return (
    [
      path,
      path.replace(/[\u00a0\u202f]/g, ' '),
      path.replace(/ (?=[AP]M\.)/g, '\u202f'),
    ].find((candidate) => existsSync(candidate)) ?? path
  )
}
