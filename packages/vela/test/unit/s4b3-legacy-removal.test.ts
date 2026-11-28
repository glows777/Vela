import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRuntime, loadConfig } from '@glows777/vela'
import { createFauxModel, loadFauxScenario } from '@glows777/vela/testing'

const dirs: string[] = []
const procs: ReturnType<typeof Bun.spawn>[] = []

afterEach(async () => {
  for (const proc of procs.splice(0)) {
    proc.kill('SIGKILL')
    await proc.exited.catch(() => {})
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

test('config.json top-level "local" throws explicit v0.9 removal error pointing to docs/upgrading.md', () => {
  const agentDir = tempDir('vela-local-cfg-')
  const cwd = tempDir('vela-local-cwd-')
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ local: { projects: [cwd] } }),
  )
  expect(() =>
    loadConfig({
      cwd,
      agentDir,
      trusted: false,
      env: {},
    }),
  ).toThrow(
    /top-level "local" channel was removed in v0\.9.*docs\/upgrading\.md/,
  )
})

test('@glows777/vela/extension-api drops removed legacy error-hint and channel-event exports', async () => {
  const extApi = (await import('@glows777/vela/extension-api')) as Record<
    string,
    unknown
  >
  expect('agentErrorHint' in extApi).toBe(false)
  expect('failureHint' in extApi).toBe(false)
  expect('publishChannelEvent' in extApi).toBe(false)
  expect('SessionScope' in extApi).toBe(false)
  expect('SessionHost' in extApi).toBe(false)
})

test('Runtime Outbox + LarkChannelAdapter recovers pending delivery across SIGKILL two-process restart', async () => {
  const agentDir = tempDir('vela-sigkill-agent-')
  const chatDir = join(agentDir, 'channels', 'lark', 'oc_crash', 'workspace')
  const repoRoot = resolve(import.meta.dir, '../../../..')
  const fauxPath = join(agentDir, 'faux.json')
  const statePath = join(agentDir, 'deliveries.json')
  writeFileSync(
    fauxPath,
    JSON.stringify({
      responses: [{ text: 'Crash recovered reply' }],
    }),
  )

  const workerScript = join(agentDir, 'worker.ts')
  writeFileSync(
    workerScript,
    `
import { readFileSync, writeFileSync } from 'node:fs'
import { createRuntime, createLarkChannelAdapter } from ${JSON.stringify(join(repoRoot, 'packages/vela/src/index.ts'))}
import { DaemonLarkHost } from ${JSON.stringify(join(repoRoot, 'packages/vela/src/daemon/lark-host.ts'))}
import { loadFauxScenario } from ${JSON.stringify(join(repoRoot, 'packages/vela/src/testing/core/index.ts'))}

const mode = process.argv[2]
const agentDir = process.argv[3]
const fauxPath = process.argv[4]
const statePath = process.argv[5]
const hangDeliver = mode === 'crash'

const model = await loadFauxScenario(fauxPath)
const runtime = createRuntime({
  agentDir,
  defaultModel: model,
  mcp: false,
})
await runtime.ready()
const recovery = await runtime.recover()

let onMessage
const delivered = []
const transport = {
  async start(handler) {
    onMessage = handler
  },
  stop() {},
  async getBotId() { return 'bot_open' },
  async send() { return { messageId: 'm_send', createTime: String(Date.now()) } },
  async reply(_msgId, text) {
    if (hangDeliver) {
      console.log('DELIVERING')
      await new Promise(() => {})
    }
    delivered.push(text)
    writeFileSync(statePath, JSON.stringify({ delivered, recovery }))
    return { messageId: 'm_reply', createTime: String(Date.now()) }
  },
  async startTopic() { return { messageId: 'm_topic', rootId: 'm_root', threadId: 't_1' } },
  async uploadFile() { return '' },
  async uploadImage() { return '' },
  async sendFile() { return { messageId: 'm_file', createTime: String(Date.now()) } },
  async sendImage() { return { messageId: 'm_img', createTime: String(Date.now()) } },
  async getUserName() { return 'Alice' },
  async getChatName() { return 'Crash Chat' },
  async listHistory() { return { items: [], hasMore: false } },
  async react() { return 'r_1' },
  async unreact() {},
  async cardReply() { return 'c_1' },
  async cardUpdate() {},
  async cardSend() { return 'c_2' },
}

const larkHost = new DaemonLarkHost(runtime, {
  agentDir,
  hostEnv: {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  transport,
})
await larkHost.sync({
  lark: {
    appId: 'app_1',
    appSecret: 'sec_1',
    chats: ['oc_crash'],
  },
}, true)

if (mode === 'crash') {
  onMessage({
    sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    message: {
      chat_id: 'oc_crash',
      chat_type: 'group',
      message_id: 'om_in_1',
      create_time: String(Date.now()),
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 hello before crash' }),
      mentions: [{ id: { open_id: 'bot_open' }, key: '@_user_1', name: 'Vela' }],
    },
  })
  await new Promise(() => {})
} else {
  console.log('RECOVERED_READY')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf8'))
      if (data.delivered?.length) break
    } catch {}
    await new Promise((r) => setTimeout(r, 25))
  }
  await larkHost.stop()
  await runtime.dispose()
  process.exit(0)
}
`,
  )

  const procA = Bun.spawn(
    [
      process.execPath,
      'run',
      workerScript,
      'crash',
      agentDir,
      fauxPath,
      statePath,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  procs.push(procA)
  const readerA = procA.stdout.getReader()
  let outA = ''
  const decoder = new TextDecoder()
  while (!outA.includes('DELIVERING')) {
    const chunk = await readerA.read()
    if (chunk.done) break
    outA += decoder.decode(chunk.value)
  }
  expect(outA).toContain('DELIVERING')
  expect(existsSync(chatDir)).toBe(true)

  procA.kill('SIGKILL')
  await procA.exited

  const procB = Bun.spawn(
    [
      process.execPath,
      'run',
      workerScript,
      'recover',
      agentDir,
      fauxPath,
      statePath,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  procs.push(procB)
  const exitB = await procB.exited
  expect(exitB).toBe(0)

  await until(() => existsSync(statePath), 'recovered delivery')
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    delivered: string[]
  }
  expect(state.delivered).toEqual(['Crash recovered reply'])
}, 20_000)

test('runtime.stop honors expectedRunId and does not cancel a subsequent run', async () => {
  const agentDir = tempDir('vela-stop-runid-')
  const fauxPath = join(agentDir, 'faux.json')
  writeFileSync(
    fauxPath,
    JSON.stringify({
      responses: [
        { text: 'first done' },
        {
          toolCalls: [{ name: 'bash', input: { command: 'sleep 2' } }],
        },
        { text: 'second done' },
      ],
    }),
  )
  const model = await loadFauxScenario(fauxPath)
  const runtime = createRuntime({
    agentDir,
    defaultModel: model,
    mcp: false,
    trustOverride: () => true,
  })
  try {
    await runtime.ready()
    await runtime.recover()
    const project = await runtime.projects.create({
      name: 'StopTest',
      cwd: agentDir,
      hubSessionId: true,
    })
    const sessionId = project.hubSessionId!
    const runIds: string[] = []
    const off = runtime.events.subscribe((evt) => {
      if (evt.sessionId === sessionId && evt.type === 'run_started') {
        runIds.push(evt.runId)
      }
    })
    try {
      await runtime.prompt(sessionId, { text: 'run one', source: 'user' })
      await runtime.waitForIdle(sessionId)
      expect(runIds.length).toBe(1)
      const firstRunId = runIds[0]!

      await runtime.prompt(sessionId, { text: 'run two', source: 'user' })
      await until(() => runIds.length === 2, 'second run started')
      const secondRunId = runIds[1]!

      expect(
        await runtime.stop(sessionId, 'stale stop', {
          expectedRunId: firstRunId,
        }),
      ).toBe(false)
      const stAfterStale = await runtime.sessions.status(sessionId)
      expect(stAfterStale.activeRunId).toBe(secondRunId)

      expect(
        await runtime.stop(sessionId, 'exact stop', {
          expectedRunId: secondRunId,
        }),
      ).toBe(true)
      await runtime.waitForIdle(sessionId)
    } finally {
      off()
    }
  } finally {
    await runtime.dispose()
  }
})

test('timers.delete respects optional projectId and kind scope', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  try {
    await runtime.ready()
    const projA = await runtime.projects.create({
      name: 'A',
      hubSessionId: true,
    })
    const projB = await runtime.projects.create({
      name: 'B',
      hubSessionId: true,
    })
    const timerB = await runtime.timers.createRoutine({
      projectId: projB.id,
      sessionId: projB.hubSessionId,
      message: 'B routine',
      schedule: { time: '12:00' },
    })
    expect(
      await runtime.timers.delete(timerB.id, {
        projectId: projA.id,
        kind: 'routine',
      }),
    ).toBe(false)
    expect((await runtime.timers.list({ projectId: projB.id })).length).toBe(1)

    expect(
      await runtime.timers.delete(timerB.id, {
        projectId: projB.id,
        kind: 'routine',
      }),
    ).toBe(true)
    expect((await runtime.timers.list({ projectId: projB.id })).length).toBe(0)
  } finally {
    await runtime.dispose()
  }
})

test('autoCompaction config reloads via reloadConfig and registerChannel + channels.submit sequence works', async () => {
  const agentDir = tempDir('vela-autocompact-')
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      autoCompaction: false,
      limits: { summaryThreshold: 1 },
    }),
  )
  const runtime = createRuntime({
    agentDir,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  try {
    await runtime.ready()
    let registeredIngest:
      | ((msg: {
          channel: string
          dedupeKey: string
          externalChatId: string
          kind: 'group'
          senderId: string
          senderName: string
          text: string
          timestamp: string
        }) => Promise<void>)
      | undefined
    await runtime.registerChannel({
      name: 'echo',
      async start(ctx) {
        registeredIngest = (m) => ctx.ingest(m)
      },
      async stop() {},
      async deliver() {
        return { externalMessageId: 'ext-1' }
      },
      async submitFromHost(input) {
        await registeredIngest?.({
          channel: 'echo',
          dedupeKey: `host:${input.chatId}:${Date.now()}`,
          externalChatId: input.chatId,
          kind: 'group',
          senderId: input.author.id,
          senderName: input.author.name,
          text: input.text,
          timestamp: new Date().toISOString(),
        })
        return { outcome: 'posted', messageId: 'ext-host-1' }
      },
    })
    await runtime.recover()

    const submitRes = await runtime.channels.submit('echo', {
      chatId: 'room-1',
      text: 'Hello channel',
      author: { id: 'u1', name: 'Alice' },
    })
    expect(submitRes.outcome).toBe('posted')

    const compactions: string[] = []
    runtime.events.subscribe((evt) => {
      if (evt.type === 'compaction_started') compactions.push(evt.reason)
    })
    const proj = await runtime.projects.create({
      name: 'AC',
      hubSessionId: true,
    })
    await runtime.prompt(proj.hubSessionId!, { text: 'hi', source: 'user' })
    await runtime.waitForIdle(proj.hubSessionId!)
    expect(compactions).toEqual([])

    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({
        autoCompaction: true,
        limits: { summaryThreshold: 1 },
      }),
    )
    await runtime.reloadConfig()
    expect(await runtime.sessions.get(proj.hubSessionId!)).toBeDefined()
  } finally {
    await runtime.dispose()
  }
})

test('ignoredChannels skips channel recovery/timers and allowLocalOnlyOAuth:false blocks extension localOnly OAuth', async () => {
  const agentDir = tempDir('vela-ignored-chan-')
  const runtimeA = createRuntime({
    agentDir,
    defaultModel: createFauxModel(),
    mcp: false,
  })
  const proj = await runtimeA.projects.create({
    name: 'LarkIgnored',
    hubSessionId: true,
  })
  await runtimeA.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_pend',
    kind: 'group',
    projectId: proj.id,
    sessionId: proj.hubSessionId,
    enabled: true,
  })
  await runtimeA.prompt(proj.hubSessionId!, {
    text: 'should stay pending for daemon',
    source: 'user',
    wake: true,
  })
  await runtimeA.dispose()

  const extPath = join(agentDir, 'ext.ts')
  writeFileSync(
    extPath,
    `
    export default function (api) {
      api.registerProvider('local-oauth-ext', {
        oauth: { localOnly: true },
        models: [{ id: 'm1', name: 'M1' }],
        createModel(id, ctx) {
          return {
            async doGenerate() {
              const cred = await ctx.credential()
              return { content: [{ type: 'text', text: cred ? 'leaked' : 'blocked' }], usage: {} }
            }
          }
        }
      })
    }
  `,
  )
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'local-oauth-ext': { type: 'oauth', access: 'secret-token' },
    }),
  )
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      model: 'local-oauth-ext/m1',
      extensions: [extPath],
    }),
  )
  const runtimeB = createRuntime({
    agentDir,
    ignoredChannels: ['lark'],
    allowLocalOnlyOAuth: false,
    mcp: false,
  })
  try {
    await runtimeB.ready()
    const rec = await runtimeB.recover()
    expect(rec.wokenSessions).not.toContain(proj.hubSessionId!)
    const models = await runtimeB.models({ channel: undefined })
    expect(models.some((m) => m.provider === 'local-oauth-ext')).toBe(false)
  } finally {
    await runtimeB.dispose()
  }
})
