import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** A project instructions file (AGENTS.md / CLAUDE.md) put into the system prompt. */
export interface ContextFile {
  path: string
  content: string
}

/** Checked in this order in each directory; the first one that exists is used (same as pi). */
const CONTEXT_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
]

function loadFromDir(dir: string): ContextFile | undefined {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(dir, name)
    if (!existsSync(path) || !statSync(path).isFile()) continue
    return {
      path,
      content: readFileSync(path, 'utf-8').replace(/^﻿/, ''),
    }
  }
}

/**
 * Context files like pi (`core/resource-loader.ts` loadProjectContextFiles): one from `agentDir` (user-wide),
 * then one per directory from the filesystem root down to `cwd` (closer to cwd = later). Not gated by project
 * trust (same as pi: they are text for the model, which it would read anyway when it reads the project).
 * Inside a git worktree nested in its main repository, the main repository's file is skipped when the worktree
 * has its own (both cover the same repository).
 */
export function loadContextFiles(options: {
  cwd: string
  agentDir?: string
}): ContextFile[] {
  const files: ContextFile[] = []
  const seen = new Set<string>()
  if (options.agentDir) {
    const global = loadFromDir(resolve(options.agentDir))
    if (global) {
      files.push(global)
      seen.add(global.path)
    }
  }
  const cwd = resolve(options.cwd)
  const shadowed = shadowedContextFile(cwd)
  const ancestors: ContextFile[] = []
  let dir = cwd
  while (true) {
    const file = loadFromDir(dir)
    if (file && !seen.has(file.path) && canonical(file.path) !== shadowed) {
      ancestors.unshift(file)
      seen.add(file.path)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  files.push(...ancestors)
  return files
}

/** The `<project_context>` system prompt section (same text as pi). Null when there are no files. */
export function renderContextFiles(
  files: readonly ContextFile[],
): string | null {
  if (files.length === 0) return null
  const body = [
    'Project-specific instructions and guidelines:',
    ...files.map(
      ({ path, content }) =>
        `<project_instructions path="${path.replace(/\\/g, '/')}">\n${content}\n</project_instructions>`,
    ),
  ].join('\n\n')
  return `<project_context>\n${body}\n</project_context>`
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The main repository's context file that a nested linked worktree's own file shadows, or undefined
 * (same as pi's findShadowedContextFile: an ordinary repo, a sibling worktree, a bare layout and a submodule shadow nothing).
 */
function shadowedContextFile(cwd: string): string | undefined {
  const git = findGitPaths(cwd)
  if (!git) return
  const commonGitDir = canonical(git.commonGitDir)
  const worktreeRoot = canonical(git.repoDir)
  const mainRepoRoot = dirname(commonGitDir)
  if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return
  if (canonical(join(mainRepoRoot, '.git')) !== commonGitDir) return
  const own = loadFromDir(worktreeRoot)
  return own ? join(mainRepoRoot, basename(own.path)) : undefined
}

/** The nearest git checkout above cwd: its root and the shared git dir (follows a worktree's `.git` file). */
function findGitPaths(
  cwd: string,
): { repoDir: string; commonGitDir: string } | undefined {
  let dir = cwd
  while (true) {
    const gitPath = join(dir, '.git')
    if (existsSync(gitPath)) {
      try {
        if (statSync(gitPath).isDirectory())
          return { repoDir: dir, commonGitDir: gitPath }
        const content = readFileSync(gitPath, 'utf-8').trim()
        if (!content.startsWith('gitdir: ')) return
        const gitDir = resolve(dir, content.slice(8).trim())
        const commonDir = join(gitDir, 'commondir')
        return {
          repoDir: dir,
          commonGitDir: existsSync(commonDir)
            ? resolve(gitDir, readFileSync(commonDir, 'utf-8').trim())
            : gitDir,
        }
      } catch {
        return
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}
