import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { ExecutionEnv } from '@glows777/vela-core'
import { containerOperations, runDocker } from './container.ts'
import {
  type DockerCredential,
  openDockerCredentialBinding,
} from './credential-binding.ts'
import { type DockerOptions, prepareDocker } from './lifecycle.ts'

// Validate the installed guest before creating or starting an owned container.
export async function openDockerEnvironment(
  config: DockerOptions & { credentials?: readonly DockerCredential[] },
  cwd = '/workspace',
): Promise<ExecutionEnv> {
  if (!posix.isAbsolute(cwd) || cwd.includes('\0'))
    throw Error('An absolute Docker working directory is required')
  const guest = await readFile(new URL('./guest.cjs', import.meta.url), 'utf8')
  const { credentials, ...options } = config
  if (credentials?.length && options.network === 'off')
    throw Error('Docker credentials require network on, not off')
  const binding = credentials?.length
    ? await openDockerCredentialBinding(credentials, runDocker)
    : undefined
  try {
    const { id, name } = await prepareDocker(options, runDocker)
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
