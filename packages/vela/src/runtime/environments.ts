import type { ExecutionEnv, ExecutionLocation } from '../shared/execution.ts'
import { openDockerEnvironment } from './docker/adapter.ts'
import {
  createDockerRunner,
  type DockerContainerEnv,
  dockerContainerId,
} from './docker/container.ts'
import { ownerDockerCredentials } from './docker/credentials.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface EnvironmentRegistryOptions {
  dataDir: string
  environments?: unknown
  hostEnv?: Record<string, string | undefined>
  guestPath?: string
  dockerHost?: string
  openDocker?: typeof openDockerEnvironment
  probeAlive?: (containerId: string, env: ExecutionEnv) => Promise<boolean>
}

function parseDockerDefinition(
  name: string,
  entry: unknown,
  hostEnv: Record<string, string | undefined>,
) {
  if (
    !isRecord(entry) ||
    typeof entry.image !== 'string' ||
    Object.keys(entry).some(
      (key) => !['image', 'network', 'allow', 'credentials'].includes(key),
    ) ||
    (entry.network !== undefined &&
      entry.network !== 'on' &&
      entry.network !== 'off' &&
      entry.network !== 'restricted') ||
    (entry.allow !== undefined &&
      (!Array.isArray(entry.allow) ||
        entry.allow.some((host) => typeof host !== 'string')))
  )
    throw Error(`Invalid Docker configuration for owner environment "${name}"`)
  return {
    name,
    image: entry.image,
    network: entry.network,
    allow: entry.allow as string[] | undefined,
    credentials: ownerDockerCredentials(
      entry.credentials,
      entry.network,
      name,
      hostEnv,
    ),
  } as const
}

/**
 * Owns runtime execution environments (local metadata + Docker container lifecycle,
 * credential proxy bindings, and dead-container cache invalidation/re-probing).
 */
export class EnvironmentRegistry {
  private readonly definitions: Record<string, unknown>
  private readonly dataDir: string
  private readonly hostEnv: Record<string, string | undefined>
  private readonly guestPath?: string
  private readonly dockerHost?: string
  private readonly openDocker: typeof openDockerEnvironment
  private readonly probeAlive: (
    containerId: string,
    env: ExecutionEnv,
  ) => Promise<boolean>
  private readonly opened = new Map<string, Promise<ExecutionEnv>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly cleanups = new Set<Promise<void>>()
  private readonly cleanupErrors: unknown[] = []
  private disposing: Promise<void> | undefined
  private disposed = false

  constructor(options: EnvironmentRegistryOptions) {
    this.dataDir = options.dataDir
    this.hostEnv = options.hostEnv ?? {}
    this.guestPath = options.guestPath
    this.dockerHost = options.dockerHost
    this.openDocker = options.openDocker ?? openDockerEnvironment
    const docker = createDockerRunner(this.dockerHost, this.hostEnv)
    this.probeAlive =
      options.probeAlive ??
      (async (containerId) => {
        try {
          const state = await docker([
            'inspect',
            '--type',
            'container',
            '--format',
            '{{.State.Running}}',
            containerId,
          ])
          return state.trim() === 'true'
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          if (/no such (?:container|object)/i.test(detail)) return false
          throw error
        }
      })
    if (options.environments === undefined) {
      this.definitions = {}
    } else {
      if (!isRecord(options.environments))
        throw Error('Owner environments must be an object')
      this.definitions = options.environments
    }
  }

  hasDockerEnvironments(): boolean {
    return Object.keys(this.definitions).length > 0
  }

  has(environment: string): boolean {
    return (
      environment === 'local' || Object.hasOwn(this.definitions, environment)
    )
  }

  osFor(environment: string): string {
    if (environment === 'local') return process.platform
    if (Object.hasOwn(this.definitions, environment)) return 'linux'
    return process.platform
  }

  networkMode(environment: string): 'on' | 'off' | 'restricted' {
    if (
      environment === 'local' ||
      !Object.hasOwn(this.definitions, environment)
    ) {
      return 'on'
    }
    const entry = this.definitions[environment]
    if (isRecord(entry)) {
      if (entry.network === 'off' || entry.network === 'restricted') {
        return entry.network
      }
    }
    return 'on'
  }

  async resolve(target: {
    sessionId: string
    location: ExecutionLocation
  }): Promise<ExecutionEnv | undefined> {
    if (this.disposed) throw Error('EnvironmentRegistry has been disposed')
    const { environment: name, cwd } = target.location
    if (name === 'local' || !Object.hasOwn(this.definitions, name)) return
    const key = JSON.stringify([name, cwd])
    return this.serialized(key, async () => {
      for (;;) {
        if (this.disposed) throw Error('EnvironmentRegistry has been disposed')
        const cached = this.opened.get(key)
        if (cached) {
          let env: ExecutionEnv | undefined
          try {
            env = await cached
          } catch {
            if (this.opened.get(key) === cached) this.opened.delete(key)
          }
          if (env) {
            const alive = await this.isContainerAlive(env)
            if (this.disposed)
              throw Error('EnvironmentRegistry has been disposed')
            // If invalidated or replaced while the probe was in flight, re-resolve.
            if (this.opened.get(key) !== cached) continue
            if (alive) return env
            this.opened.delete(key)
            await this.trackCleanup(env.cleanup(), false)
          }
        }
        const options = {
          ...parseDockerDefinition(name, this.definitions[name], this.hostEnv),
          dataDir: this.dataDir,
          hostEnv: this.hostEnv,
          ...(this.guestPath ? { guestPath: this.guestPath } : {}),
          ...(this.dockerHost ? { dockerHost: this.dockerHost } : {}),
        }
        const pending = this.openDocker(options, cwd)
        this.opened.set(key, pending)
        try {
          return await pending
        } catch (error) {
          if (this.opened.get(key) === pending) this.opened.delete(key)
          throw error
        }
      }
    })
  }

  invalidate(location: ExecutionLocation): void {
    const key = JSON.stringify([location.environment, location.cwd])
    const pending = this.opened.get(key)
    if (!pending) return
    this.opened.delete(key)
    const cleanup = pending.then(
      (env) => env.cleanup(),
      () => {},
    )
    this.trackCleanup(cleanup, true)
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposing ??= (async () => {
      await Promise.allSettled([...this.locks.values()])
      const pending = [...this.opened.values()]
      this.opened.clear()
      const results = await Promise.allSettled(pending)
      for (const result of results) {
        if (result.status === 'fulfilled') {
          this.trackCleanup(result.value.cleanup(), true)
        }
      }
      while (this.cleanups.size > 0) {
        await Promise.allSettled([...this.cleanups])
      }
      const errors = this.cleanupErrors.splice(0)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'EnvironmentRegistry disposal failed')
    })()
    return this.disposing
  }

  private trackCleanup(
    promise: Promise<void>,
    collectError: boolean,
  ): Promise<void> {
    const tracked = promise
      .catch((error) => {
        if (collectError) this.cleanupErrors.push(error)
      })
      .finally(() => {
        this.cleanups.delete(tracked)
      })
    this.cleanups.add(tracked)
    return tracked
  }

  private async isContainerAlive(env: ExecutionEnv): Promise<boolean> {
    const id = (env as DockerContainerEnv)[dockerContainerId]
    if (!id) return true
    return await this.probeAlive(id, env)
  }

  private serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    const settled = next.then(
      () => {},
      () => {},
    )
    this.locks.set(key, settled)
    void settled.finally(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key)
    })
    return next
  }
}
