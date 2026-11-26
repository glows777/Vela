import type { VelaOptions } from '../driver/index.ts'
import type { VelaConfig } from '../load-config.ts'
import { EnvironmentRegistry } from '../runtime/index.ts'

/** Owner-only CLI composition. Local sessions keep the core's session-scoped login shell. */
export function ownerDocker(config: VelaConfig) {
  const settings = config.sessionResources?.userSettings
  if (!settings || !('environments' in settings)) return
  const registry = new EnvironmentRegistry({
    dataDir: config.dataDir,
    environments: settings.environments,
    hostEnv: config.sessionResources?.env ?? process.env,
  })
  const env: NonNullable<VelaOptions['env']> = (target) =>
    registry.resolve(target)
  return {
    env,
    envOs: (environment: string) => registry.osFor(environment),
    envNetworkMode: (environment: string) => registry.networkMode(environment),
    beforeDispose: () => registry.dispose(),
  }
}
