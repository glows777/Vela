import { spawnSync } from 'node:child_process'
import {
  githubOrigin,
  githubRepositories,
  prepareGithubSettings,
  saveGithubSettings,
} from './github-setup-config.ts'

const EVENTS = [
  'check_suite',
  'pull_request_review',
  'issue_comment',
  'pull_request',
]
interface GithubSetupOptions {
  agentDir: string
  repositories: string[]
  url?: string
  interactive: boolean
  env?: NodeJS.ProcessEnv
  input?: (title: string, placeholder?: string) => Promise<string | undefined>
  write?: (text: string) => void
}

function gh(args: string[], env: NodeJS.ProcessEnv, input?: unknown): string {
  const result = spawnSync('gh', args, {
    env,
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() || `gh exited with status ${result.status}`,
    )
  return result.stdout
}

function matchingHooks(text: string, payloadUrl: string): { id: number }[] {
  let pages: unknown
  try {
    pages = JSON.parse(text)
  } catch {
    throw new Error('gh returned invalid hook-list JSON')
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('gh returned an invalid paginated hook list')
  const matches: { id: number }[] = []
  for (const hook of pages.flat()) {
    if (
      !hook ||
      typeof hook !== 'object' ||
      typeof hook.config?.url !== 'string'
    )
      throw new Error('gh returned an invalid hook entry')
    let url: string
    try {
      url = new URL(hook.config.url).href
    } catch {
      continue
    }
    if (url !== payloadUrl) continue
    if (!Number.isSafeInteger(hook.id) || hook.id < 1)
      throw new Error('gh returned an invalid matching hook ID')
    matches.push({ id: hook.id })
  }
  return matches
}

/** Setup is deliberately independent of model setup, config discovery and extension startup. */
export async function githubSetup(
  options: GithubSetupOptions,
): Promise<0 | 1 | 2> {
  const write = options.write ?? console.log
  const env = options.env ?? process.env
  let secret = ''
  const redact = (error: unknown) => {
    let text = error instanceof Error ? error.message : String(error)
    if (secret) {
      text = text.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]')
      text = text.replaceAll(secret, '[redacted]')
    }
    return text
  }
  try {
    let repos = options.repositories
    let url = options.url
    if (!repos.length || !url) {
      if (!options.interactive || !options.input) {
        write(
          'GitHub repositories and --url are required without an interactive terminal. Usage: vela setup github owner/repo [owner/repo...] --url https://origin',
        )
        return 2
      }
      if (!repos.length) {
        const answer = await options.input(
          'GitHub repositories',
          'owner/repo [owner/repo...]',
        )
        if (!answer) return 0
        repos = answer.trim().split(/\s+/)
      }
      if (!url) {
        url = await options.input(
          'Public HTTPS origin',
          'https://your-tunnel.example.com',
        )
        if (!url) return 0
      }
    }
    const repositories = githubRepositories(repos)
    const payloadUrl = `${githubOrigin(url)}/events/github`
    const prepared = prepareGithubSettings(options.agentDir, repositories, env)
    secret = prepared.secret
    saveGithubSettings(options.agentDir, prepared.path, prepared.settings)
    write(
      `Saved GitHub receiver settings to ${prepared.path}. Project settings may override user settings; check the effective configuration before serving.`,
    )
    try {
      gh(['auth', 'status', '--hostname', 'github.com'], env)
    } catch (error) {
      write(
        `gh is unavailable or not logged in to github.com: ${redact(error)}. Install GitHub CLI and run gh auth login --hostname github.com, then rerun setup, or configure hooks manually:`,
      )
      for (const repo of repositories)
        write(`https://github.com/${repo}/settings/hooks`)
      write(
        `Payload URL: ${payloadUrl}\nContent type: application/json\nSSL verification: enabled\nEvents: ${EVENTS.join(', ')}\nActive: yes\nSensitive webhook secret (do not share): ${secret}`,
      )
      write(nextSteps())
      return 1
    }
    let failed = false
    for (const repo of repositories) {
      try {
        const endpoint = `repos/${repo}/hooks`
        const hooks = matchingHooks(
          gh(
            [
              'api',
              '--hostname',
              'github.com',
              `${endpoint}?per_page=100`,
              '--paginate',
              '--slurp',
            ],
            env,
          ),
          payloadUrl,
        )
        if (hooks.length > 1)
          throw new Error(
            'Multiple hooks match this payload URL; remove duplicates manually before rerunning setup',
          )
        const existing = hooks[0]
        gh(
          [
            'api',
            '--hostname',
            'github.com',
            existing ? `${endpoint}/${existing.id}` : endpoint,
            '--method',
            existing ? 'PATCH' : 'POST',
            '--input',
            '-',
          ],
          env,
          {
            name: 'web',
            active: true,
            config: {
              url: payloadUrl,
              content_type: 'json',
              insecure_ssl: '0',
              secret,
            },
            events: EVENTS,
          },
        )
        write(`${repo}: ${existing ? 'updated' : 'created'} webhook`)
      } catch (error) {
        failed = true
        write(
          `${repo}: ${redact(error)}. Check repository administration permissions and https://github.com/${repo}/settings/hooks. Successful hooks and local configuration are retained; rerun setup after correcting the problem.`,
        )
      }
    }
    write(nextSteps())
    return failed ? 1 : 0
  } catch (error) {
    write(`GitHub setup failed: ${redact(error)}`)
    return 1
  }
}

function nextSteps(): string {
  return 'Restart vela serve after setup. An enabled, connected channel is required to receive routed events. Hook creation does not verify tunnel reachability or listener delivery; check Recent deliveries in GitHub. Hooks at an old URL are left unchanged; clean them up manually.'
}
