import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { formatJsonParseError } from './schema.ts'

/** `~/.vela/trust.json`: directory → trusted (like pi's trust.json; a parent's decision applies to its children). */
function trustFile(agentDir: string): string {
  return join(agentDir, 'trust.json')
}

function canonicalDir(dir: string): string {
  const resolved = resolve(dir)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function readDecisions(agentDir: string): Record<string, boolean> {
  const file = trustFile(agentDir)
  if (!existsSync(file)) return {}
  // Fail loudly: treating a broken file as empty would ask again and then overwrite every saved decision
  const text = readFileSync(file, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(formatJsonParseError(file, text, error))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(
      `${file} must be an object mapping directories to true or false`,
    )
  return parsed as Record<string, boolean>
}

/** The saved decision closest to cwd, or undefined. Denial takes precedence on canonical ties. */
export function savedTrust(agentDir: string, cwd: string): boolean | undefined {
  const decisions = readDecisions(agentDir)
  const byCanonical = new Map<string, boolean>()
  for (const [key, val] of Object.entries(decisions)) {
    if (typeof val !== 'boolean') continue
    const canon = canonicalDir(key)
    const prev = byCanonical.get(canon)
    byCanonical.set(canon, prev !== false && val !== false)
  }
  let curCanon = canonicalDir(cwd)
  let curRaw = resolve(cwd)
  let canonDone = false
  let rawDone = false
  while (!canonDone || !rawDone) {
    const matches: boolean[] = []
    if (!rawDone && typeof decisions[curRaw] === 'boolean') {
      matches.push(decisions[curRaw]!)
    }
    if (!canonDone) {
      const canonMatch = byCanonical.get(curCanon)
      if (typeof canonMatch === 'boolean') matches.push(canonMatch)
      if (typeof decisions[curCanon] === 'boolean') {
        matches.push(decisions[curCanon]!)
      }
    }
    if (matches.length > 0) return !matches.includes(false)
    const nextCanon = dirname(curCanon)
    const nextRaw = dirname(curRaw)
    if (nextCanon === curCanon) canonDone = true
    else curCanon = nextCanon
    if (nextRaw === curRaw) rawDone = true
    else curRaw = nextRaw
  }
  return undefined
}

export function saveTrust(
  agentDir: string,
  cwd: string,
  trusted: boolean,
): void {
  const decisions = readDecisions(agentDir)
  decisions[canonicalDir(cwd)] = trusted
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  }
  const file = trustFile(agentDir)
  const temporary = join(
    agentDir,
    `.trust-${randomBytes(12).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(decisions, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    chmodSync(temporary, 0o600)
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}
