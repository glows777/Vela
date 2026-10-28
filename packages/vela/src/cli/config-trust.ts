import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** `~/.vela/trust.json`: directory → trusted (like pi's trust.json; a parent's decision applies to its children). */
function trustFile(agentDir: string): string {
  return join(agentDir, 'trust.json')
}

function readDecisions(agentDir: string): Record<string, boolean> {
  const file = trustFile(agentDir)
  if (!existsSync(file)) return {}
  // Fail loudly: treating a broken file as empty would ask again and then overwrite every saved decision
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(
      `${file} must be an object mapping directories to true or false`,
    )
  return parsed as Record<string, boolean>
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

export function saveTrust(
  agentDir: string,
  cwd: string,
  trusted: boolean,
): void {
  const decisions = readDecisions(agentDir)
  decisions[resolve(cwd)] = trusted
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    trustFile(agentDir),
    `${JSON.stringify(decisions, null, 2)}\n`,
    {
      mode: 0o600,
    },
  )
}
