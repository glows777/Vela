import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateText } from 'ai'
import type { CredentialStore } from '../auth/types.ts'
import type { ProviderConfig } from '../config/models.ts'
import { type ProviderDefinition, resolveModel } from './index.ts'

/** Verify the selected provider and model with one small request. This may incur a charge. */
export async function verifyProviderModel(
  ref: string,
  providers: Record<string, ProviderDefinition>,
  credentials: CredentialStore,
  signal?: AbortSignal,
): Promise<void> {
  await generateText({
    model: resolveModel(ref, { providers, credentials }),
    prompt: 'Reply OK.',
    maxOutputTokens: 16,
    maxRetries: 0,
    abortSignal: signal,
  })
}

/** Merge one user-level provider preset without changing the other providers or top-level fields. */
export function writeProviderPreset(
  agentDir: string,
  provider: string,
  preset: ProviderConfig,
): string {
  const path = join(agentDir, 'models.json')
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  file.providers = {
    ...file.providers,
    [provider]: { ...file.providers?.[provider], ...preset },
  }
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return path
}
