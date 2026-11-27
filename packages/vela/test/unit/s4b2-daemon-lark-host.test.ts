import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { runAttempt } from '../../../../scripts/eval/worker.ts'
import { connectRuntime } from '../../src/daemon/client.ts'
import { startDaemonServer } from '../../src/daemon/server.ts'
import type { LarkMessageEvent, LarkTransport } from '../../src/lark/index.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4b2-daemon-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function initGitRepo(cwd: string): void {
  Bun.spawnSync(['git', 'init', '-q'], { cwd })
  Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'init',
    ],
    { cwd },
  )
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await Promise.resolve(cleanups.pop()!()).catch(() => {})
  }
})

function createMinimalTransport() {
  let onMessage: ((event: LarkMessageEvent) => void) | undefined
  let starts = 0
  let stops = 0
  const sent: Array<{ chatId?: string; messageId?: string; text: string }> = []
  const transport: LarkTransport = {
    start: async (msgHandler) => {
      starts++
      onMessage = msgHandler
    },
    stop: () => {
      stops++
    },
    startTopic: async (messageId, title) => ({
      messageId: `topic_${messageId}_${title.length}`,
      rootId: messageId,
      threadId: `thread_${messageId}`,
      createTime: String(Date.now()),
    }),
    forward: async (messageId) => ({
      messageId: `fwd_${messageId}`,
      createTime: String(Date.now()),
    }),
    send: async (chatId, text) => {
      sent.push({ chatId, text })
      return { messageId: `s_${sent.length}`, createTime: String(Date.now()) }
    },
    reply: async (messageId, text) => {
      sent.push({ messageId, text })
      return { messageId: `r_${sent.length}`, createTime: String(Date.now()) }
    },
    sendCard: async () => 'card_1',
    patchCard: async () => {},
    addReaction: async () => 'rx_1',
    removeReaction: async () => {},
    getResource: async () => Readable.from([]),
    getBotId: async () => 'ou_bot',
    getSenderName: async () => 'Alice',
    listTopicMessages: async () => ({ items: [] }),
    searchMessages: async () => ({ items: [] }),
    listMessages: async () => [],
  }
  return {
    transport,
    sent,
    getStarts: () => starts,
    getStops: () => stops,
    deliver: (event: LarkMessageEvent) => onMessage?.(event),
  }
}

test('DaemonLarkHost syncs config/env into projects+bindings, supports hot-reload, invalid config surface, and live channel toggle', async () => {
  const dir = makeTempDir()
  const agentDir = join(dir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [
          {
            id: 'oc_chat_a',
            model: 'eval/main-model',
            thinkingLevel: 'medium',
            topicModel: 'eval/topic-model',
            topicThinkingLevel: 'high',
            tools: ['read', 'grep'],
            readUntagged: false,
          },
        ],
      },
    }),
  )

  const fake = createMinimalTransport()
  const handle = await startDaemonServer({
    agentDir,
    socketPath: join(dir, 'vela.sock'),
    hostEnv: {
      LARK_APP_ID: 'cli_test',
      LARK_APP_SECRET: 'sec_test',
    },
    enableLark: true,
    larkTransport: fake.transport,
    registerSignalHandlers: false,
  })
  cleanups.push(() => handle.close('test'))

  const client = await connectRuntime({
    agentDir,
    socketPath: handle.socketPath,
  })
  cleanups.push(() => client.dispose())

  // 1. Initial project + binding synced with topicModel/defaultTools preserved
  const projects = await handle.runtime.projects.list()
  const chatProject = projects.find((p) => p.name === 'oc_chat_a')
  expect(chatProject).toBeDefined()
  expect(chatProject?.defaultModel).toBe('eval/main-model')
  expect(chatProject?.defaultThinkingLevel).toBe('medium')
  expect(chatProject?.defaultTools).toEqual(['read', 'grep'])
  expect(chatProject?.config).toEqual({
    topicModel: 'eval/topic-model',
    topicThinkingLevel: 'high',
  })

  // Creating a topic session under the synced project inherits topicModel/topicThinkingLevel
  const topicSession = await handle.runtime.sessions.create({
    projectId: chatProject!.id,
    kind: 'topic',
    externalSessionId: 'omt_1',
  })
  expect(topicSession.model).toBe('eval/topic-model')
  expect(topicSession.thinkingLevel).toBe('high')

  const initialBindings = await handle.runtime.bindings.list({
    channel: 'lark',
  })
  expect(initialBindings).toHaveLength(1)
  expect(initialBindings[0]).toMatchObject({
    externalId: 'oc_chat_a',
    enabled: true,
    config: { readUntagged: false },
  })
  expect(fake.getStarts()).toBe(1)

  const channels1 = await client.channels.list()
  expect(channels1.some((c) => c.name === 'lark' && c.connected)).toBe(true)

  // 2. Hot reload adds chat_b, removes chat_a -> disables old binding
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [{ id: 'oc_chat_b', readUntagged: true }],
      },
    }),
  )
  await handle.runtime.reloadConfig()
  const updatedBindings = await handle.runtime.bindings.list({
    channel: 'lark',
  })
  const bA = updatedBindings.find((b) => b.externalId === 'oc_chat_a')
  const bB = updatedBindings.find((b) => b.externalId === 'oc_chat_b')
  expect(bA?.enabled).toBe(false)
  expect(bB?.enabled).toBe(true)
  expect(fake.getStarts()).toBe(2)

  // 3. Invalid Lark config surfaces lastError in channel status without crashing
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [{ id: 'oc_bad', thinkingLevel: 'galaxy-brain' }],
      },
    }),
  )
  await handle.runtime.reloadConfig()
  const errChannels = await client.channels.list()
  const larkErr = errChannels.find((c) => c.name === 'lark')
  expect(larkErr?.error).toContain('Unknown Lark thinking level')
  expect(larkErr?.connected).toBe(false)

  // Restore valid config and verify live channels.setEnabled(false / true)
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [{ id: 'oc_chat_b' }],
      },
    }),
  )
  await handle.runtime.reloadConfig()
  expect(
    (await client.channels.list()).find((c) => c.name === 'lark')?.connected,
  ).toBe(true)

  const afterDisable = await client.channels.setEnabled('lark', false)
  expect(afterDisable.enabled).toBe(false)
  expect(afterDisable.connected).toBe(false)

  const afterEnable = await client.channels.setEnabled('lark', true)
  expect(afterEnable.enabled).toBe(true)
  expect(afterEnable.connected).toBe(true)
})

test('Eval runtime-lark runner executes G1 and G3 scenarios end-to-end with injected faux model', async () => {
  const dir = makeTempDir('vela-s4b2-eval-')
  const repoRoot = resolve(import.meta.dir, '../../../..')

  // G1: @mention lookup against seeded fake history -> answers 14:30
  const cwdG1 = join(dir, 'g1-cwd')
  const artG1 = join(dir, 'g1-art')
  mkdirSync(cwdG1, { recursive: true })
  mkdirSync(artG1, { recursive: true })
  initGitRepo(cwdG1)
  const modelG1 = createFauxModel({
    responses: [
      () =>
        fauxText(
          'Based on recent messages, the release meeting starts at 14:30 UTC.',
        ),
    ],
  })
  const attemptG1 = await runAttempt(
    {
      runtime: repoRoot,
      cwd: cwdG1,
      artifactDir: artG1,
      scenario: 'G1',
      arm: 'new',
      run: 1,
      attempt: 1,
      thinking: 'medium',
    },
    'test-key',
    modelG1,
  )
  expect({
    status: attemptG1.status,
    reason: attemptG1.reason,
    checks: attemptG1.checks,
  }).toMatchObject({ status: 'pass' })

  // G3: untagged passive chat -> no reply delivered
  const cwdG3 = join(dir, 'g3-cwd')
  const artG3 = join(dir, 'g3-art')
  mkdirSync(cwdG3, { recursive: true })
  mkdirSync(artG3, { recursive: true })
  initGitRepo(cwdG3)
  const modelG3 = createFauxModel({
    responses: [() => fauxToolCall('skip_reply', {}), () => fauxText('')],
  })
  const attemptG3 = await runAttempt(
    {
      runtime: repoRoot,
      cwd: cwdG3,
      artifactDir: artG3,
      scenario: 'G3',
      arm: 'new',
      run: 1,
      attempt: 1,
      thinking: 'medium',
    },
    'test-key',
    modelG3,
  )
  expect({
    status: attemptG3.status,
    reason: attemptG3.reason,
    checks: attemptG3.checks,
  }).toMatchObject({ status: 'pass' })
})
