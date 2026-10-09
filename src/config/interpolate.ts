type Env = Record<string, string | undefined>

/**
 * Replaces `$NAME` / `${NAME}` with environment variables (empty string when unset);
 * `$$` is a literal `$`. Same syntax as pi's models.json; pi's `!command` is not supported.
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

/** Interpolates every string in a JSON value, recursing into objects and arrays. */
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

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep merge: recurses when both sides are objects; otherwise `override` wins (arrays too). */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override))
    result[key] = key in base ? deepMerge(base[key], value) : value
  return result
}
