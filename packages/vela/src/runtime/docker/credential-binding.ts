import { randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import type { GuestCredentialConfig } from '../../shared/docker-guest-credentials.ts'
import { createCredentialIdentity } from './credential-identity.ts'
import {
  credentialOriginHost,
  openCredentialProxy,
} from './credential-proxy.ts'
import { restrictedGuestDir } from './lifecycle.ts'

export type DockerCredential = {
  variable: string
  value: string
  origins: readonly string[]
}

export async function openDockerCredentialBinding(
  credentials: readonly DockerCredential[],
  docker: (args: string[]) => Promise<string>,
  restricted?: { directory: string; allow: readonly string[] },
) {
  const origins = [...new Set(credentials.flatMap((entry) => entry.origins))]
  const hosts = origins.map(credentialOriginHost)
  const socketName = restricted
    ? `p-${randomBytes(12).toString('hex')}.sock`
    : undefined
  const bindHost = restricted
    ? undefined
    : process.platform === 'darwin'
      ? '127.0.0.1'
      : await docker([
          'network',
          'inspect',
          'bridge',
          '--format',
          '{{with index .IPAM.Config 0}}{{.Gateway}}{{end}}',
        ])
  if (!restricted && (!bindHost || !isIPv4(bindHost) || bindHost === '0.0.0.0'))
    throw Error('Docker credential proxy needs a local IPv4 bridge gateway')
  const guestHost =
    process.platform === 'darwin' ? 'host.docker.internal' : bindHost
  const placeholders = Object.fromEntries(
    credentials.map(({ variable }) => [
      variable,
      `vela-credential-${randomBytes(24).toString('hex')}`,
    ]),
  )
  const identity = await createCredentialIdentity(restricted?.allow ?? hosts)
  const proxy = await openCredentialProxy({
    ...(restricted
      ? {
          socketPath: join(restricted.directory, socketName!),
          allowedHosts: restricted.allow,
        }
      : { listenHost: bindHost! }),
    identity,
    credentials: credentials.map(({ variable, ...entry }) => ({
      ...entry,
      placeholder: placeholders[variable]!,
    })),
  })
  const guest: GuestCredentialConfig = {
    ...(socketName
      ? { proxySocket: join(restrictedGuestDir, socketName) }
      : { proxyUrl: `http://${guestHost}:${proxy.port}` }),
    publicCa: identity.ca,
    placeholders,
    origins,
    githubGit: credentials.some(
      ({ variable, origins }) =>
        variable === 'GH_TOKEN' && origins.includes('https://github.com'),
    ),
  }
  return { guest, close: proxy.close }
}
