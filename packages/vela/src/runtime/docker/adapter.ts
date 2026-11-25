import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutionEnv } from '../../shared/execution.ts'
import { containerOperations, createDockerRunner } from './container.ts'
import {
  type DockerCredential,
  openDockerCredentialBinding,
} from './credential-binding.ts'
import { credentialOriginHost } from './credential-proxy.ts'
import {
  type DockerOptions,
  prepareDocker,
  restrictedDirectory,
} from './lifecycle.ts'

const dnsHost =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu

function restrictedAllow(
  options: DockerOptions,
  credentials: readonly DockerCredential[],
) {
  if (options.network !== 'restricted') {
    if (options.allow !== undefined)
      throw Error('Docker allow is only valid with restricted networking')
    return
  }
  if (!Array.isArray(options.allow) || !options.allow.length)
    throw Error('Docker restricted networking requires a non-empty allow list')
  const allow = [
    ...new Set(
      options.allow.map((value: unknown) => {
        if (
          typeof value !== 'string' ||
          value.length > 253 ||
          !dnsHost.test(value) ||
          isIP(value) ||
          URL.parse(`https://${value}`)?.hostname !== value.toLowerCase()
        )
          throw Error('Docker allow requires exact DNS hosts')
        return value.toLowerCase()
      }),
    ),
  ].sort()
  for (const credential of credentials)
    if (
      credential.origins.some(
        (origin) => !allow.includes(credentialOriginHost(origin)),
      )
    )
      throw Error(
        'Docker credential origins must be included in the restricted allow list',
      )
  return allow
}

function resolveDockerGuestPath(explicit?: string): string {
  if (explicit) return explicit
  const candidates = [
    fileURLToPath(new URL('../../docker/guest.cjs', import.meta.url)),
    fileURLToPath(new URL('../../../dist/docker/guest.cjs', import.meta.url)),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

// Validate the installed guest before creating or starting an owned container.
export async function openDockerEnvironment(
  config: DockerOptions & {
    credentials?: readonly DockerCredential[]
    guestPath?: string
    dockerHost?: string
    hostEnv?: Record<string, string | undefined>
    run?: (args: string[]) => Promise<string>
  },
  cwd = '/workspace',
): Promise<ExecutionEnv> {
  if (!posix.isAbsolute(cwd) || cwd.includes('\0'))
    throw Error('An absolute Docker working directory is required')
  const guest = await readFile(resolveDockerGuestPath(config.guestPath), 'utf8')
  const {
    credentials = [],
    guestPath: _,
    dockerHost,
    hostEnv,
    run,
    ...options
  } = config
  const allow = restrictedAllow(options, credentials)
  if (credentials?.length && options.network === 'off')
    throw Error('Docker credentials cannot be used with network off')
  const docker = run ?? createDockerRunner(dockerHost, hostEnv)
  const transport = allow
    ? { directory: await restrictedDirectory(options, allow), allow }
    : undefined
  const binding =
    credentials.length || transport
      ? await openDockerCredentialBinding(credentials, docker, transport)
      : undefined
  try {
    const guestSocket =
      binding && 'proxySocket' in binding.guest
        ? binding.guest.proxySocket
        : undefined
    const { id, name } = await prepareDocker(
      allow ? { ...options, allow } : options,
      docker,
      transport && guestSocket
        ? { directory: transport.directory, socket: guestSocket }
        : undefined,
    )
    const env = containerOperations(
      id,
      name,
      cwd,
      guest,
      binding?.guest,
      dockerHost,
      hostEnv,
    )
    if (!binding) return env
    const baseCleanup = env.cleanup.bind(env)
    env.cleanup = async (signal) => {
      try {
        await baseCleanup(signal)
      } finally {
        await binding.close()
      }
    }
    return env
  } catch (error) {
    await binding?.close()
    throw error
  }
}
