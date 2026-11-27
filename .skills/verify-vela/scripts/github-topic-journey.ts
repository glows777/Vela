// Real Runtime/topic/subscription/loopback ingress; simulated PR tool, model and channel transport.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ChannelAdapter,
  type ChannelAdapterContext,
  createRuntime,
  RuntimeWebhookReceiver,
} from '@glows777/vela'
import { z } from 'zod'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

const repo = 'owner/repo'
const secret = 'isolated-topic-fixture'
const key = `github:${repo}#pr/274`
const logs: string[] = []
const replies: string[] = []
let adapterCtx!: ChannelAdapterContext

const model = createFauxModel({
  responses: [
    (request) => {
      assert(request.system.includes('After opening or taking over a PR'))
      assert(request.system.includes(repo))
      assert(!request.system.includes(secret))
      return fauxToolCall('githubFixture_open_pr', {})
    },
    (request) => {
      assert(JSON.stringify(request.toolResults).includes(repo))
      return fauxToolCall('subscriptions', {
        action: 'create',
        source: 'github',
        key,
      })
    },
    fauxText('Opened and subscribed in this topic'),
    (request) => {
      assert(request.lastUserText.includes('untrusted external data'))
      return fauxText('Closure handled in this topic')
    },
  ],
})

const agentDir = join(process.cwd(), 'topic-data')
await mkdir(agentDir, { recursive: true })
await writeFile(
  join(agentDir, 'config.json'),
  JSON.stringify({ webhooks: { github: { secret, repositories: [repo] } } }),
)

const runtime = createRuntime({
  agentDir,
  cwd: process.cwd(),
  defaultModel: model,
  mcp: false,
  logger: {
    debug: (s) => logs.push(s),
    info: (s) => logs.push(s),
    warn: (s) => logs.push(s),
    error: (s) => logs.push(s),
  },
  tools: [
    {
      name: 'githubFixture_open_pr',
      description: 'Simulate approved PR creation',
      inputSchema: z.object({}),
      execute: async () => ({ number: 274, repository: { full_name: repo } }),
    },
  ],
})

const fixtureAdapter: ChannelAdapter = {
  name: 'fixture',
  async start(ctx) {
    adapterCtx = ctx
  },
  async stop() {},
  async deliver(message) {
    assert.equal(message.threadId, 'topic-thread')
    replies.push(message.text)
    return {
      externalMessageId: `out_${replies.length}`,
      threadId: 'topic-thread',
    }
  },
}

const receiver = new RuntimeWebhookReceiver(
  { port: 0, github: { secret, repositories: [repo] } },
  async (event) => {
    await runtime.ingestWebhookEvent(event)
  },
  {
    debug: (s) => logs.push(s),
    info: (s) => logs.push(s),
    warn: (s) => logs.push(s),
    error: (s) => logs.push(s),
  },
)

const until = async (what: string, ok: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

let url = ''
try {
  await runtime.ready()
  const project = await runtime.projects.create({
    name: 'chat',
    cwd: process.cwd(),
    hubSessionId: true,
  })
  await runtime.bindings.upsert({
    channel: 'fixture',
    externalId: 'chat',
    threadId: null,
    kind: 'group',
    projectId: project.id,
    enabled: true,
  })
  await runtime.registerChannel(fixtureAdapter)
  await receiver.start()
  url = `http://127.0.0.1:${receiver.port}/events/github`
  assert.ok(receiver.port, 'GitHub receiver port missing')

  const receipt = await adapterCtx.ingestWithReceipt!({
    channel: 'fixture',
    dedupeKey: 'open-pr-1',
    externalChatId: 'chat',
    kind: 'group',
    threadId: 'topic-thread',
    threadRootId: 'topic-root',
    senderId: 'human',
    senderName: 'Fixture',
    text: 'Open the approved PR and watch its feedback here',
    timestamp: new Date().toISOString(),
  })
  assert.equal(receipt.admitted, true)
  await until('opened reply', () => replies.length === 1)

  const subscribed = await runtime.subscriptions.list()
  assert.equal(subscribed.length, 1)
  assert.equal(subscribed[0]!.eventKey, key)
  assert.equal(subscribed[0]!.sessionId, receipt.sessionId)
  await writeFile('topic-subscribed.json', JSON.stringify(subscribed, null, 2))

  const body = JSON.stringify({
    action: 'closed',
    repository: { full_name: repo },
    pull_request: {
      number: 274,
      merged: true,
      title: 'Fixture PR',
      user: { login: 'fixture' },
      head: { sha: 'a'.repeat(40) },
      html_url: 'https://github.com/owner/repo/pull/274',
    },
  })
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        body,
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'topic-closure',
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
      })
    ).status,
    202,
  )
  await until('closure reply', () => replies.length === 2)
  assert.deepEqual(replies, [
    'Opened and subscribed in this topic',
    'Closure handled in this topic',
  ])
  assert.equal((await runtime.subscriptions.list()).length, 0)
  assert.equal(model.pending(), 0)
  console.log(
    'PASS Runtime PR metadata -> exact persisted topic subscription -> signed closure -> same topic reply -> final subscription removal',
  )
} finally {
  await receiver.stop()
  await runtime.dispose()
  await writeFile('topic-logs.json', JSON.stringify(logs, null, 2))
  await writeFile('topic-replies.json', JSON.stringify(replies, null, 2))
}
assert.equal(await fetch(url).catch(() => undefined), undefined)
