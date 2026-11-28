import { join } from 'node:path'
import { type VelaDatabase, withReadonlyDb } from './db/index.ts'
import type { VelaExtension } from './driver/extensions/types.ts'
import type { RuntimeMcpAdapter } from './driver/runtime-adapter.ts'
import type { ResolveSpecialModelFn } from './driver/runtime-types.ts'
import type { VelaLogger } from './shared/logger.ts'
import type { ModelInput } from './shared/provider-types.ts'

export function createLazyRuntimeMcpAdapter(
  hostEnv: Record<string, string | undefined> | undefined,
  logger: VelaLogger,
  skipUserConfig = false,
): RuntimeMcpAdapter {
  let adapterPromise: Promise<RuntimeMcpAdapter> | undefined
  const loadAdapter = (): Promise<RuntimeMcpAdapter> => {
    adapterPromise ??= import('./mcp/runtime-adapter.ts').then((mod) =>
      mod.createRuntimeMcpAdapter({ hostEnv, logger, skipUserConfig }),
    )
    return adapterPromise
  }
  return {
    async attach(params) {
      const adapter = await loadAdapter()
      return adapter.attach(params)
    },
    async dispose() {
      if (!adapterPromise) return
      const adapter = await adapterPromise
      await adapter.dispose?.()
    },
  }
}

export function mergeExtensionConfig(
  base: Record<string, Record<string, unknown>>,
  override: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  const keys = new Set([...Object.keys(base), ...Object.keys(override ?? {})])
  if (keys.size === 0) return undefined
  const merged: Record<string, Record<string, unknown>> = {}
  for (const key of keys) {
    merged[key] = { ...(base[key] ?? {}), ...(override?.[key] ?? {}) }
  }
  return merged
}

export function isLarkExtensionDisabled(
  ownerExtensions: readonly string[] | undefined,
  explicitExtensions?: readonly (string | VelaExtension)[],
): boolean {
  let disabled = false
  for (const list of [ownerExtensions, explicitExtensions]) {
    for (const entry of list ?? []) {
      if (entry === '-builtin:lark') disabled = true
      else if (entry === '+builtin:lark' || entry === 'builtin:lark')
        disabled = false
    }
  }
  return disabled
}

export function createSpecialModelResolver(): ResolveSpecialModelFn {
  return async ({ modelRef, recordPath, fallbackModel }) => {
    const testing = await import('./testing/core/index.ts')
    let baseModel: ModelInput | undefined
    if (modelRef === 'mock') {
      baseModel = testing.createMockModel()
    } else if (modelRef?.startsWith('faux:')) {
      baseModel = await testing.loadFauxScenario(modelRef.slice('faux:'.length))
    } else {
      baseModel = fallbackModel
    }
    if (!baseModel) return undefined
    const maybeCache = baseModel as unknown as {
      setCacheEnabled?: (enabled: boolean) => void
    }
    if (recordPath) {
      const recorder = testing.recordModel(baseModel, { path: recordPath })
      return {
        model: recorder.model,
        addInput: (input) => recorder.addInput(input),
        flush: () => recorder.flush(),
        ...(maybeCache.setCacheEnabled
          ? {
              setCacheEnabled: (enabled) =>
                maybeCache.setCacheEnabled?.(enabled),
            }
          : {}),
      }
    }
    return {
      model: baseModel,
      ...(maybeCache.setCacheEnabled
        ? {
            setCacheEnabled: (enabled) => maybeCache.setCacheEnabled?.(enabled),
          }
        : {}),
    }
  }
}

export function seedEphemeralDbFromOwner(
  db: VelaDatabase,
  agentDir: string,
): void {
  try {
    withReadonlyDb(join(agentDir, 'vela.db'), (ownerDb) => {
      const trustRows = ownerDb.all<{
        path: string
        trusted: number
        updated_at: string
      }>('SELECT path, trusted, updated_at FROM trusted_paths')
      for (const r of trustRows) {
        db.run(
          'INSERT OR REPLACE INTO trusted_paths (path, trusted, updated_at) VALUES (?, ?, ?)',
          r.path,
          r.trusted,
          r.updated_at,
        )
      }
      const oauthRows = ownerDb.all<{
        provider: string
        client_id: string
        host_id: string | null
        subject: string | null
        updated_at: string
      }>(
        'SELECT provider, client_id, host_id, subject, updated_at FROM oauth_registrations',
      )
      for (const r of oauthRows) {
        db.run(
          'INSERT OR REPLACE INTO oauth_registrations (provider, client_id, host_id, subject, updated_at) VALUES (?, ?, ?, ?, ?)',
          r.provider,
          r.client_id,
          r.host_id,
          r.subject,
          r.updated_at,
        )
      }
    })
  } catch {
    /* ignore unreadable owner db when seeding ephemeral state */
  }
}
