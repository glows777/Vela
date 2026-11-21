import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { posix } from 'node:path'
import type { ExecutionEnv } from '@glows777/vela-core'
import { containerOperations, runDocker } from './container.ts'
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

// Validate the installed guest before creating or starting an owned container.
export async function openDockerEnvironment(
  config: DockerOptions & { credentials?: readonly DockerCredential[] },
  cwd = '/workspace',
): Promise<ExecutionEnv> {
  if (!posix.isAbsolute(cwd) || cwd.includes('\0'))
    throw Error('An absolute Docker working directory is required')
  const guest = await readFile(new URL('./guest.cjs', import.meta.url), 'utf8')
  const { credentials = [], ...options } = config
  const allow = restrictedAllow(options, credentials)
  if (credentials?.length && options.network === 'off')
    throw Error('Docker credentials cannot be used with network off')
  const transport = allow
    ? { directory: await restrictedDirectory(options, allow), allow }
    : undefined
  const binding =
    credentials.length || transport
      ? await openDockerCredentialBinding(credentials, runDocker, transport)
      : undefined
  try {
    const guestSocket =
      binding && 'proxySocket' in binding.guest
        ? binding.guest.proxySocket
        : undefined
    const { id, name } = await prepareDocker(
      allow ? { ...options, allow } : options,
      runDocker,
      transport && guestSocket
        ? { directory: transport.directory, socket: guestSocket }
        : undefined,
    )
    const env = containerOperations(id, name, cwd, guest, binding?.guest)
    if (!binding) return env
    return {
      ...env,
      async cleanup() {
        try {
          await env.cleanup()
        } finally {
          await binding.close()
        }
      },
    }
  } catch (error) {
    await binding?.close()
    throw error
  }
}
