import { afterEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCliProject } from '../../src/cli/runtime-client.ts'
import { ensureDaemonRunning } from '../../src/daemon/launcher.ts'
import { larkStartupDiagnostic } from '../../src/daemon/settings-service.ts'
import {
  type ChannelRuntimeEvent,
  connectRuntime,
  startDaemonServer,
  stopDaemon,
} from '../../src/index.ts'
import { fileCredentialStore } from '../../src/providers/auth/store.ts'
import { ModelRegistry } from '../../src/providers/models/index.ts'
import { loadModels } from '../../src/providers/models-config.ts'
import { usableModel } from '../../src/settings.ts'
import { createFauxModel } from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('daemon settings toggle Lark via vela.db without writing runInApp to config.json', async () => {
  const dir = tempDir('vela-s4c1-settings-')
  const socketPath = join(dir, 'daemon.sock')
  let startedCount = 0
  let stoppedCount = 0
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      lark: {
        appId: 'cli_test',
        appSecret: 'sec_test',
        chats: ['oc_test'],
      },
    }),
  )

  const server = await startDaemonServer({
    agentDir: dir,
    socketPath,
    hostEnv: {},
    enableWebhooks: false,
    defaultModel: createFauxModel(),
    larkTransport: {
      async start() {
        startedCount += 1
      },
      async getBotId() {
        return 'bot_1'
      },
      stop() {
        stoppedCount += 1
      },
      async startTopic() {
        throw new Error('unused')
      },
      async forward() {
        throw new Error('unused')
      },
      async send() {
        return { messageId: 'om_1', createTime: '1' }
      },
      async reply() {
        return { messageId: 'om_2', createTime: '1' }
      },
      async sendCard() {
        return 'om_3'
      },
      async patchCard() {},
      async addReaction() {
        return 'rx_1'
      },
      async removeReaction() {},
      async getResource() {
        throw new Error('unused')
      },
      async getSenderName() {
        return undefined
      },
      async listTopicMessages() {
        return { items: [] }
      },
      async searchMessages() {
        return { items: [] }
      },
      async listMessages() {
        return []
      },
    },
  })
  const client = await connectRuntime({
    agentDir: dir,
    socketPath,
    autoStart: false,
  })
  cleanups.push(async () => {
    await client.dispose()
    await server.close('test-cleanup')
  })

  await client.ready()
  const initial = await client.settings.get()
  expect(initial.lark.enabled).toBe(true)
  expect(startedCount).toBeGreaterThanOrEqual(1)

  const events: ChannelRuntimeEvent[] = []
  const off = client.channels.subscribe((evt) => events.push(evt))

  const afterDisable = await client.settings.saveLark({ enabled: false })
  expect(afterDisable.lark.enabled).toBe(false)
  expect(stoppedCount).toBeGreaterThanOrEqual(1)

  const diskConfig = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  expect(diskConfig.lark.runInApp).toBeUndefined()

  const proj = await client.projects.create({
    name: 'LocalStayLive',
    hubSessionId: false,
  })
  const sess = await client.sessions.create({
    projectId: proj.id,
    kind: 'work',
  })
  const prompted = await client.prompt(sess.id, {
    text: 'Still works while Lark is off',
  })
  expect(prompted.inserted).toBe(true)

  const afterEnable = await client.settings.saveLark({ enabled: true })
  expect(afterEnable.lark.enabled).toBe(true)
  expect(events.some((e) => e.type === 'channel_status')).toBe(true)
  off()
})

test('localOnly OAuth credential is allowed locally and blocked on Lark channel sessions', async () => {
  const dir = tempDir('vela-s4c1-oauth-')
  const authPath = join(dir, 'auth.json')
  writeFileSync(
    authPath,
    JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'tok_acc',
        refresh: 'tok_ref',
        expires: Date.now() + 3_600_000,
      },
    }),
  )
  const providers = loadModels({ agentDir: dir, env: {}, providers: {} })
  const credentials = fileCredentialStore(authPath)
  const result = usableModel({
    providers,
    credentials,
    model: 'openai/gpt-5.4',
  })
  expect(result.usable).toBe(true)

  const registry = new ModelRegistry(providers, credentials)
  const localResolved = registry.resolve('openai/gpt-5.4', {
    channel: () => undefined,
  })
  expect(localResolved.info.provider).toBe('openai')

  const larkResolved = registry.resolve('openai/gpt-5.4', {
    channel: () => 'lark',
  })
  const larkModel = larkResolved.model as {
    doGenerate?: (opts: unknown) => Promise<unknown>
  }
  await expect(
    larkModel.doGenerate!({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  ).rejects.toThrow(/only for the local terminal, not for lark/)
})

test('ensureDaemonRunning spawns daemonCommand override with custom env', async () => {
  const dir = tempDir('vela-s4c1-cmd-')
  const socketPath = join(dir, 'custom.sock')
  const markerPath = join(dir, 'env-marker.txt')
  const scriptPath = join(dir, 'custom-daemon.ts')
  writeFileSync(
    scriptPath,
    `import { writeFileSync } from 'node:fs'
import { startDaemonServer } from ${JSON.stringify(join(import.meta.dir, '../../src/index.ts'))}
const marker = process.env.VELA_CUSTOM_DAEMON_MARKER ?? ''
writeFileSync(${JSON.stringify(markerPath)}, marker)
await new Promise((resolve) => {
  void startDaemonServer({
    agentDir: ${JSON.stringify(dir)},
    socketPath: ${JSON.stringify(socketPath)},
    hostEnv: {},
    enableWebhooks: false,
    enableLark: false,
    registerSignalHandlers: true,
    onClosed: () => resolve(undefined),
  })
})
`,
  )
  cleanups.push(async () => {
    await stopDaemon({ agentDir: dir, socketPath }).catch(() => {})
  })
  const hello = await ensureDaemonRunning({
    agentDir: dir,
    socketPath,
    daemonCommand: {
      command: process.execPath,
      args: [scriptPath],
      env: { VELA_CUSTOM_DAEMON_MARKER: 'from-daemon-command' },
    },
    timeoutMs: 10_000,
  })
  expect(hello.agentDir).toBe(realpathSync(dir))
  expect(readFileSync(markerPath, 'utf8')).toBe('from-daemon-command')
})

test('ensureCliProject reuses project using canonical path', async () => {
  const dir = tempDir('vela-s4c1-cli-')
  const projDir = tempDir('vela-s4c1-projdir-')
  const socketPath = join(dir, 'daemon.sock')
  const server = await startDaemonServer({
    agentDir: dir,
    socketPath,
    hostEnv: {},
    enableWebhooks: false,
    enableLark: false,
    defaultModel: createFauxModel(),
  })
  const client = await connectRuntime({
    agentDir: dir,
    socketPath,
    autoStart: false,
  })
  cleanups.push(async () => {
    await client.dispose()
    await server.close('test-cleanup')
  })
  await client.ready()

  const first = await ensureCliProject(client, projDir)
  const second = await ensureCliProject(client, `${projDir}/./`)
  expect(first).toBe(second)
})

test('larkStartupDiagnostic maps config errors to fixed diagnostic copy', () => {
  expect(larkStartupDiagnostic(new Error('Duplicate Lark chat id'))).toContain(
    'duplicate chat IDs',
  )
  expect(larkStartupDiagnostic(new Error('secret=abc'))).not.toContain('secret')
})
