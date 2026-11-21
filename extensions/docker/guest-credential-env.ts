import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type GuestCredentialConfig = {
  publicCa: string
  proxyUrl: string
  placeholders: Record<string, string>
  githubGit: boolean
}

export async function prepareGuestCredentials(config: GuestCredentialConfig) {
  const dir = await mkdtemp('/tmp/vela-credential-ca-')
  const ca = join(dir, 'ca.pem')
  const close = () => rm(dir, { force: true, recursive: true })
  try {
    await writeFile(ca, config.publicCa, { mode: 0o600 })
    const env: Record<string, string> = {
      ...config.placeholders,
      HTTPS_PROXY: config.proxyUrl,
      https_proxy: config.proxyUrl,
      SSL_CERT_FILE: ca,
      GIT_SSL_CAINFO: ca,
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
