/** What the model reads of a command's output, same as pi: the last 2000 lines or 50KB, whichever is smaller */
export const OUTPUT_MAX_LINES = 2000
export const OUTPUT_MAX_BYTES = 50 * 1024

export interface OutputTailFit {
  text: string
  /** Lines in `text`, after the cut */
  lines: number
  truncated: boolean
  /** The first line was cut: one line longer than the limit keeps its cut end */
  partialLine: boolean
}

/**
 * The tail of `text` within both limits, cut at line starts. `headCut` says bytes before `text`
 * were already dropped, so its first line is partial. A cut may land inside a UTF-8 sequence; the
 * replacement character it decodes to is dropped.
 */
export function fitOutputTail(text: string, headCut = false): OutputTailFit {
  let body = text
  let truncated = headCut
  if (Buffer.byteLength(body) > OUTPUT_MAX_BYTES) {
    body = Buffer.from(body).subarray(-OUTPUT_MAX_BYTES).toString()
    truncated = true
  }
  let partialLine = false
  if (truncated) {
    body = body.replace(/^\uFFFD+/, '')
    // Drop the partial first line; one huge line keeps its cut end (like bash)
    const newline = body.indexOf('\n')
    if (newline === -1 || newline === body.length - 1) partialLine = true
    else body = body.slice(newline + 1)
  }
  const endsWithNewline = body.endsWith('\n')
  const lines = body.split('\n')
  if (endsWithNewline) lines.pop()
  if (lines.length > OUTPUT_MAX_LINES) {
    body =
      lines.slice(lines.length - OUTPUT_MAX_LINES).join('\n') +
      (endsWithNewline ? '\n' : '')
    truncated = true
    lines.splice(0, lines.length - OUTPUT_MAX_LINES)
  }
  return { text: body, lines: lines.length, truncated, partialLine }
}
