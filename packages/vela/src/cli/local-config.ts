import type { LocalOptions } from '@glows777/vela-channels'

/** Only the CLI's real serve mode may enable the user-configured local listener. */
export function localServeOptions(
  userConfig: Record<string, Record<string, unknown>>,
  serve: boolean,
): (LocalOptions & { token: string }) | undefined {
  if (!serve) return
  const config = userConfig.local
  if (config === undefined) return
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('extensionConfig.local must be an object')
  if (config.enabled === undefined || config.enabled === false) return
  if (config.enabled !== true)
    throw new Error('extensionConfig.local.enabled must be true or false')
  if (
    typeof config.token !== 'string' ||
    !config.token.trim() ||
    /[\r\n]/.test(config.token)
  )
    throw new Error(
      'extensionConfig.local.token must be a nonempty bearer token',
    )
  const port = config.port === undefined ? 8788 : config.port
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error(
      'extensionConfig.local.port must be an integer between 0 and 65535',
    )
  if (config.timezone !== undefined) {
    if (typeof config.timezone !== 'string' || !config.timezone.trim())
      throw new Error('extensionConfig.local.timezone must be a valid timezone')
    try {
      new Intl.DateTimeFormat('en', { timeZone: config.timezone })
    } catch {
      throw new Error('extensionConfig.local.timezone must be a valid timezone')
    }
  }
  return {
    token: config.token,
    port,
    ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
  }
}
