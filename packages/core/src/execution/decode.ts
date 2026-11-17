/* Derived from pi-durable at 0826f9f.
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
/**
 * Decoding that matches `new TextDecoder().decode(bytes)` of the whole input when the input arrives in pieces. Node's
 * streaming decoder with BOM handling can drop a U+FEFF that follows a chunk boundary, not only a leading byte-order
 * mark, so these decoders turn BOM handling off and drop a leading mark themselves.
 */

/** A streaming decoder for a byte range; callers that start at the beginning of a file skip a leading mark themselves. */
export function rangeDecoder(): InstanceType<typeof TextDecoder> {
  return new TextDecoder('utf-8', { ignoreBOM: true })
}

/** Whether decoding the whole input drops its first three bytes as a byte-order mark. */
export function startsWithBom(firstBytes: Uint8Array): boolean {
  return (
    firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf
  )
}

/** Decodes one stream chunk by chunk exactly like decoding all of it at once. */
export class StreamDecoder {
  readonly #decoder = rangeDecoder()
  #started = false

  /** Text for `bytes`, holding back an incomplete character; without `bytes`, the end of the stream. */
  decode(bytes?: Uint8Array): string {
    const text =
      bytes === undefined
        ? this.#decoder.decode()
        : this.#decoder.decode(bytes, { stream: true })
    if (this.#started || text === '') return text
    this.#started = true
    // U+FEFF encodes only as EF BB BF, so a leading U+FEFF is exactly a byte-order mark at the stream's start.
    return text.startsWith('\ufeff') ? text.slice(1) : text
  }
}
