/** Helpers for built-in extensions to read their config section (`vela.config`). A wrong type or an empty string counts as unset. */

export function configString(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value ? value : undefined
}

/** A string array; a comma-separated string (e.g. `"$FEISHU_OWNERS"`) is also accepted. */
export function configStrings(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  const value = config[key]
  const list =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : undefined
  const trimmed = list?.map((item) => item.trim()).filter(Boolean)
  return trimmed?.length ? trimmed : undefined
}
