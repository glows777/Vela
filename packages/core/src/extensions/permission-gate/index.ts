import type {
  ExtensionConfigDefinition,
  VelaExtension,
} from '../../extension-api.ts'

/** Commands worth confirming (pi's permission-gate example): a heuristic, not a security control */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
]

/**
 * Asks before running a bash command that matches DANGEROUS_PATTERNS: with a UI it shows the
 * command and runs it only on Yes; without one it blocks. The CLI keeps it off by default
 * (`+builtin:permission-gate` in settings enables it), like pi's permission-gate example.
 */
export function permissionGate(): VelaExtension {
  return function permissionGate(vela) {
    vela.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'bash') return
      const command = event.input.command
      if (typeof command !== 'string') return
      if (!DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) return
      if (!ctx.hasUI)
        return {
          block: true,
          reason: 'Dangerous command blocked (no UI for confirmation)',
        }
      const choice = await ctx.ui.select(
        `Dangerous command:\n\n  ${command}\n\nAllow?`,
        ['Yes', 'No'],
      )
      if (choice !== 'Yes') return { block: true, reason: 'Blocked by user' }
    })
  }
}

export const permissionGateConfig: ExtensionConfigDefinition = {
  name: 'permission-gate',
  resolve(section) {
    return { ...section }
  },
}
