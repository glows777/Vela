import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ExtensionConfigDefinition } from '@glows777/vela-core/extension-api'

const TRUSTED_PROJECT_RESOURCES = [
  'settings.json',
  'extensions',
  'skills',
  'prompts',
  'APPEND_SYSTEM.md',
]

/**
 * The project has executable or behavior-changing config (`.vela/settings.json`, `.vela/extensions/`,
 * skills in `.vela/skills/`, `.skills/` or `.agents/skills/`, `.vela/prompts/`, `.vela/APPEND_SYSTEM.md`) that
 * needs the user's trust before loading (like pi's trust-requiring project resources). Not counted when the
 * project dir is the user-level dir (running from the home directory). AGENTS.md / CLAUDE.md don't count (like pi).
 */
export function projectTrustRequired(
  cwd: string,
  agentDir?: string,
  homeDir: string = homedir(),
  extensionConfigs: readonly ExtensionConfigDefinition[] = [],
): boolean {
  const projectDir = join(resolve(cwd), '.vela')
  if (agentDir && resolve(agentDir) === projectDir) return false
  const userAgentsSkills = join(resolve(homeDir), '.agents', 'skills')
  return (
    [
      ...TRUSTED_PROJECT_RESOURCES,
      ...extensionConfigs.flatMap(
        (definition) => definition.projectResources ?? [],
      ),
    ].some((name) => existsSync(join(projectDir, name))) ||
    existsSync(join(resolve(cwd), '.skills')) ||
    ancestorAgentsSkillDirs(cwd).some(
      (dir) => dir !== userAgentsSkills && existsSync(dir),
    )
  )
}

/** `.agents/skills` in cwd and each parent up to the git repository root (or the filesystem root outside git), like pi. */
function ancestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = []
  let dir = resolve(cwd)
  const gitRoot = findGitRoot(dir)
  while (true) {
    dirs.push(join(dir, '.agents', 'skills'))
    if (dir === gitRoot) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

function findGitRoot(start: string): string | undefined {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

export function defaultAgentDir(
  env: Record<string, string | undefined> = {},
): string {
  return env.VELA_DIR ? expandHome(env.VELA_DIR) : join(homedir(), '.vela')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}

export function extensionName(path: string): string {
  const file = basename(path, extname(path))
  return file === 'index' ? basename(dirname(path)) : file
}
