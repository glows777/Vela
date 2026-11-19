import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { ExecutionEnv } from '@glows777/vela-core'
import { containerOperations, runDocker } from './container.ts'
import { type DockerOptions, prepareDocker } from './lifecycle.ts'

// Validate the installed guest before creating or starting an owned container.
export async function openDockerEnvironment(
  config: DockerOptions,
  cwd = '/workspace',
): Promise<ExecutionEnv> {
  if (!posix.isAbsolute(cwd) || cwd.includes('\0'))
    throw Error('An absolute Docker working directory is required')
  const guest = await readFile(new URL('./guest.cjs', import.meta.url), 'utf8')
  const { id, name } = await prepareDocker(config, runDocker)
  return containerOperations(id, name, cwd, guest)
}
