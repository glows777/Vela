import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** `~/.vela/trust.json`: directory → trusted (like pi's trust.json; a parent's decision applies to its children). */
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

/** The saved decision closest to cwd, or undefined. */
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
