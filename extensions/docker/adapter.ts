import { posix } from 'node:path'
import type { ExecutionEnv } from '@glows777/vela-core'
import { containerOperations, runDocker } from './container.ts'
import { type DockerOptions, prepareDocker } from './lifecycle.ts'

// Private factory for an owner-side caller. Binding the session resolver belongs to E3b.
export async function openDockerEnvironment(
  config: DockerOptions,
  cwd = '/workspace',
): Promise<ExecutionEnv> {
  if (!posix.isAbsolute(cwd) || cwd.includes('\0'))
    throw Error('An absolute Docker working directory is required')
  const { id, name } = await prepareDocker(config, runDocker)
  return containerOperations(id, name, cwd)
}
