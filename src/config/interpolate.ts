type Env = Record<string, string | undefined>

/**
 * 字符串里的 `$NAME` / `${NAME}` 换成环境变量（没设置时为空串），`$$` 是字面的 `$`。
 * 同 pi 的 models.json 写法；不支持 pi 的 `!command`。
 */
export function interpolate(value: string, env: Env): string {
  return value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, bare?: string) => {
      if (match === '$$') return '$'
      return env[(braced ?? bare) as string] ?? ''
    },
  )
}

/** 对 JSON 值里所有字符串做 interpolate（对象、数组递归）。 */
export function interpolateDeep<T>(value: T, env: Env): T {
  if (typeof value === 'string') return interpolate(value, env) as T
  if (Array.isArray(value))
    return value.map((item) => interpolateDeep(item, env)) as T
  if (isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, env)]),
    ) as T
  return value
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 对象深合并：两边都是对象时递归，否则 override 覆盖（数组也直接覆盖）。 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override))
    result[key] = key in base ? deepMerge(base[key], value) : value
  return result
}
