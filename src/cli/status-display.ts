import { basename, dirname, sep } from 'node:path'
import type { SessionPersistence } from '../session/storage.ts'
import { sanitize } from './tui/components.ts'

/**
 * pi-tui `Text` pads one column on each side, so a 120-column TUI wraps at 118.
 * The Path line has to fit in that width: a longer path is one word, the wrapper
 * drops `Path:` onto its own line, then breaks the session id mid-string.
 */
const STATUS_CONTENT_WIDTH = 118
const PATH_LABEL = '  Path: '
const ELLIPSIS = '…'

export interface StatusPathInput {
  persistence: SessionPersistence
  /** Project data directory (`<VELA_DIR>/projects/<encoded cwd>` for the CLI). */
  dataDir: string
  homeDir: string
  /** Whether the session file is on disk. Missing files must not look saved. */
  isFile: (path: string) => boolean
}

/** The `Path:` value: where history is kept, without claiming a file that is not there. */
export function formatStatusPath(input: StatusPathInput): string {
  const where = input.persistence
  if (where.type === 'memory') return 'in-memory (not saved)'
  if (where.type !== 'file') return 'custom storage (path unknown)'
  const shown = presentPath(where.path, input.dataDir, input.homeDir)
  const max = STATUS_CONTENT_WIDTH - PATH_LABEL.length
  if (input.isFile(where.path)) return fitDisplayPath(shown, max)
  const prefix = 'not written yet (will save to '
  const suffix = ')'
  const room = max - prefix.length - suffix.length
  const fitted = fitDisplayPath(shown, Math.max(1, room))
  const pending = `${prefix}${fitted}${suffix}`
  return pending.length <= max ? pending : fitDisplayPath(shown, max)
}

/**
 * Shorten a session file the way the footer shortens cwd: `~` under the home
 * directory, and `$VELA_DIR` when the project data dir lives outside it.
 * The filename (session id) is left whole.
 */
function presentPath(path: string, dataDir: string, homeDir: string): string {
  const shortened = shortenRoot(path, dataDir, homeDir)
  return sanitize(shortened).replace(/\n+/g, ' ').trim()
}

function shortenRoot(path: string, dataDir: string, homeDir: string): string {
  if (isUnder(path, homeDir)) return `~${path.slice(homeDir.length)}`
  const agentDir = agentDirOf(dataDir)
  if (agentDir && isUnder(path, agentDir))
    return `$VELA_DIR${path.slice(agentDir.length)}`
  return path
}

/** `<agentDir>/projects/--encoded--hash` → agentDir. Other data dirs are left alone. */
function agentDirOf(dataDir: string): string | undefined {
  const projects = dirname(dataDir)
  if (basename(projects) !== 'projects') return undefined
  const agent = dirname(projects)
  if (!agent || agent === projects) return undefined
  return agent
}

function isUnder(path: string, root: string): boolean {
  if (!root) return false
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}

/**
 * Keep the line inside `max` without cutting the session filename.
 * The tail from `/sessions/` (or the filename) stays intact; only the
 * directory prefix is shortened with an ellipsis.
 */
export function fitDisplayPath(path: string, max: number): string {
  if (path.length <= max) return path
  const sessionsAt = Math.max(
    path.lastIndexOf(`${sep}sessions${sep}`),
    path.lastIndexOf('/sessions/'),
  )
  const slashAt = Math.max(path.lastIndexOf(sep), path.lastIndexOf('/'))
  const keepFrom = sessionsAt >= 0 ? sessionsAt : slashAt
  if (keepFrom < 0) return path
  const tail = `${ELLIPSIS}${path.slice(keepFrom)}`
  if (tail.length > max) return path.slice(slashAt + 1)
  const headLen = Math.min(max - tail.length, keepFrom)
  return path.slice(0, headLen) + tail
}
