// Real SDK/topic/subscription/loopback ingress; simulated PR tool, model and channel transport.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  channelSessionId,
  createChannelVela,
  type IncomingMessage,
} from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { z } from 'zod'

const repo = 'owner/repo'
const secret = 'isolated-topic-fixture'
const key = `github:${repo}#pr/274`
const logs: string[] = []
const replies: string[] = []
let receive!: (message: IncomingMessage) => void | Promise<void>
const model = createFauxModel({
  responses: [
    (request) => {
      assert(request.system.includes('After opening or taking over a PR'))
      assert(request.system.includes('PR metadata'))
      assert(request.system.includes(repo))
      assert(!request.system.includes(secret))
      return fauxToolCall('githubFixture_open_pr', {})
    },
    (request) => {
      assert(JSON.stringify(request.toolResults).includes(repo))
      return fauxToolCall('channel_subscriptions', {
        action: 'create',
        source: 'github',
        key,
      })
    },
    fauxText('Opened and subscribed in this topic'),
    (request) => {
      assert(request.lastUserText.startsWith('External event (untrusted data)'))
      return fauxText('Closure handled in this topic')
    },
  ],
})
const vela = createChannelVela({
  cwd: process.cwd(),
  dataDir: 'topic-data',
  contextFiles: false,
  model,
  extensionConfig: {
    channel: {
      eventReceiver: { port: 0, github: { secret, repositories: [repo] } },
    },
  },
  logger: {
    debug: (s) => logs.push(s),
    info: (s) => logs.push(s),
    warn: (s) => logs.push(s),
    error: (s) => logs.push(s),
  },
  extensions: [
    function githubFixture(api) {
      api.registerTool({
        name: 'open_pr',
        description: 'Simulate approved PR creation',
        inputSchema: z.object({}),
        execute: async () => ({ number: 274, repository: { full_name: repo } }),
      })
    },
    (api) =>
      api.registerChannel({
        name: 'fixture',
        description: 'offline topic transport',
        start() {},
        stop() {},
        onMessage(next) {
          receive = next
        },
        canRecover: () => true,
        async send(message) {
          assert.equal(message.topic?.rootId, 'topic-root')
          replies.push(message.text)
        },
      }),
  ],
})
let url = ''
try {
  await vela.startChannels()
  url = logs.join('\n').match(/http:\/\/127\.0\.0\.1:\d+\/events\/github/)![0]
  await receive({
    channelId: 'chat',
    senderId: 'human',
    senderName: 'Fixture',
    text: 'Open the approved PR and watch its feedback here',
    topic: { rootId: 'topic-root', threadId: 'topic-thread' },
  })
  const path = join(process.cwd(), 'topic-data/channels/subscriptions.json')
  const subscribed = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(subscribed.subscriptions.length, 1)
  assert.equal(subscribed.subscriptions[0].key, key)
  assert.equal(
    subscribed.subscriptions[0].targetKey,
    channelSessionId('fixture', 'chat', 'topic-root'),
  )
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
  await drainChannels(vela)
  assert.deepEqual(replies, [
    'Opened and subscribed in this topic',
    'Closure handled in this topic',
  ])
  assert.equal(JSON.parse(await readFile(path, 'utf8')).subscriptions.length, 0)
  assert.equal(model.pending(), 0)
  console.log(
    'PASS SDK PR metadata -> exact persisted topic subscription -> signed closure -> same topic reply -> final subscription removal',
  )
  console.log(
    'LIMITS: scripted model, PR tool and channel transport; no live GitHub, tunnel, Lark or autonomous model behavior verified.',
  )
} finally {
  await vela.dispose()
  await writeFile('topic-logs.json', JSON.stringify(logs, null, 2))
  await writeFile('topic-replies.json', JSON.stringify(replies, null, 2))
}
assert.equal(await fetch(url).catch(() => undefined), undefined)
