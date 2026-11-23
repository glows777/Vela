import { extname } from 'node:path'
import type { LarkMessageEvent } from './transport.ts'

/**
 * Text and attachment placeholders, with `@` mentions removed; undefined for unsupported
 * types. Malformed content counts as empty.
 */
export function messageText(
  message: LarkMessageEvent['message'],
): string | undefined {
  if (!['text', 'post', 'image', 'file'].includes(message.message_type))
    return undefined
  let content: unknown
  try {
    content = JSON.parse(message.content)
  } catch {
    return ''
  }
  if (!content || typeof content !== 'object') return ''
  if (message.message_type === 'image')
    return imageKeys(message).length ? '[image]' : ''
  if (message.message_type === 'file')
    return `[file: ${safeName(String((content as { file_name?: unknown }).file_name ?? 'file'))}]`
  let text =
    message.message_type === 'text'
      ? String((content as { text?: unknown }).text ?? '')
      : postText(content)
  // Strip @ mention markers (`@_user_1`)
  for (const mention of message.mentions ?? [])
    text = text.replaceAll(mention.key, '')
  return text.trim() || (imageKeys(message).length ? '[image]' : '')
}

/** A post is `{ title, content: [[element]] }`, possibly wrapped in a language key (`{ zh_cn: {...} }`) */
function postText(content: object): string {
  const post = ('content' in content ? content : Object.values(content)[0]) as
    | { title?: unknown; content?: unknown }
    | undefined
  if (!post || typeof post !== 'object') return ''
  const lines = Array.isArray(post.content)
    ? post.content.map((line) =>
        Array.isArray(line)
          ? line
              .map((element: { tag?: string; text?: unknown }) =>
                // `at` elements are mentions, images and media have no text
                element?.tag === 'text' ||
                element?.tag === 'a' ||
                element?.tag === 'code_block'
                  ? String(element.text ?? '')
                  : '',
              )
              .join('')
          : '',
      )
    : []
  const title = typeof post.title === 'string' && post.title ? [post.title] : []
  return [...title, ...lines].join('\n')
}

export function safeName(name: string, maxBytes = 255): string {
  const clean =
    (name.split(/[\\/]/).at(-1) ?? '')
      .replaceAll('..', '')
      .replace(/[:?*"<>|]/g, '_')
      .split('')
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join('')
      .replace(/[. ]+$/, '') || 'file'
  const suffix = extname(clean)
  const extension = utf8Prefix(suffix, 32)
  return (
    (
      utf8Prefix(
        clean.slice(0, clean.length - suffix.length),
        maxBytes - Buffer.byteLength(extension),
      ) + extension
    ).replace(/[. ]+$/, '') || 'file'
  )
}

function utf8Prefix(text: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > maxBytes) break
    result += char
  }
  return result
}

export function imageKeys(message: LarkMessageEvent['message']): string[] {
  if (message.message_type !== 'image' && message.message_type !== 'post')
    return []
  let content: unknown
  try {
    content = JSON.parse(message.content)
  } catch {
    return []
  }
  if (!content || typeof content !== 'object') return []
  if (message.message_type === 'image')
    return 'image_key' in content && typeof content.image_key === 'string'
      ? [content.image_key]
      : []
  const post = 'content' in content ? content : Object.values(content)[0]
  if (
    !post ||
    typeof post !== 'object' ||
    !('content' in post) ||
    !Array.isArray(post.content)
  )
    return []
  return post.content.flatMap((line: unknown) =>
    Array.isArray(line)
      ? line.flatMap((element) =>
          element?.tag === 'img' && typeof element.image_key === 'string'
            ? [element.image_key]
            : [],
        )
      : [],
  )
}
