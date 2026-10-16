import { readFile, stat } from 'node:fs/promises'
import { imageMimeType } from '../images/metadata.ts'
import type { ImageContent } from '../messages.ts'

/** Command-line attachments are added to the first prompt, like pi. Core normalizes images once. */
export async function readAttachments(paths: string[]): Promise<{
  text: string
  images: ImageContent[]
}> {
  const text: string[] = []
  const images: ImageContent[] = []
  for (const path of paths) {
    try {
      if (!(await stat(path)).isFile()) throw new Error('Not a regular file')
      const bytes = await readFile(path)
      const mimeType = imageMimeType(bytes)
      if (mimeType)
        images.push({ type: 'image', data: bytes.toString('base64'), mimeType })
      else {
        const name = path
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
        text.push(`<file name="${name}">\n${bytes.toString('utf8')}\n</file>`)
      }
    } catch (error) {
      throw new Error(
        `Cannot attach ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { text: text.join('\n\n'), images }
}
