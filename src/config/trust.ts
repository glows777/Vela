import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** `~/.vela/trust.json`：目录 → 是否信任（同 pi 的 trust.json，父目录的决定对子目录生效）。 */
function trustFile(agentDir: string): string {
  return join(agentDir, 'trust.json')
}

function readDecisions(agentDir: string): Record<string, boolean> {
  const file = trustFile(agentDir)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** 离 cwd 最近的已保存决定；没有时 undefined。 */
export function savedTrust(agentDir: string, cwd: string): boolean | undefined {
  const decisions = readDecisions(agentDir)
  let dir = resolve(cwd)
  while (true) {
    const decision = decisions[dir]
    if (typeof decision === 'boolean') return decision
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

export function saveTrust(agentDir: string, cwd: string, trusted: boolean): void {
  const decisions = readDecisions(agentDir)
  decisions[resolve(cwd)] = trusted
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(trustFile(agentDir), `${JSON.stringify(decisions, null, 2)}\n`, {
    mode: 0o600,
  })
}
