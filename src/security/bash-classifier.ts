export type RiskLevel = 'safe' | 'moderate' | 'dangerous'

interface ClassifyResult {
  level: RiskLevel
  reason?: string
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force)/,
    reason: 'Force-deletes files',
  },
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: 'Recursive delete' },
  { pattern: /\bsudo\b/, reason: 'Privilege escalation' },
  { pattern: /\bmkfs\b/, reason: 'Formats a disk' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: 'Writes directly to a device' },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: 'Fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Overwrites a disk device' },
  { pattern: /\bchmod\s+777\b/, reason: 'Grants all permissions' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: 'Runs a remote script' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: 'Runs a remote script' },
  { pattern: /\beval\b/, reason: 'Dynamic eval' },
  { pattern: />\s*\/etc\//, reason: 'Overwrites system config' },
]

const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: 'Deletes files' },
  { pattern: /\bmv\b/, reason: 'Moves/renames files' },
  { pattern: /\bchmod\b/, reason: 'Changes permissions' },
  { pattern: /\bchown\b/, reason: 'Changes owner' },
  { pattern: /\bkill\b/, reason: 'Kills a process' },
  { pattern: /\bpkill\b/, reason: 'Kills processes by pattern' },
  { pattern: /\bgit\s+push\b/, reason: 'Git push' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git hard reset' },
  { pattern: /\bnpm\s+publish\b/, reason: 'Publishes an npm package' },
  { pattern: /\bdocker\s+rm\b/, reason: 'Removes a container' },
]

export function classifyBashCommand(command: string): ClassifyResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'dangerous', reason }
    }
  }

  for (const { pattern, reason } of MODERATE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'moderate', reason }
    }
  }

  return { level: 'safe' }
}
