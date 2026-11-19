/** What the model reads of a command's output, same as pi: the last 2000 lines or 50KB, whichever is smaller */
export const OUTPUT_MAX_LINES = 2000
export const OUTPUT_MAX_BYTES = 50 * 1024

/** In-memory output tail; a command that prints forever only ever costs this buffer. */
export class OutputTail {
  private chunks: string[] = []
  private retained = 0
  private total = 0
  private cut = false

  /** Everything the command wrote, whether or not the retained tail still holds it */
  get bytes(): number {
    return this.total
  }

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    const size = Buffer.byteLength(chunk)
    this.retained += size
    this.total += size
    if (this.retained > OUTPUT_MAX_BYTES * 2) this.compact()
  }

  private compact(): void {
    // Keep enough bytes for the limit, then let read() cut both limits.
    const buffer = Buffer.from(this.text())
    const kept = buffer
      .subarray(buffer.length - OUTPUT_MAX_BYTES * 2)
      .toString()
    this.chunks = [kept]
    this.retained = Buffer.byteLength(kept)
    this.cut = true
  }

  private text(): string {
    return this.chunks.join('')
  }

  /** The tail within both limits; `truncated` means older output was dropped. */
  read(): OutputTailFit {
    return fitOutputTail(this.text(), this.cut)
  }
}

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
function fitOutputTail(text: string, headCut = false): OutputTailFit {
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
