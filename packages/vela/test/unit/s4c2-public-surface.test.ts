import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import {
  createJsonSchema,
  customMessageIfChanged,
  type VelaExtension,
} from '@glows777/vela/extension-api'
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

test('createRuntime() preserves inline extension closure state across reloadConfig()', async () => {
  const agentDir = makeTempDir('vela-s4c2-inline-state')
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({}))
  const log: string[] = []
  const todoExt: VelaExtension = function statefulTodo(api) {
    const todos: string[] = []
    api.registerCommand('todo', {
      handler: (args, ctx) => {
        if (args.startsWith('add ')) {
          todos.push(args.slice(4).trim())
          ctx.notify(`added:${todos.join(',')}`)
          return
        }
        ctx.notify(todos.length ? `list:${todos.join(',')}` : 'empty')
      },
    })
  }
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
    mcp: false,
    extensions: [todoExt],
  })
  const off = runtime.events.subscribe((ev) => {
    if (ev.type === 'notify') log.push(ev.message)
  })
  try {
    await runtime.ready()
    const s = await runtime.sessions.create({ name: 'todo' })
    await runtime.sessions.runCommand(s.id, '/todo add milk')
    await runtime.reloadConfig()
    await runtime.sessions.runCommand(s.id, '/todo')
    expect(log).toEqual(['added:milk', 'list:milk'])
  } finally {
    off()
    await runtime.dispose()
  }
})

test('runtime.dispose() awaits superseded host extension shutdown released asynchronously', async () => {
  const agentDir = makeTempDir('vela-s4c2-shutdown-drain')
  const extPath = join(agentDir, 'slow-shutdown.ts')
  writeFileSync(
    extPath,
    `export default function slow(api: { onShutdown: Function }) {
      api.onShutdown(async () => {
        await new Promise((r) => setTimeout(r, 80))
        ;(globalThis as { __s4c2SlowShutdownDone?: boolean }).__s4c2SlowShutdownDone = true
      })
    }`,
  )
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ extensions: [extPath] }),
  )
  ;(globalThis as { __s4c2SlowShutdownDone?: boolean }).__s4c2SlowShutdownDone =
    false

  let markStarted!: () => void
  const started = new Promise<void>((r) => {
    markStarted = r
  })
  let releaseGate!: () => void
  const gate = new Promise<void>((r) => {
    releaseGate = r
  })
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('gate_hold', {}),
        fauxText('first done'),
        fauxText('second done'),
      ],
    }),
    tools: [
      {
        name: 'gate_hold',
        description: 'Hold turn until released',
        inputSchema: createJsonSchema({ type: 'object' }),
        execute: async () => {
          markStarted()
          await gate
          return 'released'
        },
      },
    ],
    mcp: false,
  })
  await runtime.ready()
  const s = await runtime.sessions.create({ name: 'hold' })
  await runtime.prompt(s.id, { text: 'hold snapshot' })
  await started
  // Reload while s holds generation 1 so generation 1 enters retiredSnapshots.
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ extensions: [] }),
  )
  await runtime.reloadConfig()
  // Release active turn (calls acquireHostSnapshot().release()) then dispose immediately.
  releaseGate()
  await runtime.waitForIdle(s.id)
  await runtime.dispose()
  expect(
    (globalThis as { __s4c2SlowShutdownDone?: boolean }).__s4c2SlowShutdownDone,
  ).toBe(true)
})

test('customMessageIfChanged(ctx.session, ...) works in Runtime before_agent_start across consecutive turns', async () => {
  const model = createFauxModel({
    responses: [fauxText('t1'), fauxText('t2'), fauxText('t3')],
  })
  const dynamicNote: VelaExtension = function noteExt(api) {
    let turn = 0
    api.on('before_agent_start', (_ev, ctx) => {
      turn += 1
      const text = turn <= 2 ? 'NOTE_A' : 'NOTE_B'
      const message = customMessageIfChanged(ctx.session, 'note', text)
      return message ? { message } : undefined
    })
  }
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: model,
    mcp: false,
    extensions: [dynamicNote],
  })
  try {
    await runtime.ready()
    const s = await runtime.sessions.create({ name: 'cm' })
    await runtime.prompt(s.id, { text: 'one' })
    await runtime.waitForIdle(s.id)
    await runtime.prompt(s.id, { text: 'two' })
    await runtime.waitForIdle(s.id)
    await runtime.prompt(s.id, { text: 'three' })
    await runtime.waitForIdle(s.id)

    const page = await runtime.sessions.messages({ sessionId: s.id })
    const customTexts = page.messages
      .filter((m) => typeof m.text === 'string' && m.text.startsWith('NOTE_'))
      .map((m) => m.text)
    expect(customTexts).toEqual(['NOTE_A', 'NOTE_B'])
  } finally {
    await runtime.dispose()
  }
})

test('missing explicit or owner extension path does not suppress healthy file extensions and preserves [inline, file] order', async () => {
  const dir = makeTempDir('vela-s4c2-order-missing')
  const ownerGood = join(dir, 'owner-good.ts')
  const explicitGood = join(dir, 'explicit-good.ts')
  const missingPath = join(dir, 'does-not-exist.ts')
  const order: string[] = []
  ;(globalThis as { __s4c2HookOrder?: string[] }).__s4c2HookOrder = order

  writeFileSync(
    ownerGood,
    `export default function ownerGood(api: { on: Function }) {
      api.on('before_agent_start', () => {
        ;(globalThis as { __s4c2HookOrder?: string[] }).__s4c2HookOrder?.push('owner')
      })
    }`,
  )
  writeFileSync(
    explicitGood,
    `export default function explicitGood(api: { on: Function }) {
      api.on('before_agent_start', () => {
        ;(globalThis as { __s4c2HookOrder?: string[] }).__s4c2HookOrder?.push('file')
      })
    }`,
  )
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ extensions: [missingPath, ownerGood] }),
  )

  const runtime = createRuntime({
    agentDir: dir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
    mcp: false,
    extensions: [
      function firstInline(api) {
        api.on('before_agent_start', () => {
          order.push('inline')
        })
      },
      missingPath,
      explicitGood,
    ],
  })
  try {
    await runtime.ready()
    const errs = await runtime.extensionErrors()
    expect(errs.some((e) => e.includes('does-not-exist.ts'))).toBe(true)
    const s = await runtime.sessions.create({ name: 'order' })
    await runtime.prompt(s.id, { text: 'go' })
    await runtime.waitForIdle(s.id)
    expect(order).toEqual(['owner', 'inline', 'file'])
  } finally {
    delete (globalThis as { __s4c2HookOrder?: string[] }).__s4c2HookOrder
    await runtime.dispose()
  }
})
