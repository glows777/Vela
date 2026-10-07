import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 用户级目录：`VELA_DIR`，默认 `~/.vela`（同 pi 的 `~/.pi/agent` / `PI_CODING_AGENT_DIR`）。 */
export function defaultAgentDir(env: Record<string, string | undefined> = {}): string {
  return env.VELA_DIR ? expandHome(env.VELA_DIR) : join(homedir(), '.vela')
}

/**
 * 一个项目的数据目录：`<agentDir>/projects/--home-liam-code-x--`。
 * cwd 的编码规则同 pi 的会话目录（去掉开头的分隔符，`/ \ :` 换成 `-`，两边加 `--`）。
 */
export function projectDataDir(agentDir: string, cwd: string): string {
  const encoded = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`
  return join(agentDir, 'projects', encoded)
}

/** `~` / `~/x` 展开成家目录 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}

/** 配置里的路径：支持 `~`，相对路径按 `base`（所在配置文件的目录）解析。 */
export function resolveConfigPath(base: string, path: string): string {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}
