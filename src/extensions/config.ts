/** 内置扩展读配置段（`vela.config`）的小工具：类型不对或空串当作没配置。 */

export function configString(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value ? value : undefined
}

/** 字符串数组；也接受逗号分隔的字符串（例如 `"$FEISHU_OWNERS"`）。 */
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
