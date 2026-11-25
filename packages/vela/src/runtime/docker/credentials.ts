import { isIP } from 'node:net'
import type { DockerCredential } from './credential-binding.ts'

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/
const hostReference =
  /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/
const dnsHost =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function origin(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(value)
  )
    return
  try {
    const parsed = new URL(value)
    return dnsHost.test(parsed.hostname) && !isIP(parsed.hostname)
      ? parsed.origin
      : undefined
  } catch {
    return
  }
}

export function ownerDockerCredentials(
  credentials: unknown,
  network: 'on' | 'off' | 'restricted' | undefined,
  environment: string,
  hostEnv: Record<string, string | undefined> = {},
): DockerCredential[] {
  const invalid = (description: string): never => {
    throw Error(
      `Invalid Docker credentials for owner environment "${environment}": ${description}`,
    )
  }
  if (credentials === undefined) return []
  if (network === 'off') invalid('credentials cannot be used with network off')
  if (!record(credentials)) return invalid('credentials must be an object')

  return Object.entries(credentials).map(([variable, entry]) => {
    if (!variableName.test(variable))
      return invalid('invalid guest variable name')
    if (
      !record(entry) ||
      Object.keys(entry).some((key) => key !== 'value' && key !== 'origins')
    )
      return invalid(`${variable} must contain only a value and HTTPS origins`)
    const match =
      typeof entry.value === 'string' && hostReference.exec(entry.value)
    if (!match)
      return invalid(
        `${variable} must use a host environment variable reference`,
      )
    if (!Array.isArray(entry.origins) || entry.origins.length === 0)
      return invalid(`${variable} requires at least one exact HTTPS origin`)
    const origins = entry.origins.map(
      (value) =>
        origin(value) ??
        invalid(
          `${variable} requires exact HTTPS origins with the default port`,
        ),
    )
    const host = (match[1] ?? match[2])!
    const value = hostEnv[host]
    if (!value) return invalid(`host variable ${host} is unset or empty`)
    if (/[\r\n\0]/u.test(value))
      return invalid(`host variable ${host} contains invalid header characters`)
    return { variable, value, origins: [...new Set(origins)] }
  })
}
