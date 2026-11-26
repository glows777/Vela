import { errorMessage } from '../../../packages/vela/src/cli/error.ts'
import { parseArgs } from '../../../packages/vela/src/cli/setup.ts'
import type { LocalOptions } from '../../../packages/vela/src/legacy-channels/index.ts'
import { local } from '../../../packages/vela/src/legacy-channels/index.ts'
import { loadConfig } from '../../../packages/vela/src/load-config.ts'
import { McpPool } from '../../../packages/vela/src/mcp/index.ts'
import { usableModel } from '../../../packages/vela/src/settings.ts'
import { createVela } from '../../../packages/vela/src/vela.ts'
import {
  BUILTIN_EXTENSIONS,
  cliHostExtensionConfig,
  cliProjectExtensions,
  cliWorkspaceModeAt,
  loadCliExtensions,
  ownerDocker,
} from '../../support/legacy-cli-helpers.ts'
import { runServe } from './serve-helper.ts'

const env = process.env
const cwd = process.cwd()
const args = parseArgs([])
const config = loadConfig({
  cwd,
  agentDir: env.VELA_DIR,
  env,
  builtins: Object.keys(BUILTIN_EXTENSIONS),
})
const docker = ownerDocker(config)
const mcpPool = new McpPool()
const rawLocal = (config.extensionConfig.local ?? {}) as Record<string, unknown>
const localOptions: LocalOptions = {
  ...(typeof rawLocal.token === 'string' ? { token: rawLocal.token } : {}),
  ...(typeof rawLocal.port === 'number' ? { port: rawLocal.port } : {}),
  ...(typeof rawLocal.timezone === 'string'
    ? { timezone: rawLocal.timezone }
    : {}),
}
const extensions = [
  ...(await loadCliExtensions(
    config,
    args,
    (m) => console.error(m),
    true,
    mcpPool,
  )),
  ...(config.settings.local?.enabled ? [local(localOptions)] : []),
]
const resolvedModel =
  env.VELA_MODEL === 'mock'
    ? (
        await import('../../../packages/vela/src/testing/core/index.ts')
      ).createMockModel()
    : env.VELA_MODEL?.startsWith('faux:')
      ? await (
          await import('../../../packages/vela/src/testing/core/index.ts')
        ).loadFauxScenario(env.VELA_MODEL.slice('faux:'.length))
      : usableModel({
            model: config.settings.model,
            providers: config.providers,
            credentials: config.credentials,
          }).usable
        ? config.settings.model
        : undefined
const vela = createVela({
  cwd,
  agentDir: config.agentDir,
  dataDir: config.dataDir,
  model: resolvedModel,
  thinkingLevel: config.settings.thinkingLevel,
  providers: config.providers,
  credentials: config.credentials,
  limits: config.settings.limits,
  extensions,
  extensionConfig: {
    ...cliHostExtensionConfig(config, args),
    ...(config.settings.local?.enabled
      ? { local: localOptions as Record<string, unknown> }
      : {}),
  },
  env: docker?.env,
  offline: env.VELA_OFFLINE === '1',
  sessionResources: config.sessionResources
    ? {
        ...config.sessionResources,
        workspaceModeAt: (location: string, environment?: string) =>
          cliWorkspaceModeAt({
            agentDir: config.agentDir,
            dataDir: config.dataDir,
            startupCwd: cwd,
            location,
            environment,
          }),
        projectExtensions: cliProjectExtensions(
          config,
          args,
          (message) => console.error(message),
          mcpPool,
        ),
      }
    : undefined,
  beforeDispose: async () => {
    await docker?.beforeDispose()
    await mcpPool.dispose()
  },
})
const code = await runServe({
  vela,
  write: (line) => process.stderr.write(`${line}\n`),
}).catch(async (error) => {
  process.stderr.write(`[local-serve] ${errorMessage(error)}\n`)
  await vela.dispose().catch(() => {})
  return 1
})
process.exit(code)
