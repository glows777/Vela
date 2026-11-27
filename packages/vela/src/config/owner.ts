import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  interpolateConfigLayer,
  parseConfig,
  type VelaSettings,
} from './schema.ts'
import { assertNoLegacyConfigFiles } from './writer.ts'

export function statSignature(file: string): string {
  try {
    const st = statSync(file)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

export function loadOwnerRuntimeConfig(
  agentDir: string,
  hostEnv: Record<string, string | undefined>,
): { settings: VelaSettings; larkError?: string } {
  assertNoLegacyConfigFiles(agentDir)
  const file = join(agentDir, 'config.json')
  if (!existsSync(file)) return { settings: {} }
  const text = readFileSync(file, 'utf8')
  let invalidWebhooks: unknown
  let hasInvalidWebhooks = false
  let larkError: string | undefined
  let parseText = text
  try {
    const raw = JSON.parse(text) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const stripped: Record<string, unknown> = {
        ...(raw as Record<string, unknown>),
      }
      let changed = false
      if (Object.hasOwn(raw, 'webhooks')) {
        const value = stripped.webhooks
        if (
          value !== undefined &&
          (!value || typeof value !== 'object' || Array.isArray(value))
        ) {
          hasInvalidWebhooks = true
          invalidWebhooks = value
          delete stripped.webhooks
          changed = true
        }
      }
      if (Object.hasOwn(raw, 'lark')) {
        const larkValue = stripped.lark
        if (
          larkValue !== undefined &&
          (!larkValue ||
            typeof larkValue !== 'object' ||
            Array.isArray(larkValue))
        ) {
          larkError = `${file}: lark must be an object`
          delete stripped.lark
          changed = true
        }
      }
      if (changed) parseText = JSON.stringify(stripped)
    }
  } catch {
    /* Let parseConfig raise its normal malformed JSON error */
  }
  const interpolated = interpolateConfigLayer(
    parseConfig(parseText, file),
    hostEnv,
  )
  return {
    settings: hasInvalidWebhooks
      ? {
          ...interpolated,
          webhooks: invalidWebhooks as Record<string, unknown>,
        }
      : interpolated,
    ...(larkError ? { larkError } : {}),
  }
}
