import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerBuiltinExtensionHostModules } from '../../src/daemon/extension-host.ts'
import { createRuntimeSettingsApi } from '../../src/daemon/settings-discovery.ts'
import { importExtension } from '../../src/driver/config/extensions.ts'
import {
  connectRuntime,
  createRuntime,
  type LarkTransport,
  startDaemonServer,
} from '../../src/index.ts'
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

test('importExtension host bundle preserves regex literals containing import.meta.url or backticks', async () => {
  registerBuiltinExtensionHostModules({ startDaemonServer })
  const extDir = tempDir('vela-s4c1-ext-regex-')
  const subDir = join(extDir, 'nested')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, 'asset.json'),
    JSON.stringify({ ok: 'regex-asset' }),
  )
  writeFileSync(
    join(subDir, 'helper.ts'),
    `import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectRuntime } from '@glows777/vela'
export const metaRegex = /import\\.meta\\.url/
export const tickRegex = /a\`b/
export function checkRegexAndAsset() {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('./asset.json', import.meta.url)), 'utf8')).ok
  return {
    matchesLiteral: metaRegex.test('import.meta.url'),
    matchesTick: tickRegex.test('a\`b'),
    raw,
    hasRuntimeImport: typeof connectRuntime === 'function',
  }
}
`,
  )
  const extPath = join(extDir, 'regex-ext.ts')
  writeFileSync(
    extPath,
    `import type { ExtensionAPI } from '@glows777/vela'
import { checkRegexAndAsset } from './nested/helper.ts'
export default function (vela: ExtensionAPI) {
  (vela as unknown as { probe?: unknown }).probe = checkRegexAndAsset()
}
`,
  )
  const fn = await importExtension(extPath, 'regexExt')
  const fakeVela = {} as { probe?: unknown }
  fn(fakeVela as unknown as Parameters<typeof fn>[0])
  expect(fakeVela.probe).toEqual({
    matchesLiteral: true,
    matchesTick: true,
    raw: 'regex-asset',
    hasRuntimeImport: true,
  })
})

test('AbortSignal discovery cancellation awaits daemon resume before resolving retry', async () => {
  const dirAbort = tempDir('vela-s4c1-abort-wait-')
  writeFileSync(
    join(dirAbort, 'config.json'),
    JSON.stringify({
      lark: { appId: 'cli_abort', appSecret: 'sec_abort', chats: [] },
    }),
  )
  let startCalls = 0
  let resumeFinished = false
  let releaseResume: (() => void) | undefined

  const server = await startDaemonServer({
    agentDir: dirAbort,
    socketPath: join(dirAbort, 'abort.sock'),
    hostEnv: {},
    enableWebhooks: false,
    defaultModel: createFauxModel(),
    larkTransport: makeMockLarkTransport({
      async start() {
        startCalls += 1
        if (startCalls > 1) {
          await new Promise<void>((r) => {
            releaseResume = r
          })
          resumeFinished = true
        }
      },
    }),
    onCreateLarkDiscoveryTransport: async () => makeMockLarkTransport(),
  })
  const rtAbort = await connectRuntime({
    agentDir: dirAbort,
    socketPath: join(dirAbort, 'abort.sock'),
    autoStart: false,
  })
  cleanups.push(async () => {
    releaseResume?.()
    await rtAbort.dispose()
    await server.close('test-cleanup')
  })
  await rtAbort.ready()

  const slowController = new AbortController()
  const abortPromise = rtAbort.settings.discoverLarkGroup({
    signal: slowController.signal,
  })
  await new Promise((r) => setTimeout(r, 40))
  slowController.abort()
  let settledEarly = false
  void abortPromise.then(() => {
    settledEarly = true
  })
  await new Promise((r) => setTimeout(r, 40))
  expect(settledEarly).toBe(false)
  expect(resumeFinished).toBe(false)
  releaseResume?.()
  await expect(abortPromise).resolves.toBeUndefined()
  expect(resumeFinished).toBe(true)
})

test('confirmLarkGroup re-validates approval after idle check and credential replacement checks approvals', async () => {
  const dir2 = tempDir('vela-s4c1-r2-race-')
  writeFileSync(
    join(dir2, 'config.json'),
    JSON.stringify({
      lark: { appId: 'cli_a', appSecret: 'sec_a', chats: ['oc_one'] },
    }),
  )
  let gateNextIdleCheck = false
  let releaseIdleGate!: () => void
  const idleGate = new Promise<void>((resolve) => {
    releaseIdleGate = resolve
  })
  let markInIdleCheck!: () => void
  const inIdleCheck = new Promise<void>((resolve) => {
    markInIdleCheck = resolve
  })
  cleanups.push(() => releaseIdleGate())

  const fakeTransport = makeMockLarkTransport({
    async start(handler) {
      queueMicrotask(() => {
        handler({
          message: {
            message_id: 'om_disc_r2',
            chat_id: 'oc_new_group',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'hello' }),
            mentions: [{ key: '@_user_1', id: { open_id: 'bot_1' } }],
          },
          sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
        })
      })
    },
  })

  let pendingApprovals: Array<{
    id: string
    sessionId: string
    status: 'pending' | 'approved'
  }> = []
  const fakeRt = {
    channels: {
      list: async () => [{ name: 'lark', enabled: true }],
      chats: async () => [{ chatId: 'oc_one', name: 'One' }],
      setEnabled: async () => ({ name: 'lark', enabled: true }),
    },
    bindings: {
      list: async () => [
        {
          id: 'b1',
          channel: 'lark',
          externalId: 'oc_one',
          projectId: 'p1',
          sessionId: 's1',
          enabled: true,
        },
      ],
    },
    sessions: {
      list: async () => [{ id: 's1', projectId: 'p1', state: 'idle' }],
      status: async () => {
        if (gateNextIdleCheck) {
          gateNextIdleCheck = false
          markInIdleCheck()
          await idleGate
        }
        return { activeRunId: null, runningJobs: 0 }
      },
    },
    approvals: {
      list: async () => pendingApprovals,
    },
    reloadConfig: async () => {},
  } as unknown as Parameters<typeof createRuntimeSettingsApi>[0]['runtime']

  const svc = createRuntimeSettingsApi({
    agentDir: dir2,
    hostEnv: {},
    runtime: fakeRt,
    createDiscoveryTransport: async () => fakeTransport,
    verifyCredentials: async () => {},
  })
  const found = await svc.discoverLarkGroup()
  expect(found?.chatId).toBe('oc_new_group')
  gateNextIdleCheck = true
  const confirmPromise = svc.confirmLarkGroup('oc_new_group')
  await inIdleCheck
  const cancelPromise = svc.cancelLarkSetup()
  releaseIdleGate()
  await cancelPromise
  await expect(confirmPromise).rejects.toThrow(/No pending group approval/i)
  const cfgAfterCancel = JSON.parse(
    readFileSync(join(dir2, 'config.json'), 'utf8'),
  )
  expect(cfgAfterCancel.lark.chats).toEqual(['oc_one'])

  pendingApprovals = [{ id: 'app1', sessionId: 's1', status: 'pending' }]
  await expect(svc.saveLark({ removeChat: 'oc_one' })).rejects.toThrow(
    /running or waiting to send/i,
  )
  await expect(
    svc.saveLark({ appId: 'cli_b', appSecret: 'sec_b' }),
  ).rejects.toThrow(/running or queued/i)
})

test('unbound work session keeps DB transcript and enabled custom adapter without listMessages keeps DB transcript', async () => {
  const dir = tempDir('vela-s4c1-r2-routing-')
  const model = createFauxModel()
  model.push({ text: 'hub reply' }, { text: 'work reply' })
  const rt = createRuntime({ agentDir: dir, hostEnv: {}, defaultModel: model })
  cleanups.push(() => rt.dispose())
  await rt.ready()

  await rt.registerChannel({
    name: 'team',
    async start() {},
    async stop() {},
    async deliver() {
      return { externalMessageId: 'team_1' }
    },
  })

  const groupProj = await rt.projects.create({ name: 'Team Group' })
  const hub = await rt.sessions.create({
    projectId: groupProj.id,
    kind: 'hub',
    name: 'Hub',
  })
  await rt.projects.update(groupProj.id, { hubSessionId: hub.id })
  const work = await rt.sessions.create({
    projectId: groupProj.id,
    kind: 'work',
    name: 'Unbound Work',
  })
  await rt.bindings.upsert({
    channel: 'team',
    kind: 'group',
    externalId: 'chat-team-1',
    projectId: groupProj.id,
    sessionId: hub.id,
    enabled: true,
  })

  await rt.prompt(hub.id, { text: 'hub msg' })
  await rt.waitForIdle(hub.id)
  await rt.prompt(work.id, { text: 'work msg' })
  await rt.waitForIdle(work.id)

  const workPage = await rt.sessions.messages({ sessionId: work.id })
  expect(workPage.messages.map((m) => m.text)).toContain('work msg')
  expect(workPage.messages.map((m) => m.text)).not.toContain('hub msg')

  const hubPage = await rt.sessions.messages({ sessionId: hub.id })
  expect(hubPage.messages.map((m) => m.text)).toContain('hub msg')
  expect(hubPage.messages.map((m) => m.text)).not.toContain('work msg')

  await rt.channels.setEnabled('team', false)
  // S4b-1 contract: disabling channel hides channel tools and falls back to SQLite DB transcript
  expect((await rt.sessions.inspect(hub.id)).allTools).not.toContain(
    'team_ping',
  )
  const hubFallback = await rt.sessions.messages({ sessionId: hub.id })
  expect(hubFallback.messages.map((m) => m.text)).toContain('hub msg')
  const workPageAfterDisable = await rt.sessions.messages({
    sessionId: work.id,
  })
  expect(workPageAfterDisable.messages.map((m) => m.text)).toContain('work msg')
})
