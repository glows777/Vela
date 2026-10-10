import { diffWords } from 'diff'
import { theme } from './theme.ts'

/**
 * Colors an edit_file display diff (`+12 added`, `-12 removed`, ` 12 context`, `   ...`) like pi's
 * renderDiff (`modes/interactive/components/diff.ts`): removed lines red, added lines green, and
 * when one line was replaced by one line, the changed words inverted.
 */
export function renderDiff(diffText: string): string {
  const lines = diffText.split('\n')
  const result: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const parsed = parseDiffLine(line)
    if (!parsed) {
      result.push(theme.fg('muted', line))
      i++
    } else if (parsed.prefix === '-') {
      const removed = collect(lines, i, '-')
      i += removed.length
      const added = collect(lines, i, '+')
      i += added.length
      // Word-level highlighting only for a single modified line
      if (removed.length === 1 && added.length === 1) {
        const [old, next] = [removed[0]!, added[0]!]
        const words = intraLineDiff(
          replaceTabs(old.content),
          replaceTabs(next.content),
        )
        result.push(theme.fg('red', `-${old.lineNum} ${words.removed}`))
        result.push(theme.fg('green', `+${next.lineNum} ${words.added}`))
      } else {
        for (const r of removed)
          result.push(
            theme.fg('red', `-${r.lineNum} ${replaceTabs(r.content)}`),
          )
        for (const a of added)
          result.push(
            theme.fg('green', `+${a.lineNum} ${replaceTabs(a.content)}`),
          )
      }
    } else if (parsed.prefix === '+') {
      result.push(
        theme.fg('green', `+${parsed.lineNum} ${replaceTabs(parsed.content)}`),
      )
      i++
    } else {
      result.push(
        theme.fg('muted', ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`),
      )
      i++
    }
  }
  return result.join('\n')
}

interface DiffLine {
  prefix: string
  lineNum: string
  content: string
}

function parseDiffLine(line: string): DiffLine | null {
  const match = /^([+\-\s])(\s*\d*)\s(.*)$/.exec(line)
  return match
    ? { prefix: match[1]!, lineNum: match[2]!, content: match[3]! }
    : null
}

function collect(lines: string[], start: number, prefix: string): DiffLine[] {
  const found: DiffLine[] = []
  for (let i = start; i < lines.length; i++) {
    const parsed = parseDiffLine(lines[i] as string)
    if (!parsed || parsed.prefix !== prefix) break
    found.push(parsed)
  }
  return found
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, '   ')
}

/** Inverts the changed words; leading whitespace of the first change stays plain so indentation isn't highlighted. */
function intraLineDiff(
  oldContent: string,
  newContent: string,
): { removed: string; added: string } {
  let removed = ''
  let added = ''
  let firstRemoved = true
  let firstAdded = true
  for (const part of diffWords(oldContent, newContent)) {
    if (part.removed || part.added) {
      let value = part.value
      const first = part.removed ? firstRemoved : firstAdded
      let lead = ''
      if (first) {
        lead = /^(\s*)/.exec(value)?.[1] ?? ''
        value = value.slice(lead.length)
      }
      const text = lead + (value ? theme.inverse(value) : '')
      if (part.removed) {
        removed += text
        firstRemoved = false
      } else {
        added += text
        firstAdded = false
      }
    } else {
      removed += part.value
      added += part.value
    }
  }
  return { removed, added }
}
