import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getCACertificates } from 'node:tls'
import { openGuestHttpsRouter } from './docker-guest-https-router.ts'

export type GuestCredentialConfig = (
  | { proxyUrl: string }
  | { proxySocket: string }
) & {
  publicCa: string
  origins: readonly string[]
  placeholders: Record<string, string>
  githubGit: boolean
}

export async function prepareGuestCredentials(
  config: GuestCredentialConfig,
  cwd: string,
  caPaths: { SSL_CERT_FILE?: string; GIT_SSL_CAINFO?: string },
) {
  const dir = await mkdtemp('/tmp/vela-credential-ca-')
  const ca = join(dir, 'ca.pem')
  let router: Awaited<ReturnType<typeof openGuestHttpsRouter>> | undefined
  const close = async () => {
    try {
      await router?.close()
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  }
  try {
    const systemRoots = () => {
      const roots = getCACertificates('system')
      return roots.length ? roots : getCACertificates('bundled')
    }
    const writeBundle = async (path: string, input?: string) => {
      const roots = input
        ? [await readFile(resolve(cwd, input), 'utf8')]
        : systemRoots()
      await writeFile(path, [...roots, config.publicCa].join('\n'), {
        mode: 0o600,
      })
    }
    const gitCa = caPaths.GIT_SSL_CAINFO ? join(dir, 'git-ca.pem') : ca
    await writeBundle(ca, caPaths.SSL_CERT_FILE)
    if (gitCa !== ca) await writeBundle(gitCa, caPaths.GIT_SSL_CAINFO)
    router = await openGuestHttpsRouter(
      'proxySocket' in config
        ? { socket: config.proxySocket }
        : { url: config.proxyUrl },
      config.origins,
    )
    const env: Record<string, string> = {
      ...config.placeholders,
      HTTPS_PROXY: router.url,
      https_proxy: router.url,
      SSL_CERT_FILE: ca,
      GIT_SSL_CAINFO: gitCa,
    }
    if (config.githubGit)
      Object.assign(env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_0:
          '!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f',
      })
    return { env, close }
  } catch (error) {
    await close()
    throw error
  }
}
