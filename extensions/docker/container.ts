import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { ExecutionEnv } from '@glows777/vela-core'
import { dockerOperations } from './operations.ts'

const path = '/usr/local/bin:/usr/bin:/bin'
const options = {
  cwd: '/',
  env: { PATH: path, HOME: '/var/empty/vela-docker-client' },
}
const socket = 'unix:///var/run/docker.sock'
const endpoint = ['--host', socket]
const invoke = promisify(execFile)
export async function runDocker(args: string[]) {
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

// Operations always address the immutable ID that lifecycle inspection approved.
export async function containerOperations(
  id: string,
  name: string,
  cwd: string,
): Promise<ExecutionEnv> {
  const guest = await readFile(new URL('./guest.cjs', import.meta.url), 'utf8')
  return dockerOperations(name, cwd, (op, workdir) =>
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
      ],
      { ...options, stdio: 'pipe' },
    ),
  )
}
