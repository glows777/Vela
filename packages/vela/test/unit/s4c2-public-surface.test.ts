import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

const EXPECTED_ROOT_RUNTIME_EXPORTS = [
  'DaemonAlreadyRunningError',
  'EnvironmentRegistry',
  'LarkChannelAdapter',
  'RuntimeWebhookReceiver',
  'connectRuntime',
  'createLarkChannelAdapter',
  'createLocalExecutionEnv',
  'createRuntime',
  'fileCredentialStore',
  'getDaemonStatus',
  'larkConfig',
  'loadConfig',
  'loadModels',
  'memoryCredentialStore',
  'silentLogger',
  'startDaemon',
  'startDaemonServer',
  'stopDaemon',
].sort()

const RETIRED_ROOT_EXPORTS = [
  'VelaSession',
  'agentErrorHint',
  'background',
  'bashExecutionToText',
  'configString',
  'configStrings',
  'createJsonSchema',
  'createVela',
  'customMessageIfChanged',
  'customMessageMissing',
  'defineJsonSchemaTool',
  'importExtension',
  'inspectSession',
  'inspectVela',
  'lastCustomMessage',
  'loadContextFiles',
  'mcp',
  'mcpConfig',
  'memory',
  'messageText',
  'resolveBinary',
  'saveLarkSection',
  'saveModelSetup',
  'setDefaultToolModifiers',
  'SESSION_FORMAT_VERSION',
  'SpilledToolOutput',
  'todo',
  'ToolExecutionResult',
  'usableModel',
  'verifyProviderModel',
  'web',
  'webConfig',
  'withFileMutationQueue',
  'writeProviderPreset',
]

test('@glows777/vela root converges to the 18 runtime value exports', async () => {
  const rootMod = (await import('@glows777/vela')) as Record<string, unknown>
  const valueKeys = Object.entries(rootMod)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort()
  expect(valueKeys).toEqual(EXPECTED_ROOT_RUNTIME_EXPORTS)
  for (const retired of RETIRED_ROOT_EXPORTS) {
    expect(retired in rootMod).toBe(false)
  }
})

test('@glows777/vela/extension-api provides extension helpers retired from root', async () => {
  const extApi = (await import('@glows777/vela/extension-api')) as Record<
    string,
    unknown
  >
  for (const symbol of [
    'SpilledToolOutput',
    'ToolExecutionResult',
    'configString',
    'configStrings',
    'createJsonSchema',
    'customMessageIfChanged',
    'customMessageMissing',
    'defineJsonSchemaTool',
    'lastCustomMessage',
    'messageText',
    'silentLogger',
  ]) {
    expect(extApi[symbol]).toBeDefined()
  }
})

test('createRuntime() preserves inline and explicit path extensions across reloadConfig()', async () => {
  const agentDir = makeTempDir('vela-s4c2-rt-ext')
  const projectDir = makeTempDir('vela-s4c2-rt-proj')
  const fileExt = join(agentDir, 'file-marker.ts')
  writeFileSync(
    fileExt,
    `export default function fileMarker(api: { on: Function }) {
      api.on('before_agent_start', () => ({ systemPrompt: 'FILE_EXT_ACTIVE' }))
    }`,
  )
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({}))

  const intercepted: string[] = []
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'echo hi' }),
      fauxText('first ok'),
      fauxToolCall('bash', { command: 'echo again' }),
      fauxText('second ok'),
    ],
  })
  const runtime = createRuntime({
    agentDir,
    defaultModel: model,
    mcp: false,
    trustOverride: () => true,
    extensions: [
      fileExt,
      function inlineSpy(api) {
        api.on('tool_call', (ev) => {
          intercepted.push(ev.toolName)
        })
      },
    ],
  })
  try {
    await runtime.ready()
    const project = await runtime.projects.create({
      name: 'ExtPersist',
      cwd: projectDir,
      hubSessionId: true,
    })
    const sid = project.hubSessionId!
    await runtime.prompt(sid, { text: 'first turn' })
    await runtime.waitForIdle(sid)

    await runtime.reloadConfig()
    await runtime.prompt(sid, { text: 'second turn' })
    await runtime.waitForIdle(sid)

    expect(intercepted).toEqual(['bash', 'bash'])
    expect(model.calls[0]?.system).toContain('FILE_EXT_ACTIVE')
    expect(model.calls[2]?.system).toContain('FILE_EXT_ACTIVE')
  } finally {
    await runtime.dispose()
  }
})
