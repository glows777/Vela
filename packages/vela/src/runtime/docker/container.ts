import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { GuestCredentialConfig } from '../../shared/docker-guest-credentials.ts'
import type { ExecutionEnv } from '../../shared/execution.ts'
import { dockerOperations, withDockerCwd } from './operations.ts'

const DEFAULT_DOCKER_SOCKET = 'unix:///var/run/docker.sock'

export const dockerContainerId = Symbol.for('vela.private.dockerContainerId')

export type DockerContainerEnv = ExecutionEnv & {
  [dockerContainerId]?: string
}

export function dockerClientPath(platform = process.platform): string {
  return platform === 'darwin'
    ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    : '/usr/local/bin:/usr/bin:/bin'
}

export function resolveDockerHost(
  hostEnv: Record<string, string | undefined> = {},
): string {
  const value = hostEnv.DOCKER_HOST?.trim()
  return value ? value : DEFAULT_DOCKER_SOCKET
}

const invoke = promisify(execFile)

export function createDockerRunner(
  dockerHost?: string,
  hostEnv: Record<string, string | undefined> = {},
) {
  const socket = dockerHost?.trim() || resolveDockerHost(hostEnv)
  const endpoint = ['--host', socket]
  const options = {
    cwd: '/',
    env: {
      PATH: dockerClientPath(),
      HOME: '/var/empty/vela-docker-client',
    },
  }
  return async function runDocker(args: string[]): Promise<string> {
    try {
      const { stdout } = await invoke('docker', [...endpoint, ...args], {
        ...options,
        maxBuffer: 4 * 1024 * 1024,
      })
      return stdout.trim()
    } catch (cause) {
      const detail = (cause as { stderr?: string }).stderr?.trim()
      throw new Error(
        `Docker at ${socket}: ${detail || 'Docker client or local engine unavailable'}`,
        { cause },
      )
    }
  }
}

export async function runDocker(args: string[]): Promise<string> {
  return createDockerRunner()(args)
}

// Operations always address the immutable ID that lifecycle inspection approved.
export function containerOperations(
  id: string,
  name: string,
  cwd: string,
  guest: string,
  credentials?: GuestCredentialConfig,
  dockerHost?: string,
  hostEnv: Record<string, string | undefined> = {},
): DockerContainerEnv {
  const endpoint = ['--host', dockerHost?.trim() || resolveDockerHost(hostEnv)]
  const options = {
    cwd: '/',
    env: {
      PATH: dockerClientPath(),
      HOME: '/var/empty/vela-docker-client',
    },
  }
  const base = dockerOperations(name, cwd, (op, workdir) =>
    spawn(
      'docker',
      [
        ...endpoint,
        'exec',
        '-i',
        '--workdir',
        '/workspace',
        id,
        'node',
        '-e',
        guest,
        '--',
        op,
        workdir,
        '/tmp/vela-results',
        ...(op === 'exec' && credentials ? [JSON.stringify(credentials)] : []),
      ],
      { ...options, stdio: 'pipe' },
    ),
  )
  const attachContainerId = (
    target: DockerContainerEnv,
  ): DockerContainerEnv => {
    target[dockerContainerId] = id
    const derive = (
      target as { [withDockerCwd]?: (nextCwd: string) => DockerContainerEnv }
    )[withDockerCwd]
    if (derive) {
      ;(
        target as { [withDockerCwd]?: (nextCwd: string) => DockerContainerEnv }
      )[withDockerCwd] = (nextCwd: string) => attachContainerId(derive(nextCwd))
    }
    return target
  }
  return attachContainerId(base)
}
