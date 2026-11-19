import { createRequire } from 'node:module'
import type { ExecutionEnv, VelaOptions } from '@glows777/vela-core'
import type { VelaConfig } from '../config/index.ts'

const require = createRequire(import.meta.url)

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Owner-only CLI composition. Local sessions keep the core's session-scoped login shell. */
export function ownerDocker(config: VelaConfig) {
  const settings = config.sessionResources?.userSettings
  if (!settings || !('environments' in settings)) return
  const definitions = settings.environments
  if (!record(definitions)) throw Error('Owner environments must be an object')
  const opened = new Map<string, Promise<ExecutionEnv>>()
  const env: NonNullable<VelaOptions['env']> = ({
    location: { environment: name, cwd },
  }) => {
    if (!Object.hasOwn(definitions, name)) return
    const entry = definitions[name]
    if (
      !record(entry) ||
      typeof entry.image !== 'string' ||
      Object.keys(entry).some((key) => !['image', 'network'].includes(key)) ||
      (entry.network !== undefined &&
        entry.network !== 'on' &&
        entry.network !== 'off')
    )
      throw Error(
        `Invalid Docker configuration for owner environment "${name}"`,
      )
    const key = JSON.stringify([name, cwd])
    let pending = opened.get(key)
    if (!pending) {
      const options = {
        name,
        dataDir: config.dataDir,
        image: entry.image,
        network: entry.network,
      } as const
      // Source-only CLI consumers need the built guest only when opening a Docker location.
      const adapter: typeof import('#docker-adapter') = require('#docker-adapter')
      pending = adapter.openDockerEnvironment(options, cwd)
      opened.set(key, pending)
      void pending.catch(() => opened.delete(key))
    }
    return pending
  }
  return {
    env,
    async beforeDispose() {
      const pending = [...opened.values()]
      opened.clear()
      const results = await Promise.allSettled(pending)
      await Promise.all(
        results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value.cleanup()] : [],
        ),
      )
    },
  }
}
