import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { formatJsonParseError, parseConfig } from '../config/schema.ts'
import { LEGACY_CONFIG_FILES } from '../config/writer.ts'
import { isPlainObject } from '../shared/interpolate.ts'

const CONFIG_LOCK_TIMEOUT_MS = 10_000
const CONFIG_STALE_LOCK_MS = 30_000
const CONFIG_LOCK_RETRY_MS = 15
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function withLegacyConfigLockSync<T>(
  agentDir: string,
  fn: (assertOwned: () => void) => T,
): T {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  chmodSync(agentDir, 0o700)
  const lock = join(agentDir, 'config.json.lock')
  const token = `${process.pid}:${randomUUID()}`
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try {
        writeSync(fd, token)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > CONFIG_STALE_LOCK_MS)
          rmSync(lock, { force: true })
      } catch {}
      if (Date.now() - started > CONFIG_LOCK_TIMEOUT_MS)
        throw new Error(
          `Timed out waiting for ${lock}; if no other Vela is modifying config.json, delete it`,
        )
      Atomics.wait(sleepBuffer, 0, 0, CONFIG_LOCK_RETRY_MS)
    }
  }
  const assertOwned = () => {
    let holder: string | undefined
    try {
      holder = readFileSync(lock, 'utf8')
    } catch {}
    if (holder !== token)
      throw new Error(
        `Lost ${lock} ownership before committing config.json update`,
      )
  }
  try {
    return fn(assertOwned)
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true })
    } catch {}
  }
}

function writeConfigIfMissing(
  agentDir: string,
  data: Record<string, unknown>,
): { written: boolean; path: string; sha256?: string } {
  return withLegacyConfigLockSync(agentDir, (assertOwned) => {
    const path = join(agentDir, 'config.json')
    if (existsSync(path)) return { written: false, path }
    const serialized = `${JSON.stringify(data, null, 2)}\n`
    parseConfig(serialized, path)
    const temporary = join(
      agentDir,
      `.config-${randomBytes(12).toString('hex')}.tmp`,
    )
    try {
      writeFileSync(temporary, serialized, {
        mode: 0o600,
        flag: 'wx',
      })
      chmodSync(temporary, 0o600)
      assertOwned()
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
    const sha256 = createHash('sha256').update(serialized).digest('hex')
    return { written: true, path, sha256 }
  })
}

export function removeConfigIfHashMatches(
  agentDir: string,
  expectedSha256: string,
): boolean {
  return withLegacyConfigLockSync(agentDir, (assertOwned) => {
    const path = join(agentDir, 'config.json')
    if (!existsSync(path)) return false
    const actualSha256 = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex')
    if (actualSha256 !== expectedSha256) return false
    assertOwned()
    rmSync(path, { force: true })
    return true
  })
}

interface LegacyConfigInputs {
  settings?: unknown
  models?: unknown
  mcp?: unknown
  files?: {
    settings?: string
    models?: string
    mcp?: string
  }
  targetFile?: string
}

export interface LegacyConfigMigrationResult {
  migrated: boolean
  createdConfig: boolean
  createdSha256?: string
  path: string
  sources: string[]
  warnings: string[]
}

const FLATTENED_EXTENSION_SECTIONS = ['lark', 'web', 'memory', 'local'] as const

const RETIRED_SETTINGS_KEYS = [
  'bashForegroundTimeoutSeconds',
  'bashForegroundTimeoutMaxSeconds',
] as const

function mergeRecord(
  base: unknown,
  override: unknown,
  label: string,
): Record<string, unknown> {
  if (base !== undefined && !isPlainObject(base))
    throw new Error(`${label} must be an object`)
  if (override !== undefined && !isPlainObject(override))
    throw new Error(`${label} must be an object`)
  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(override) ? override : {}),
  }
}

function readLegacyJson(file: string): unknown {
  const text = readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(formatJsonParseError(file, text, error))
  }
}

/**
 * Pure transformation from legacy v0.8 config files (`settings.json`, `models.json`, `mcp.json`)
 * into a validated flat v0.9 `config.json` object.
 */
function flattenLegacyConfig(inputs: LegacyConfigInputs): {
  config: Record<string, unknown>
  warnings: string[]
} {
  const warnings: string[] = []
  const targetFile = inputs.targetFile ?? 'config.json'
  const settingsFile = inputs.files?.settings ?? 'settings.json'
  const modelsFile = inputs.files?.models ?? 'models.json'
  const mcpFile = inputs.files?.mcp ?? 'mcp.json'

  if (inputs.settings !== undefined && !isPlainObject(inputs.settings))
    throw new Error(`${settingsFile} must be a JSON object`)
  if (inputs.models !== undefined && !isPlainObject(inputs.models))
    throw new Error(`${modelsFile} must be a JSON object`)
  if (inputs.mcp !== undefined && !isPlainObject(inputs.mcp))
    throw new Error(`${mcpFile} must be a JSON object`)

  const config: Record<string, unknown> = inputs.settings
    ? { ...inputs.settings }
    : {}

  if ('$schema' in config) {
    delete config.$schema
    warnings.push(`Dropped "$schema" from ${settingsFile}`)
  }

  const renameKey = (legacyKey: string, nextKey: string) => {
    if (!(legacyKey in config)) return
    const legacyValue = config[legacyKey]
    delete config[legacyKey]
    if (legacyValue !== undefined && config[nextKey] === undefined) {
      config[nextKey] = legacyValue
    }
  }
  renameKey('defaultModel', 'model')
  renameKey('defaultThinkingLevel', 'thinkingLevel')
  renameKey('defaultTools', 'tools')

  for (const retiredKey of RETIRED_SETTINGS_KEYS) {
    if (retiredKey in config) {
      delete config[retiredKey]
      warnings.push(
        `Dropped retired setting "${retiredKey}" from ${settingsFile}`,
      )
    }
  }

  if (config.extensionConfig !== undefined) {
    if (!isPlainObject(config.extensionConfig))
      throw new Error(`${settingsFile}: extensionConfig must be an object`)
    const nextExtensionConfig: Record<string, unknown> = {}
    for (const [name, rawSection] of Object.entries(config.extensionConfig)) {
      if (name === 'background' || name === 'todo') {
        if (isPlainObject(rawSection) && Object.keys(rawSection).length > 0) {
          warnings.push(
            `Dropped deprecated extensionConfig.${name} section during migration`,
          )
        }
        continue
      }
      if ((FLATTENED_EXTENSION_SECTIONS as readonly string[]).includes(name)) {
        if (!isPlainObject(rawSection))
          throw new Error(
            `${settingsFile}: extensionConfig.${name} must be an object`,
          )
        config[name] = mergeRecord(
          rawSection,
          config[name],
          `${settingsFile}: ${name}`,
        )
        continue
      }
      if (name === 'channel') {
        if (!isPlainObject(rawSection))
          throw new Error(
            `${settingsFile}: extensionConfig.channel must be an object`,
          )
        const rest = { ...rawSection }
        if ('eventReceiver' in rest) {
          const receiver = rest.eventReceiver
          delete rest.eventReceiver
          if (receiver !== undefined) {
            config.webhooks = mergeRecord(
              receiver,
              config.webhooks,
              `${settingsFile}: webhooks`,
            )
          }
        }
        if ('eventDefaultTarget' in rest) {
          const target = rest.eventDefaultTarget
          delete rest.eventDefaultTarget
          if (target !== undefined && config.eventDefaultTarget === undefined) {
            config.eventDefaultTarget = target
          }
        }
        for (const unsupportedKey of Object.keys(rest)) {
          warnings.push(
            `${settingsFile}: dropped unsupported extensionConfig.channel.${unsupportedKey} during migration`,
          )
        }
        continue
      }
      if (name === 'mcp') {
        if (!isPlainObject(rawSection))
          throw new Error(
            `${settingsFile}: extensionConfig.mcp must be an object`,
          )
        const rest = { ...rawSection }
        if ('mcpServers' in rest) {
          const servers = rest.mcpServers
          delete rest.mcpServers
          if (servers !== undefined) {
            config.mcpServers = mergeRecord(
              config.mcpServers,
              servers,
              `${settingsFile}: mcpServers`,
            )
          }
        }
        for (const unsupportedKey of Object.keys(rest)) {
          warnings.push(
            `${settingsFile}: dropped unsupported extensionConfig.mcp.${unsupportedKey} during migration`,
          )
        }
        continue
      }
      nextExtensionConfig[name] = rawSection
    }
    if (Object.keys(nextExtensionConfig).length > 0) {
      config.extensionConfig = nextExtensionConfig
    } else {
      delete config.extensionConfig
    }
  }

  if (inputs.models && isPlainObject(inputs.models)) {
    const modelsProviders = inputs.models.providers
    if (modelsProviders !== undefined) {
      config.providers = mergeRecord(
        config.providers,
        modelsProviders,
        `${modelsFile}: providers`,
      )
    }
  }

  if (inputs.mcp && isPlainObject(inputs.mcp)) {
    const mcpServers = inputs.mcp.mcpServers
    if (mcpServers !== undefined) {
      config.mcpServers = mergeRecord(
        config.mcpServers,
        mcpServers,
        `${mcpFile}: mcpServers`,
      )
    }
  }

  if (Array.isArray(config.extensions)) {
    const nextExtensions: unknown[] = []
    for (const entry of config.extensions) {
      if (typeof entry === 'string' && /^[+-]?builtin:rag$/.test(entry)) {
        warnings.push(
          `Dropped retired extension "${entry}" from ${settingsFile}`,
        )
        continue
      }
      nextExtensions.push(entry)
    }
    config.extensions = nextExtensions
  }

  parseConfig(JSON.stringify(config), targetFile)
  return { config, warnings }
}

/**
 * Automatically flattens legacy `<agentDir>/{settings,models,mcp}.json` into `<agentDir>/config.json`
 * in read-only mode (all legacy files stay untouched on disk). No-op when `config.json` already exists.
 */
export function migrateLegacyConfigFiles(
  agentDir: string,
): LegacyConfigMigrationResult {
  const targetPath = join(agentDir, 'config.json')
  if (existsSync(targetPath)) {
    return {
      migrated: false,
      createdConfig: false,
      path: targetPath,
      sources: [],
      warnings: [],
    }
  }

  const sources = LEGACY_CONFIG_FILES.map((name) =>
    join(agentDir, name),
  ).filter((file) => existsSync(file))
  if (sources.length === 0) {
    return {
      migrated: false,
      createdConfig: false,
      path: targetPath,
      sources: [],
      warnings: [],
    }
  }

  const settingsFile = join(agentDir, 'settings.json')
  const modelsFile = join(agentDir, 'models.json')
  const mcpFile = join(agentDir, 'mcp.json')
  const { config, warnings } = flattenLegacyConfig({
    settings: existsSync(settingsFile)
      ? readLegacyJson(settingsFile)
      : undefined,
    models: existsSync(modelsFile) ? readLegacyJson(modelsFile) : undefined,
    mcp: existsSync(mcpFile) ? readLegacyJson(mcpFile) : undefined,
    files: {
      settings: settingsFile,
      models: modelsFile,
      mcp: mcpFile,
    },
    targetFile: targetPath,
  })

  const writeResult = writeConfigIfMissing(agentDir, config)
  return {
    migrated: writeResult.written,
    createdConfig: writeResult.written,
    createdSha256: writeResult.sha256,
    path: writeResult.path,
    sources,
    warnings,
  }
}
