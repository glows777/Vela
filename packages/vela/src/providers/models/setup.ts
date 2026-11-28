import { generateText, type LanguageModel } from 'ai'
import { updateConfigFile } from '../../config/index.ts'
import type { ProviderConfig } from '../../shared/provider-types.ts'
import type { CredentialStore } from '../auth/types.ts'
import { ModelRegistry, type ProviderDefinition } from './index.ts'

/** Verify the selected provider and model with one small request. This may incur a charge. */
export async function verifyProviderModel(
  ref: string,
  providers: Record<string, ProviderDefinition>,
  credentials: CredentialStore,
  signal?: AbortSignal,
  options?: { blockLocalOnlyOAuth?: boolean },
): Promise<void> {
  const model = new ModelRegistry(providers, credentials, undefined, {
    blockLocalOnlyOAuth: options?.blockLocalOnlyOAuth,
  }).resolve(ref).model
  await generateText({
    model: model as LanguageModel,
    prompt: 'Reply OK.',
    maxOutputTokens: 16,
    maxRetries: 0,
    abortSignal: signal,
  })
}

/** Merge one user-level provider preset atomically into `config.json` (`0600`) without changing other providers or top-level fields. */
export function writeProviderPreset(
  agentDir: string,
  provider: string,
  preset: ProviderConfig,
): string {
  return updateConfigFile(agentDir, (current) => {
    const existing =
      current.providers &&
      typeof current.providers === 'object' &&
      !Array.isArray(current.providers)
        ? (current.providers as Record<string, Record<string, unknown>>)
        : {}
    return {
      ...current,
      providers: {
        ...existing,
        [provider]: { ...existing[provider], ...preset },
      },
    }
  })
}
