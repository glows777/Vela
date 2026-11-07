import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

type ObjectValue = Record<string, unknown>
function object(value: unknown, label: string): ObjectValue {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as ObjectValue
}

export function githubRepositories(values: readonly string[]): string[] {
  const repos = values.map((value) => value.trim().toLowerCase())
  if (
    !repos.length ||
    repos.some((repo) => {
      const [owner, name, extra] = repo.split('/')
      return (
        !owner ||
        !name ||
        extra !== undefined ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(owner) ||
        owner.length > 39 ||
        !/^[\w.-]+$/.test(name) ||
        name.length > 100 ||
        name === '.' ||
        name === '..'
      )
    })
  )
    throw new Error('Repositories must use GitHub owner/repo names')
  return [...new Set(repos)]
}

/** Check the raw path too: URL would otherwise erase /a/.. and /%2e. */
export function githubOrigin(value: string): string {
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value))
    throw new Error(
      'The public URL must be an HTTPS origin without credentials, path, query or fragment',
    )
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('The public URL must be a valid HTTPS origin')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    url.username ||
    url.password ||
    url.protocol !== 'https:' ||
    host === 'localhost'
  )
    throw new Error(
      'The public URL must be an HTTPS origin, not localhost, and have no credentials',
    )
  return url.origin
}

/** Keep saved expressions intact; only the gh payload gets the expanded value. */
function secretValue(raw: string, env: NodeJS.ProcessEnv): string {
  // Do not reuse core's interpolate: missing variables must throw, not become empty strings.
  const value = raw.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, bare: string | undefined) => {
      if (match === '$$') return '$'
      const expanded = env[(braced ?? bare)!]
      if (!expanded)
        throw new Error(
          'The saved GitHub secret references a missing environment variable',
        )
      return expanded
    },
  )
  if (!value.trim())
    throw new Error('The saved GitHub secret must not be empty')
  return value
}

export function prepareGithubSettings(
  agentDir: string,
  repositories: string[],
  env: NodeJS.ProcessEnv,
) {
  const path = join(agentDir, 'settings.json')
  let raw: unknown = {}
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf8')
    // JSON parse errors can include source snippets containing credentials.
    try {
      raw = JSON.parse(content)
    } catch {
      throw new Error(`Invalid JSON in ${path}; correct the file before setup`)
    }
  }
  const settings = object(raw, 'settings.json')
  const extensionConfig = object(settings.extensionConfig, 'extensionConfig')
  const channel = object(extensionConfig.channel, 'extensionConfig.channel')
  const eventReceiver = object(channel.eventReceiver, 'eventReceiver')
  const github = object(eventReceiver.github, 'eventReceiver.github')
  const port = eventReceiver.port === undefined ? 8787 : eventReceiver.port
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error(
      'eventReceiver.port must be a fixed integer from 1 to 65535 (not 0)',
    )
  const prior = github.repositories
  if (
    prior !== undefined &&
    (!Array.isArray(prior) || prior.some((repo) => typeof repo !== 'string'))
  )
    throw new Error(
      'eventReceiver.github.repositories must be an array of owner/repo names',
    )
  const merged = githubRepositories([
    ...((prior as string[] | undefined) ?? []),
    ...repositories,
  ])
  if (github.secret !== undefined && typeof github.secret !== 'string')
    throw new Error('eventReceiver.github.secret must be a string')
  const stored =
    (github.secret as string | undefined) ?? randomBytes(32).toString('hex')
  const secret = secretValue(stored, env)
  const updated = {
    ...settings,
    extensionConfig: {
      ...extensionConfig,
      channel: {
        ...channel,
        eventReceiver: {
          ...eventReceiver,
          port,
          github: { ...github, secret: stored, repositories: merged },
        },
      },
    },
  }
  return { path, secret, settings: updated }
}

/** Rename a private sibling file so failed writes cannot truncate the saved settings. */
export function saveGithubSettings(
  agentDir: string,
  path: string,
  settings: unknown,
): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  chmodSync(agentDir, 0o700)
  const temporary = join(
    agentDir,
    `.settings-${randomBytes(12).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
