import { randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { createCredentialIdentity } from './credential-identity.ts'
import { openCredentialProxy } from './credential-proxy.ts'
import type { GuestCredentialConfig } from './guest-credential-env.ts'

export type DockerCredential = {
  variable: string
  value: string
  origins: readonly string[]
}

export async function openDockerCredentialBinding(
  credentials: readonly DockerCredential[],
  docker: (args: string[]) => Promise<string>,
) {
  const bindHost =
    process.platform === 'darwin'
      ? '127.0.0.1'
      : await docker([
          'network',
          'inspect',
          'bridge',
          '--format',
          '{{with index .IPAM.Config 0}}{{.Gateway}}{{end}}',
        ])
  if (!isIPv4(bindHost) || bindHost === '0.0.0.0')
    throw Error('Docker credential proxy needs a local IPv4 bridge gateway')
  const guestHost =
    process.platform === 'darwin' ? 'host.docker.internal' : bindHost
  const placeholders = Object.fromEntries(
    credentials.map(({ variable }) => [
      variable,
      `vela-credential-${randomBytes(24).toString('hex')}`,
    ]),
  )
  const origins = credentials.flatMap((entry) => entry.origins)
  const identity = await createCredentialIdentity([
    ...new Set(origins.map((origin) => new URL(origin).hostname)),
  ])
  const proxy = await openCredentialProxy({
    listenHost: bindHost,
    identity,
    credentials: credentials.map(({ variable, ...entry }) => ({
      ...entry,
      placeholder: placeholders[variable]!,
    })),
  })
  const guest: GuestCredentialConfig = {
    publicCa: identity.ca,
    proxyUrl: `http://${guestHost}:${proxy.port}`,
    placeholders,
    githubGit: credentials.some(
      ({ variable, origins }) =>
        variable === 'GH_TOKEN' && origins.includes('https://github.com'),
    ),
  }
  return { guest, close: proxy.close }
}
