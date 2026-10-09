import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** User-level directory: `VELA_DIR`, default `~/.vela` (like pi's `~/.pi/agent` / `PI_CODING_AGENT_DIR`). */
export function defaultAgentDir(
  env: Record<string, string | undefined> = {},
): string {
  return env.VELA_DIR ? expandHome(env.VELA_DIR) : join(homedir(), '.vela')
}

/**
 * A project's data directory: `<agentDir>/projects/--home-liam-code-x--1a2b3c4d`.
 * The first part uses pi's session directory encoding (leading separator dropped,
 * `/ \ :` replaced with `-`, wrapped in `--`) so it stays readable. Unlike pi, a short hash
 * of the full path follows: `/a-b/c` and `/a/b-c` encode the same, and Vela stores memory
 * and the knowledge base per project, so two projects must never share a directory.
 */
export function projectDataDir(agentDir: string, cwd: string): string {
  const path = resolve(cwd)
  const readable = path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8)
  return join(agentDir, 'projects', `--${readable}--${hash}`)
}

/** Expands `~` / `~/x` to the home directory */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}

/** A path from config: supports `~`; relative paths resolve against `base` (the config file's directory). */
export function resolveConfigPath(base: string, path: string): string {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}
