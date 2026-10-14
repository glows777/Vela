import { sep } from 'node:path'
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { SessionPersistence } from '../session/storage.ts'

const PATH_LABEL = '  Path: '
const PENDING_MARKER = 'not written yet'
const PENDING_OPEN = 'not written yet (will save to '
const CONTINUATION_INDENT = '  '
const ELLIPSIS = '…'

export interface StatusPathInput {
  persistence: SessionPersistence
  homeDir: string
  /**
   * Configured agent directory (`VELA_DIR`, or `~/.vela` when unset).
   * `$VELA_DIR` is substituted only when the session file is actually under it.
   */
  agentDir?: string
  /** Whether the session file is on disk. Missing files must not look saved. */
  isFile: (path: string) => boolean
}

/** The `Path:` value: where history is kept, without claiming a file that is not there. */
export function formatStatusPath(input: StatusPathInput): string {
  const where = input.persistence
  if (where.type === 'memory') return 'in-memory (not saved)'
  if (where.type !== 'file') return 'custom storage (path unknown)'
  const shown = presentPath(where.path, input.homeDir, input.agentDir)
  if (input.isFile(where.path)) return shown
  return `${PENDING_OPEN}${shown})`
}

/**
 * Shorten a session file the way the footer shortens cwd: `~` under the home
 * directory, and `$VELA_DIR` when the file is under the configured agent directory.
 * The filename (session id) is left whole. Fitting to the terminal width happens
 * later, in `notice()`, from the width `Text.render` is given.
 */
function presentPath(
  path: string,
  homeDir: string,
  agentDir: string | undefined,
): string {
  if (isUnder(path, homeDir)) return `~${path.slice(homeDir.length)}`
  if (agentDir && isUnder(path, agentDir))
    return `$VELA_DIR${path.slice(agentDir.length)}`
  return path
}

function isUnder(path: string, root: string): boolean {
  if (!root) return false
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}

/**
 * Content width of the `Text` inside `notice()` (padding of one column on each side).
 * A Path line longer than this is one word: the wrapper drops `Path:` onto its own
 * line, then breaks the session id mid-string.
 */
export function noticeContentWidth(columns: number): number {
  const paddingX = Math.min(1, Math.max(0, Math.floor((columns - 1) / 2)))
  return Math.max(1, columns - paddingX * 2)
}

/**
 * Fit `/status` Path lines to the width `notice()` is rendering at, in terminal
 * columns. A CJK character is wider than one JavaScript character, so length is
 * the wrong measure. Other lines are unchanged.
 *
 * The session filename stays whole when it fits. When it does not, the line is
 * cut on a grapheme boundary so a wide character or a surrogate pair is never
 * split. An unsaved session always keeps `not written yet` on the Path line;
 * the destination moves to the next line when that filename fits, and is left
 * off when showing it would crack the id.
 */
export function fitStatusLines(text: string, contentWidth: number): string {
  return text
    .split('\n')
    .map((line) => fitStatusLine(line, contentWidth))
    .join('\n')
}

function fitStatusLine(line: string, contentWidth: number): string {
  if (!line.startsWith(PATH_LABEL) || visibleWidth(line) <= contentWidth)
    return line
  const value = line.slice(PATH_LABEL.length)
  const destination = pendingDestination(value)
  if (destination !== undefined) return fitPending(destination, contentWidth)
  const max = contentWidth - visibleWidth(PATH_LABEL)
  if (max <= 0) return clamp(line, contentWidth)
  return PATH_LABEL + fitDestination(value, max)
}

/** The path inside `not written yet (will save to …)`, or undefined when this value is saved. */
function pendingDestination(value: string): string | undefined {
  if (!value.startsWith(PENDING_OPEN) || !value.endsWith(')')) return undefined
  return value.slice(PENDING_OPEN.length, -1)
}

/**
 * The marker always occupies the Path line. The destination is a following
 * indented line only when its filename fits there whole.
 */
function fitPending(destination: string, contentWidth: number): string {
  const marker = clamp(`${PATH_LABEL}${PENDING_MARKER}`, contentWidth)
  const budget = contentWidth - visibleWidth(CONTINUATION_INDENT)
  const name = fileName(destination)
  if (!name || budget <= 0 || visibleWidth(name) > budget) return marker
  const fitted = fitDestination(destination, budget)
  if (visibleWidth(fitted) > budget || !fitted.includes(name)) return marker
  return `${marker}\n${CONTINUATION_INDENT}${fitted}`
}

/**
 * Keep `path` inside `max` columns. The `/sessions/` tail (and so the filename)
 * stays intact while it fits; only the directory prefix is shortened. A filename
 * wider than `max` is truncated on a grapheme boundary instead of wrapped.
 */
function fitDestination(path: string, max: number): string {
  if (visibleWidth(path) <= max) return path
  const sessionsAt = Math.max(
    path.lastIndexOf(`${sep}sessions${sep}`),
    path.lastIndexOf('/sessions/'),
  )
  const slashAt = Math.max(path.lastIndexOf(sep), path.lastIndexOf('/'))
  const keepFrom = sessionsAt >= 0 ? sessionsAt : slashAt
  if (keepFrom < 0) return clamp(path, max)
  const tail = `${ELLIPSIS}${path.slice(keepFrom)}`
  const tailWidth = visibleWidth(tail)
  if (tailWidth <= max) {
    const head = sliceByColumn(
      path.slice(0, keepFrom),
      0,
      max - tailWidth,
      true,
    )
    return head + tail
  }
  const name = path.slice(slashAt + 1)
  if (visibleWidth(name) <= max) return name
  return clamp(name, max)
}

function fileName(path: string): string {
  const slashAt = Math.max(path.lastIndexOf(sep), path.lastIndexOf('/'))
  return slashAt >= 0 ? path.slice(slashAt + 1) : path
}

/** Shorten to `max` columns without cutting a grapheme, a wide character, or a surrogate pair. */
function clamp(text: string, max: number): string {
  if (max <= 0) return ''
  if (visibleWidth(text) <= max) return text
  return truncateToWidth(text, max, ELLIPSIS)
}
