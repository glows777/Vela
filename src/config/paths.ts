import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 用户级目录：`VELA_DIR`，默认 `~/.vela`（同 pi 的 `~/.pi/agent` / `PI_CODING_AGENT_DIR`）。 */
export function defaultAgentDir(env: Record<string, string | undefined> = {}): string {
  return env.VELA_DIR ? expandHome(env.VELA_DIR) : join(homedir(), '.vela')
}

/**
 * 一个项目的数据目录：`<agentDir>/projects/--home-liam-code-x--1a2b3c4d`。
 * 前半同 pi 的会话目录编码（去掉开头的分隔符，`/ \ :` 换成 `-`，两边加 `--`），方便认；
 * 和 pi 不同，后面加完整路径的短哈希：`/a-b/c` 和 `/a/b-c` 编码相同，而 Vela 的记忆、知识库
 * 按项目存，不能让两个项目共用。
 */
export function projectDataDir(agentDir: string, cwd: string): string {
  const path = resolve(cwd)
  const readable = path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8)
  return join(agentDir, 'projects', `--${readable}--${hash}`)
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
