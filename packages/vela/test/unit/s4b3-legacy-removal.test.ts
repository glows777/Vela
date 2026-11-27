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
import { loadConfig } from '@glows777/vela'

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
import { createRuntime, createLarkChannelAdapter, DaemonLarkHost } from ${JSON.stringify(join(repoRoot, 'packages/vela/src/legacy-desktop.ts'))}
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
