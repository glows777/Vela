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
import { openDatabase } from '../../src/db/index.ts'
import { importExtension } from '../../src/driver/config/extensions.ts'
import {
  type ChannelRuntimeEvent,
  connectRuntime,
  createRuntime,
  type LarkTransport,
  memoryCredentialStore,
  startDaemonServer,
  stopDaemon,
} from '../../src/index.ts'
import { fileCredentialStore } from '../../src/providers/auth/store.ts'
import { ModelRegistry } from '../../src/providers/models/index.ts'
import { loadModels } from '../../src/providers/models-config.ts'
import { setChannelEnabledInDb } from '../../src/runtime/index.ts'
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

function makeMockLarkTransport(
  overrides: Partial<LarkTransport> = {},
): LarkTransport {
  return {
    async start() {},
    async getBotId() {
      return 'bot_1'
    },
    stop() {},
    async startTopic() {
      return {
        messageId: 'om_topic',
        createTime: '1',
        rootId: 'om_root',
        threadId: 'omt_1',
      }
    },
    async forward() {
      return { messageId: 'om_fwd', createTime: '1' }
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
    ...overrides,
  }
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

test('ephemeral runtime settings isolate from explicit ownerDir, honor injected credentials and allowLocalOnlyOAuth: false', async () => {
  const ownerDir = tempDir('vela-s4c1-ephemeral-owner-')
  writeFileSync(
    join(ownerDir, 'config.json'),
    JSON.stringify({
      model: 'openai/gpt-5.4',
      lark: { appId: 'owner-app', appSecret: 'owner-secret', chats: ['oc_1'] },
    }),
  )
  await fileCredentialStore(join(ownerDir, 'auth.json')).modify(
    'openai',
    async () => ({
      type: 'oauth',
      access: 'tok',
      refresh: 'ref',
      expires: Date.now() + 60_000,
      localOnly: true,
    }),
  )

  const ephRuntime = createRuntime({
    ephemeral: true,
    agentDir: ownerDir,
    hostEnv: {},
  })
  cleanups.push(() => ephRuntime.dispose())
  const ephState = await ephRuntime.settings.get()
  expect(ephState.model).toBeUndefined()
  expect(ephState.lark.appId).toBe('')
  expect(
    ephState.providers.find((p) => p.name === 'openai')?.credential,
  ).toBeUndefined()
  await expect(
    ephRuntime.settings.saveModel({
      provider: 'openai',
      model: 'gpt-5.4',
      key: 'new-key',
    }),
  ).rejects.toThrow(/ephemeral/i)
  await expect(
    ephRuntime.settings.saveLark({ enabled: false }),
  ).rejects.toThrow(/ephemeral/i)

  const injected = memoryCredentialStore({
    openai: {
      type: 'oauth',
      access: 'local-only-acc',
      refresh: 'local-only-ref',
      expires: Date.now() + 60_000,
      localOnly: true,
    },
  })
  const isolatedOwner = tempDir('vela-s4c1-localonly-owner-')
  writeFileSync(
    join(isolatedOwner, 'config.json'),
    JSON.stringify({ model: 'openai/gpt-5.4' }),
  )
  const serverRuntime = createRuntime({
    agentDir: isolatedOwner,
    hostEnv: {},
    credentials: injected,
    allowLocalOnlyOAuth: false,
  })
  cleanups.push(() => serverRuntime.dispose())
  const blockedState = await serverRuntime.settings.get()
  expect(blockedState.setup.required).toBe(true)
  expect(blockedState.setup.reason).toBe('missing-credential')
  await expect(
    serverRuntime.settings.saveModel({ provider: 'openai', model: 'gpt-5.4' }),
  ).rejects.toThrow(/local/i)
})

test('Lark discovery enforces single owner, client-scoped cancel awaiting restore, pre-aborted signals, and credential-bound approval', async () => {
  const dir = tempDir('vela-s4c1-disc-guard-')
  const socketPath = join(dir, 'daemon.sock')
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      lark: { appId: 'cli_a', appSecret: 'sec_a', chats: [] },
    }),
  )
  let discoveryStopped = false
  let mainStoppedCount = 0
  let mainStartedCount = 0
  let discoveryCall = 0

  const server = await startDaemonServer({
    agentDir: dir,
    socketPath,
    hostEnv: {},
    enableWebhooks: false,
    defaultModel: createFauxModel(),
    larkTransport: makeMockLarkTransport({
      async start() {
        mainStartedCount += 1
      },
      async getBotId() {
        return 'bot_main'
      },
      stop() {
        mainStoppedCount += 1
      },
    }),
    onVerifyLarkCredentials: async () => {},
    onCreateLarkDiscoveryTransport: async () => {
      discoveryCall += 1
      if (discoveryCall === 1) {
        return makeMockLarkTransport({
          async getBotId() {
            return 'bot_disc'
          },
          stop() {
            discoveryStopped = true
          },
        })
      }
      return makeMockLarkTransport({
        async start(handler) {
          queueMicrotask(() =>
            handler({
              message: {
                message_id: 'om_disc_1',
                chat_id: 'oc_found',
                chat_type: 'group',
                message_type: 'text',
                content: JSON.stringify({ text: 'hello' }),
                mentions: [{ key: '@_user_1', id: { open_id: 'bot_disc' } }],
              },
              sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
            }),
          )
        },
        async getBotId() {
          return 'bot_disc'
        },
      })
    },
  })
  const clientA = await connectRuntime({
    agentDir: dir,
    socketPath,
    autoStart: false,
  })
  const clientB = await connectRuntime({
    agentDir: dir,
    socketPath,
    autoStart: false,
  })
  cleanups.push(async () => {
    await clientA.dispose()
    await clientB.dispose()
    await server.close('test-cleanup')
  })
  await Promise.all([clientA.ready(), clientB.ready()])

  const preAborted = AbortSignal.abort(
    new DOMException('Cancelled', 'AbortError'),
  )
  const preAbortedRes = await clientA.settings.discoverLarkGroup({
    signal: preAborted,
  })
  expect(preAbortedRes).toBeUndefined()
  expect(discoveryCall).toBe(0)

  const beforeStartCount = mainStartedCount
  const pendingDisc = clientA.settings.discoverLarkGroup()
  const stopDeadline = Date.now() + 5000
  while (Date.now() < stopDeadline && mainStoppedCount === 0) {
    await Bun.sleep(20)
  }
  expect(mainStoppedCount).toBeGreaterThan(0)

  await expect(clientB.settings.discoverLarkGroup()).rejects.toThrow(
    /already in progress/i,
  )
  await clientB.settings.cancelLarkSetup()
  expect(discoveryStopped).toBe(false)

  await clientA.settings.cancelLarkSetup()
  expect(await pendingDisc).toBeUndefined()
  expect(discoveryStopped).toBe(true)
  expect(mainStartedCount).toBeGreaterThan(beforeStartCount)

  const found = await clientA.settings.discoverLarkGroup()
  expect(found?.chatId).toBe('oc_found')

  await expect(clientB.settings.confirmLarkGroup('oc_found')).rejects.toThrow(
    /No pending group approval/i,
  )
  await clientA.settings.saveLark({ appId: 'cli_b', appSecret: 'sec_b' })
  await expect(clientA.settings.confirmLarkGroup('oc_found')).rejects.toThrow(
    /No pending group approval|changed/i,
  )
})

test('removeChat rejects while pending outbox exists and disabled Lark rejects unified messages()', async () => {
  const dir = tempDir('vela-s4c1-removechat-')
  const socketPath = join(dir, 'daemon.sock')
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      lark: { appId: 'cli_a', appSecret: 'sec_a', chats: ['oc_busy'] },
    }),
  )
  let blockSend!: () => void
  const sendBlocked = new Promise<void>((resolve) => {
    blockSend = resolve
  })
  let resolveSendGate!: () => void
  const sendGate = new Promise<void>((resolve) => {
    resolveSendGate = resolve
  })
  cleanups.push(() => resolveSendGate())

  const model = createFauxModel()
  model.push({ text: 'Done!' })
  let topicReads = 0
  const server = await startDaemonServer({
    agentDir: dir,
    socketPath,
    hostEnv: {},
    enableWebhooks: false,
    defaultModel: model,
    larkTransport: makeMockLarkTransport({
      async reply() {
        blockSend()
        await sendGate
        return { messageId: 'm2', createTime: '1' }
      },
      async listTopicMessages() {
        topicReads += 1
        return {
          items: [
            {
              message_id: 'om_1',
              msg_type: 'text',
              sender: { sender_type: 'user' },
              create_time: '1700000000000',
              body: { content: JSON.stringify({ text: 'Remote message' }) },
            },
          ],
        }
      },
    }),
  })
  const client = await connectRuntime({
    agentDir: dir,
    socketPath,
    autoStart: false,
  })
  cleanups.push(async () => {
    resolveSendGate()
    await client.dispose()
    await server.close('test-cleanup')
  })
  await client.ready()

  const submitted = await client.channels.submit('lark', {
    chatId: 'oc_busy',
    newTopic: { title: 'Busy topic' },
    text: 'Check busy delivery',
    author: { id: 'ou_tester', name: 'Tester' },
  })
  await sendBlocked
  await expect(
    client.settings.saveLark({ removeChat: 'oc_busy' }),
  ).rejects.toThrow(/waiting to send|running/i)

  resolveSendGate()
  await client.waitForIdle(submitted.sessionId)
  const enabledReadsBefore = topicReads
  await client.sessions.messages({ sessionId: submitted.sessionId! })
  expect(topicReads).toBeGreaterThan(enabledReadsBefore)

  await client.settings.saveLark({ enabled: false })
  const readsWhenDisabled = topicReads
  await expect(
    client.sessions.messages({
      sessionId: submitted.sessionId!,
      cursor: 'ch:lark:b:c',
    }),
  ).rejects.toThrow(/channel source changed/)
  await client.sessions.messages({ sessionId: submitted.sessionId! })
  expect(topicReads).toBe(readsWhenDisabled)
})

test('ensureDaemonRunning rejects invalid daemonCommand and cold start respects legacy runInApp: false', async () => {
  const badDir = tempDir('vela-s4c1-badcmd-')
  await expect(
    ensureDaemonRunning({
      agentDir: badDir,
      socketPath: join(badDir, 'bad.sock'),
      daemonCommand: {
        command: '/nonexistent/vela-missing-bin',
        args: [],
      },
      timeoutMs: 3000,
    }),
  ).rejects.toThrow(/Failed to spawn Vela daemon/)

  const dirOff = tempDir('vela-s4c1-runinapp-off-')
  writeFileSync(
    join(dirOff, 'config.json'),
    JSON.stringify({
      lark: {
        appId: 'cli_a',
        appSecret: 'sec_a',
        chats: ['oc_legacy'],
        runInApp: false,
      },
    }),
  )
  const rtOff = createRuntime({ agentDir: dirOff, hostEnv: {} })
  cleanups.push(() => rtOff.dispose())
  const stOff = await rtOff.settings.get()
  expect(stOff.lark.enabled).toBe(false)

  const dirDbOverride = tempDir('vela-s4c1-runinapp-db-')
  writeFileSync(
    join(dirDbOverride, 'config.json'),
    JSON.stringify({
      lark: {
        appId: 'cli_a',
        appSecret: 'sec_a',
        chats: ['oc_legacy'],
        runInApp: false,
      },
    }),
  )
  const seedDb = openDatabase({ path: join(dirDbOverride, 'vela.db') })
  setChannelEnabledInDb(seedDb, 'lark', true)
  seedDb.close()
  const rtOverride = createRuntime({ agentDir: dirDbOverride, hostEnv: {} })
  cleanups.push(() => rtOverride.dispose())
  const stOverride = await rtOverride.settings.get()
  expect(stOverride.lark.enabled).toBe(true)
})

test('importExtension ignores type-only @glows777/vela imports and preserves nested helper import.meta.url', async () => {
  const extDir = tempDir('vela-s4c1-ext-meta-')
  const subDir = join(extDir, 'nested')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, 'data.json'),
    JSON.stringify({ ok: 'from-nested' }),
  )
  writeFileSync(
    join(subDir, 'helper.ts'),
    `import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export function readNested() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('./data.json', import.meta.url)), 'utf8')).ok
}
`,
  )
  const extPath = join(extDir, 'type-only-ext.ts')
  writeFileSync(
    extPath,
    `import type { ExtensionAPI } from '@glows777/vela'
import { readNested } from './nested/helper.ts'
export default function (vela: ExtensionAPI) {
  (vela as unknown as { tag?: string }).tag = readNested()
}
`,
  )
  const fn = await importExtension(extPath, 'typeOnlyExt')
  const fakeVela = {} as { tag?: string }
  fn(fakeVela as unknown as Parameters<typeof fn>[0])
  expect(fakeVela.tag).toBe('from-nested')
})
