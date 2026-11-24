/**
 * Edit matching and diff helpers, ported from pi (pi-mono coding-agent
 * `src/core/tools/edit-diff.ts`, MIT License, Copyright (c) 2025 Mario Zechner).
 */

import * as Diff from 'diff'

/** Splits a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content }
}

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIdx = content.indexOf('\r\n')
  const lfIdx = content.indexOf('\n')
  if (lfIdx === -1) return '\n'
  if (crlfIdx === -1) return '\n'
  return crlfIdx < lfIdx ? '\r\n' : '\n'
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function restoreLineEndings(
  text: string,
  ending: '\r\n' | '\n',
): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

function normalizeFuzzyFragment(text: string): string {
  return (
    text
      .normalize('NFKC')
      // Smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens → -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      // Special spaces → regular space
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
  )
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
function normalizeForFuzzyMatch(text: string): string {
  return normalizeFuzzyFragment(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
}

interface FuzzyTextMap {
  normalized: string
  /** Original start index in `text` for each UTF-16 unit in `normalized` */
  charStarts: number[]
  /** Original end index in `text` for each UTF-16 unit in `normalized` */
  charEnds: number[]
  /** When a match ends on the last non-trailing-whitespace char of a line, consumes trailing whitespace up to EOL */
  lineTrimEnds: number[]
}

const COMBINING_MARK = /^\p{M}$/u

function normalizeForFuzzyWithMap(text: string): FuzzyTextMap {
  const normChars: string[] = []
  const charStarts: number[] = []
  const charEnds: number[] = []
  const lineTrimEnds: number[] = []
  let lineStart = 0

  while (lineStart <= text.length) {
    const nlIndex = text.indexOf('\n', lineStart)
    const lineEnd = nlIndex === -1 ? text.length : nlIndex
    const rawLine = text.slice(lineStart, lineEnd)

    // Group combining marks with their base code point so NFKC preserves source spans.
    const units: Array<{ norm: string; origStart: number; origEnd: number }> =
      []
    let i = 0
    while (i < rawLine.length) {
      const start = i
      const cp = rawLine.codePointAt(i)!
      i += cp > 0xffff ? 2 : 1
      while (i < rawLine.length) {
        const nextCp = rawLine.codePointAt(i)!
        const step = nextCp > 0xffff ? 2 : 1
        const ch = rawLine.slice(i, i + step)
        if (!COMBINING_MARK.test(ch)) break
        i += step
      }
      const norm = normalizeFuzzyFragment(rawLine.slice(start, i))
      const origStart = lineStart + start
      const origEnd = lineStart + i
      for (let j = 0; j < norm.length; j++) {
        units.push({ norm: norm[j]!, origStart, origEnd })
      }
    }

    // Match `line.trimEnd()` after NFKC normalization.
    let kept = units.length
    while (kept > 0 && /\s/.test(units[kept - 1]!.norm)) kept--

    for (let u = 0; u < kept; u++) {
      const unit = units[u]!
      normChars.push(unit.norm)
      charStarts.push(unit.origStart)
      charEnds.push(unit.origEnd)
      // Reaching the last trimmed unit on a line consumes its stripped trailing spaces.
      lineTrimEnds.push(u === kept - 1 ? lineEnd : unit.origEnd)
    }

    if (nlIndex === -1) break
    normChars.push('\n')
    charStarts.push(kept > 0 ? units[kept - 1]!.origEnd : lineStart)
    charEnds.push(nlIndex + 1)
    lineTrimEnds.push(nlIndex + 1)
    lineStart = nlIndex + 1
  }

  return {
    normalized: normChars.join(''),
    charStarts,
    charEnds,
    lineTrimEnds,
  }
}

interface MatchedEdit {
  editIndex: number
  matchIndex: number
  matchLength: number
  newText: string
}

type TextReplacement = Pick<
  MatchedEdit,
  'matchIndex' | 'matchLength' | 'newText'
>

function applyReplacements(
  content: string,
  replacements: TextReplacement[],
): string {
  let result = content
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!
    const matchIndex = replacement.matchIndex
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength)
  }
  return result
}

export interface Edit {
  oldText: string
  newText: string
}

export interface AppliedEditsResult {
  baseContent: string
  newContent: string
}

function getNotFoundError(
  path: string,
  editIndex: number,
  totalEdits: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    )
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  )
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    )
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  )
}

function getEmptyOldTextError(
  path: string,
  editIndex: number,
  totalEdits: number,
): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`)
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`)
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    )
  }
  return new Error(
    `No changes made to ${path}. The replacements produced identical content.`,
  )
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the original content first by exact substring
 * (without fuzzy occurrence pollution) and fall back to fuzzy matching mapped
 * directly back to original character offsets so untouched characters on any
 * line — including the same line — keep their original Unicode bytes.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }))

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length)
    }
  }

  let fuzzyMap: FuzzyTextMap | undefined
  const matchedEdits: MatchedEdit[] = []
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!
    const exactIndex = normalizedContent.indexOf(edit.oldText)
    if (exactIndex !== -1) {
      const exactOccurrences = normalizedContent.split(edit.oldText).length - 1
      if (exactOccurrences > 1) {
        throw getDuplicateError(
          path,
          i,
          normalizedEdits.length,
          exactOccurrences,
        )
      }
      matchedEdits.push({
        editIndex: i,
        matchIndex: exactIndex,
        matchLength: edit.oldText.length,
        newText: edit.newText,
      })
      continue
    }

    fuzzyMap ??= normalizeForFuzzyWithMap(normalizedContent)
    const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText)
    const fuzzyIndex = fuzzyOldText
      ? fuzzyMap.normalized.indexOf(fuzzyOldText)
      : -1
    if (fuzzyIndex === -1) {
      throw getNotFoundError(path, i, normalizedEdits.length)
    }
    const fuzzyOccurrences = fuzzyMap.normalized.split(fuzzyOldText).length - 1
    if (fuzzyOccurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, fuzzyOccurrences)
    }

    const fuzzyEnd = fuzzyIndex + fuzzyOldText.length
    const origStart = fuzzyMap.charStarts[fuzzyIndex]!
    const origEnd =
      fuzzyMap.lineTrimEnds[fuzzyEnd - 1] ?? fuzzyMap.charEnds[fuzzyEnd - 1]!
    matchedEdits.push({
      editIndex: i,
      matchIndex: origStart,
      matchLength: origEnd - origStart,
      newText: edit.newText,
    })
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]!
    const current = matchedEdits[i]!
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      )
    }
  }

  const baseContent = normalizedContent
  const newContent = applyReplacements(normalizedContent, matchedEdits)

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length)
  }

  return { baseContent, newContent }
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  return Diff.createTwoFilesPatch(
    path,
    path,
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context: contextLines,
      headerOptions: Diff.FILE_HEADERS_ONLY,
    },
  )
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent)
  const output: string[] = []

  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const maxLineNum = Math.max(oldLines.length, newLines.length)
  const lineNumWidth = String(maxLineNum).length

  let oldLineNum = 1
  let newLineNum = 1
  let lastWasChange = false
  let firstChangedLine: number | undefined

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const raw = part.value.split('\n')
    if (raw[raw.length - 1] === '') {
      raw.pop()
    }

    if (part.added || part.removed) {
      // Capture the first changed line (in the new file)
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum
      }

      // Show the change
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
          output.push(`+${lineNum} ${line}`)
          newLineNum++
        } else {
          // removed
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(`-${lineNum} ${line}`)
          oldLineNum++
        }
      }
      lastWasChange = true
    } else {
      // Context lines - only show a few before/after changes
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed)
      const hasLeadingChange = lastWasChange
      const hasTrailingChange = nextPartIsChange

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }
        } else {
          const leadingLines = raw.slice(0, contextLines)
          const trailingLines = raw.slice(raw.length - contextLines)
          const skippedLines =
            raw.length - leadingLines.length - trailingLines.length

          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }

          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skippedLines
          newLineNum += skippedLines

          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines)
        const skippedLines = raw.length - shownLines.length

        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(` ${lineNum} ${line}`)
          oldLineNum++
          newLineNum++
        }

        if (skippedLines > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skippedLines
          newLineNum += skippedLines
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines)
        if (skippedLines > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skippedLines
          newLineNum += skippedLines
        }

        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(` ${lineNum} ${line}`)
          oldLineNum++
          newLineNum++
        }
      } else {
        // Skip these context lines entirely
        oldLineNum += raw.length
        newLineNum += raw.length
      }

      lastWasChange = false
    }
  }

  return { diff: output.join('\n'), firstChangedLine }
}
