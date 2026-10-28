import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createChannelVela,
  type IncomingMessage,
} from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'

const secret = 'fixture-only-webhook-secret'
const repo = 'glows777/Vela'
const key = (pr: number) => `github:${repo}#pr/${pr}`
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Minimal consumed subset of Octokit's check_suite/completed payload: a suite has updated_at, not completed_at.
// https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/check_suite/completed.payload.json
function suite(prs = [171], app = 'github-actions') {
  return {
    action: 'completed',
    repository: { full_name: repo },
    check_suite: {
      app: { slug: app },
      head_sha: 'a'.repeat(40),
      conclusion: 'success',
      updated_at: '2026-10-28T10:00:00Z',
      url: 'https://api.github.com/repos/glows777/Vela/check-suites/1',
      pull_requests: prs.map((number) => ({ number })),
    },
  }
}

async function fixture(
  options: {
    apps?: string[]
    receiver?: boolean
    enabled?: Set<string>
    cwd?: string
    receiverConfig?: Record<string, unknown>
  } = {},
) {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), 'vela-webhooks-')))
  if (!options.cwd)
    cleanups.push(() => rm(cwd, { recursive: true, force: true }))
  const logs: string[] = []
  const replies: IncomingMessage[] = []
  const model = createFauxModel({ responses: [] })
  let receive!: (msg: IncomingMessage) => void | Promise<void>
  let stopped = 0
  const enabled = options.enabled ?? new Set(['one', 'two'])
  const vela = createChannelVela({
    cwd,
    dataDir: 'data',
    contextFiles: false,
    model,
    extensionConfig:
      options.receiver === false
        ? {}
        : {
            channel: {
              eventReceiver: options.receiverConfig ?? {
                port: 0,
                github: {
                  secret,
                  repositories: [repo],
                  ...(options.apps ? { apps: options.apps } : {}),
                },
              },
            },
          },
    logger: {
      debug: (s) => logs.push(s),
      info: (s) => logs.push(s),
      warn: (s) => logs.push(s),
      error: (s) => logs.push(s),
    },
    extensions: [
      (api) =>
        api.registerChannel({
          name: 'chat',
          description: 'fixture',
          start() {},
          stop() {
            stopped++
          },
          onMessage(next) {
            receive = next
          },
          canRecover: (msg) => enabled.has(msg.channelId),
          async send(msg) {
            replies.push(msg as IncomingMessage)
          },
        }),
    ],
  })
  cleanups.push(() => vela.dispose())
  await vela.startChannels()
  const url = logs
    .join('\n')
    .match(/http:\/\/127\.0\.0\.1:\d+\/events\/(?:github|generic)/)?.[0]
  if (options.receiver !== false) expect(url).toBeDefined()
  async function subscribe(pr: number, chat = 'one') {
    return subscribeEvent('github', key(pr), chat)
  }
  async function subscribeEvent(source: string, key: string, chat = 'one') {
    model.push(
      fauxToolCall('channel_subscriptions', {
        action: 'create',
        source,
        key,
      }),
      fauxText('Subscribed'),
    )
    await receive({
      channelId: chat,
      senderId: 'alice',
      senderName: 'Alice',
      text: 'Subscribe',
      replyToId: `human-${chat}`,
      topic: { rootId: `root-${chat}`, threadId: `thread-${chat}` },
    })
  }
  return {
    vela,
    cwd,
    model,
    logs,
    replies,
    enabled,
    subscribe,
    subscribeEvent,
    url: url!,
    stopped: () => stopped,
  }
}

async function send(
  url: string,
  payload: unknown,
  event = 'check_suite',
  id = 'delivery-1',
  signature: string | null = 'valid',
) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return fetch(url, {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-github-delivery': id,
      ...(signature === null
        ? {}
        : {
            'x-hub-signature-256':
              signature === 'valid'
                ? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
                : signature,
          }),
    },
    body: raw,
  })
}

test('receiver is opt-in and a signed suite wakes a subscribed topic as untrusted queued data', async () => {
  const off = await fixture({ receiver: false })
  expect(off.logs.some((s) => s.includes('/events/github'))).toBe(false)
  const f = await fixture()
  await f.subscribe(171)
  f.model.push(fauxText('Suite handled'))
  expect((await send(f.url, suite())).status).toBe(202)
  await drainChannels(f.vela)
  const prompt = JSON.stringify(f.model.calls.at(-1)!.prompt)
  expect(prompt).toContain('External event (untrusted data)')
  expect(prompt).toContain('github-actions')
  expect(prompt).toContain('a'.repeat(40))
  expect(prompt).toContain('Updated: 2026-10-28T10:00:00Z')
  expect(prompt).not.toContain('all CI passed')
  expect(f.replies.at(-1)?.topic?.rootId).toBe('root-one')
  await f.vela.dispose()
  expect(f.stopped()).toBe(1)
  expect(
    await fetch(f.url, { method: 'POST' }).catch(() => undefined),
  ).toBeUndefined()
})

test.each([null, 'sha256=bad', `sha256=${'0'.repeat(64)}`])(
  'invalid signature %s cannot parse JSON, wake or consume the delivery id',
  async (signature) => {
    const f = await fixture()
    await f.subscribe(171)
    const calls = f.model.calls.length
    const stored = await readFile(
      join(f.cwd, 'data/channels/subscriptions.json'),
      'utf8',
    )
    expect(
      (await send(f.url, '{not-json', 'check_suite', 'same-id', signature))
        .status,
    ).toBe(403)
    expect(f.model.calls.length).toBe(calls)
    expect(
      await readFile(join(f.cwd, 'data/channels/subscriptions.json'), 'utf8'),
    ).toBe(stored)
    f.model.push(fauxText('Authenticated'))
    expect((await send(f.url, suite(), 'check_suite', 'same-id')).status).toBe(
      202,
    )
    await drainChannels(f.vela)
    expect(f.model.calls.length).toBe(calls + 1)
  },
)

test('signature covers original bytes before JSON parsing; authenticated malformed JSON is rejected', async () => {
  const f = await fixture()
  const raw = JSON.stringify(suite(), null, 2)
  const normalizedSignature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(suite())).digest('hex')}`
  expect(
    (await send(f.url, raw, 'check_suite', 'bytes', normalizedSignature))
      .status,
  ).toBe(403)
  expect((await send(f.url, raw, 'check_suite', 'bytes')).status).toBe(202)
  expect(
    (await send(f.url, '{not-json', 'check_suite', 'malformed')).status,
  ).toBe(400)
  expect((await fetch(f.url)).status).toBe(405)
  expect(
    (await send(f.url.replace('/events/github', '/other'), suite())).status,
  ).toBe(404)
})

test('dedup is once per delivery before concurrent multi-PR fanout', async () => {
  const f = await fixture()
  await f.subscribe(171)
  await f.subscribe(172, 'two')
  const calls = f.model.calls.length
  f.model.push(fauxText('First PR'), fauxText('Second PR'))
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => send(f.url, suite([171, 172, 171]))),
  )
  expect(responses.map((r) => r.status)).toEqual([202, 202, 202])
  await drainChannels(f.vela)
  expect(f.model.calls.length).toBe(calls + 2)
  expect(
    f.replies
      .slice(-2)
      .map((r) => r.channelId)
      .sort(),
  ).toEqual(['one', 'two'])
})

test('GitHub app/repository/event filters and empty mapping drop without work or external lookup', async () => {
  const f = await fixture()
  await f.subscribe(171)
  const calls = f.model.calls.length
  for (const [payload, event] of [
    [suite([171], 'codex'), 'check_suite'],
    [
      {
        ...suite(),
        check_suite: {
          ...suite().check_suite,
          app: { name: 'app-without-slug' },
        },
      },
      'check_suite',
    ],
    [suite([]), 'check_suite'],
    [{ ...suite(), repository: { full_name: 'other/repo' } }, 'check_suite'],
    [{ ...suite(), action: 'requested' }, 'check_suite'],
    [{ ...suite(), action: 'created' }, 'pull_request_review_comment'],
    [
      {
        action: 'created',
        repository: { full_name: repo },
        issue: { number: 171 },
        comment: { body: 'ordinary issue' },
      },
      'issue_comment',
    ],
  ] as const)
    expect(
      (await send(f.url, payload, event, crypto.randomUUID())).status,
    ).toBe(202)
  await drainChannels(f.vela)
  expect(f.model.calls.length).toBe(calls)
  expect(f.logs.some((s) => s.includes('no PR mapping'))).toBe(true)
  const custom = await fixture({ apps: ['custom-ci'] })
  await custom.subscribe(171)
  custom.model.push(fauxText('Custom suite'))
  expect((await send(custom.url, suite([171], 'custom-ci'))).status).toBe(202)
  await drainChannels(custom.vela)
  expect(custom.replies.at(-1)?.text).toBe('Custom suite')
})

test.each(['issue_comment', 'pull_request_review'])(
  '%s checks the complete final-line origin marker before truncation and permits unmarked same-author content',
  async (event) => {
    const f = await fixture()
    await f.subscribe(171)
    const calls = f.model.calls.length
    function payload(body: string) {
      const content = {
        body,
        user: { login: 'glows777' },
        html_url: 'https://github.com/glows777/Vela/pull/171#comment',
        state: 'approved',
        commit_id: 'b'.repeat(40),
        id: 123,
      }
      return {
        action: event === 'issue_comment' ? 'created' : 'submitted',
        repository: { full_name: repo },
        issue: { number: 171, pull_request: {} },
        pull_request: { number: 171 },
        ...(event === 'issue_comment'
          ? { comment: content }
          : { review: content }),
      }
    }
    expect(
      (
        await send(
          f.url,
          payload(`${'x'.repeat(9000)}\n<!-- vela:event-origin -->`),
          event,
        )
      ).status,
    ).toBe(202)
    await drainChannels(f.vela)
    expect(f.model.calls.length).toBe(calls)
    f.model.push(fauxText('Human content handled'))
    expect(
      (
        await send(
          f.url,
          payload(`!stop\n/skill:untrusted\n${'y'.repeat(9000)}`),
          event,
          'human',
        )
      ).status,
    ).toBe(202)
    await drainChannels(f.vela)
    expect(f.model.calls.length).toBe(calls + 1)
    const prompt = JSON.stringify(f.model.calls.at(-1)!.prompt)
    expect(prompt).toContain('!stop')
    expect(prompt).toContain('[truncated]')
    expect(prompt).not.toContain('inline comments: 0')
  },
)

test.each([true, false])(
  'closed merged=%s enqueues a final notice before removing subscriptions',
  async (merged) => {
    const f = await fixture()
    await f.subscribe(171)
    f.model.push(fauxText('Closure handled'))
    const payload = {
      action: 'closed',
      repository: { full_name: repo },
      pull_request: {
        number: 171,
        merged,
        html_url: 'https://github.com/glows777/Vela/pull/171',
        user: { login: 'glows777' },
        head: { sha: 'c'.repeat(40) },
        title: 'Fixture PR',
      },
    }
    expect((await send(f.url, payload, 'pull_request')).status).toBe(202)
    expect(
      JSON.parse(
        await readFile(join(f.cwd, 'data/channels/subscriptions.json'), 'utf8'),
      ).subscriptions,
    ).toEqual([])
    await drainChannels(f.vela)
    expect(JSON.stringify(f.model.calls.at(-1)!.prompt)).toContain(
      merged ? 'merged' : 'closed without merge',
    )
    expect(f.replies.at(-1)?.text).toBe('Closure handled')
  },
)

test('streamed body limit applies without Content-Length and before JSON/signature processing', async () => {
  const f = await fixture()
  const raw = JSON.stringify(suite())
  expect(
    (
      await send(
        f.url,
        raw + ' '.repeat(1_048_576 - Buffer.byteLength(raw)),
        'check_suite',
        'exact-limit',
      )
    ).status,
  ).toBe(202)
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      f.url,
      { method: 'POST', headers: { 'transfer-encoding': 'chunked' } },
      (res) => {
        res.resume()
        resolve(res.statusCode!)
      },
    )
    req.on('error', reject)
    req.write(Buffer.alloc(600_000, 'x'))
    req.end(Buffer.alloc(600_000, 'x'))
  })
  expect(status).toBe(413)
  expect((await send(f.url, 'x'.repeat(1_048_577))).status).toBe(413)
  expect(f.model.calls.length).toBe(0)
})

test('disabled subscribed target does not execute signed events or forward them elsewhere', async () => {
  const f = await fixture()
  await f.subscribe(171)
  f.enabled.delete('one')
  const calls = f.model.calls.length
  expect((await send(f.url, suite())).status).toBe(202)
  await drainChannels(f.vela)
  expect(f.model.calls.length).toBe(calls)
})

test('delivery ids are bounded in memory and a new runtime accepts a redelivery', async () => {
  const f = await fixture()
  await f.subscribe(171)
  f.model.push(fauxText('First'), fauxText('Evicted'))
  await send(f.url, suite())
  await drainChannels(f.vela)
  const calls = f.model.calls.length
  for (let i = 0; i < 1000; i++)
    expect((await send(f.url, {}, 'ping', `ignored-${i}`)).status).toBe(202)
  await send(f.url, suite())
  await drainChannels(f.vela)
  expect(f.model.calls.length).toBe(calls + 1)
  await f.vela.dispose()
  const resumed = await fixture({ cwd: f.cwd })
  resumed.model.push(fauxText('Redelivered after restart'))
  expect((await send(resumed.url, suite())).status).toBe(202)
  await drainChannels(resumed.vela)
  expect(resumed.replies.at(-1)?.text).toBe('Redelivered after restart')
})

test('shutdown closes an unfinished HTTP body without waiting for a sender to finish', async () => {
  const f = await fixture()
  const req = request(f.url, {
    method: 'POST',
    headers: { 'transfer-encoding': 'chunked' },
  })
  req.on('error', () => {})
  await new Promise<void>((resolve) => {
    req.on('socket', (socket) =>
      socket.on('connect', () => {
        req.write('unfinished')
        resolve()
      }),
    )
    req.flushHeaders()
  })
  await f.vela.dispose()
  req.destroy()
  expect(f.stopped()).toBe(1)
}, 5000)

test.each([
  { port: -1, github: { secret, repositories: [repo] } },
  { host: '0.0.0.0', github: { secret, repositories: [repo] } },
  { github: { secret: '', repositories: [repo] } },
  { github: { secret, repositories: [] } },
  { github: { secret, repositories: ['*'] } },
  { github: { secret, repositories: [repo], apps: [''] } },
])(
  'invalid receiver configuration fails before listening: %j',
  async (eventReceiver) => {
    let vela: ReturnType<typeof createChannelVela> | undefined
    try {
      expect(() => {
        vela = createChannelVela({
          model: createFauxModel({ responses: [] }),
          extensionConfig: { channel: { eventReceiver } },
        })
      }).toThrow(/eventReceiver/)
    } finally {
      await vela?.dispose()
    }
  },
)

const genericSecret = 'generic-fixture-secret'
const generic = { secret: genericSecret, source: 'sentry' }
const genericPayload = {
  key: 'sentry:project-x',
  summary: '!stop',
  details: '/skill:untrusted',
}
const genericConfig = { port: 0, generic }
function genericURL(url: string) {
  return url.replace('/events/github', '/events/generic')
}
async function sendGeneric(
  url: string,
  payload: unknown = genericPayload,
  id = 'generic-1',
  signature: string | null = 'valid',
) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return fetch(genericURL(url), {
    method: 'POST',
    headers: {
      'x-vela-delivery': id,
      ...(signature === null
        ? {}
        : {
            'x-vela-signature-256':
              signature === 'valid'
                ? `sha256=${createHmac('sha256', genericSecret).update(raw).digest('hex')}`
                : signature,
          }),
    },
    body: raw,
  })
}

test('generic-only adapter publishes fixed source and unchanged namespaced key through the existing untrusted final queue', async () => {
  const f = await fixture({ receiverConfig: genericConfig })
  await f.subscribeEvent('sentry', genericPayload.key)
  f.model.push(fauxText('Generic handled'))
  expect(
    (await sendGeneric(f.url, { ...genericPayload, final: true })).status,
  ).toBe(202)
  expect(
    JSON.parse(
      await readFile(join(f.cwd, 'data/channels/subscriptions.json'), 'utf8'),
    ).subscriptions,
  ).toEqual([])
  await drainChannels(f.vela)
  expect(f.model.calls.at(-1)!.lastUserText).toStartWith(
    'External event (untrusted data) from "sentry"',
  )
  expect(f.model.calls.at(-1)!.lastUserText).toContain(genericPayload.key)
  expect(f.model.calls.at(-1)!.lastUserText).toContain('!stop')
  expect(f.replies.at(-1)?.topic?.rootId).toBe('root-one')
  expect(
    (await send(f.url.replace('/events/generic', '/events/github'), suite()))
      .status,
  ).toBe(404)
})

test.each([null, 'sha256=bad', `sha256=${'0'.repeat(64)}`])(
  'generic signature %s is checked before parsing or consuming the delivery id',
  async (signature) => {
    const f = await fixture({ receiverConfig: genericConfig })
    await f.subscribeEvent('sentry', genericPayload.key)
    const calls = f.model.calls.length
    expect(
      (await sendGeneric(f.url, '{bad-json', 'same', signature)).status,
    ).toBe(403)
    expect(f.model.calls.length).toBe(calls)
    f.model.push(fauxText('Valid generic'))
    expect((await sendGeneric(f.url, genericPayload, 'same')).status).toBe(202)
    await drainChannels(f.vela)
    expect(f.model.calls.length).toBe(calls + 1)
  },
)

test('generic strict payload rejects namespace/source/target/authority injection without state or model changes', async () => {
  const f = await fixture({ receiverConfig: genericConfig })
  await f.subscribeEvent('sentry', genericPayload.key)
  const path = join(f.cwd, 'data/channels/subscriptions.json')
  const stored = await readFile(path, 'utf8')
  const calls = f.model.calls.length
  for (const payload of [
    ...[
      'github:repo#pr/1',
      'other:project',
      'sentry:',
      'sentry:   ',
      ' sentry:project-x',
      'sentry:project-x ',
    ].map((key) => ({ ...genericPayload, key, final: true })),
    ...[
      'source',
      'deliveryId',
      'target',
      'chatId',
      'sessionId',
      'permissions',
      'unknown',
    ].map((name) => ({ ...genericPayload, [name]: 'injected', final: true })),
    { ...genericPayload, summary: '' },
    { ...genericPayload, final: 'true' },
  ])
    expect(
      (await sendGeneric(f.url, payload, crypto.randomUUID())).status,
    ).toBe(400)
  await drainChannels(f.vela)
  expect(f.model.calls.length).toBe(calls)
  expect(await readFile(path, 'utf8')).toBe(stored)
})

test('generic and GitHub secrets and delivery IDs are isolated on the shared receiver', async () => {
  const f = await fixture({
    receiverConfig: {
      ...genericConfig,
      github: { secret, repositories: [repo] },
    },
  })
  await f.subscribe(171)
  await f.subscribeEvent('sentry', genericPayload.key, 'two')
  const calls = f.model.calls.length
  const raw = JSON.stringify(genericPayload)
  expect(
    (
      await sendGeneric(
        f.url,
        raw,
        'same',
        `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      )
    ).status,
  ).toBe(403)
  const githubRaw = JSON.stringify(suite())
  expect(
    (
      await send(
        f.url,
        githubRaw,
        'check_suite',
        'same',
        `sha256=${createHmac('sha256', genericSecret).update(githubRaw).digest('hex')}`,
      )
    ).status,
  ).toBe(403)
  f.model.push(fauxText('Generic result'), fauxText('GitHub result'))
  const responses = await Promise.all([
    sendGeneric(f.url, genericPayload, 'same'),
    sendGeneric(f.url, genericPayload, 'same'),
    send(f.url, suite(), 'check_suite', 'same'),
  ])
  expect(responses.map((r) => r.status)).toEqual([202, 202, 202])
  await drainChannels(f.vela)
  expect(f.model.calls.length).toBe(calls + 2)
  expect(
    f.replies
      .slice(-2)
      .map((r) => r.channelId)
      .sort(),
  ).toEqual(['one', 'two'])
})

test('generic raw-byte signature, streaming limit and disabled-target boundaries reuse the receiver', async () => {
  const f = await fixture({ receiverConfig: genericConfig })
  await f.subscribeEvent('sentry', genericPayload.key)
  const raw = JSON.stringify(genericPayload, null, 2)
  expect(
    (
      await sendGeneric(
        f.url,
        raw,
        'raw',
        `sha256=${createHmac('sha256', genericSecret).update(JSON.stringify(genericPayload)).digest('hex')}`,
      )
    ).status,
  ).toBe(403)
  expect((await sendGeneric(f.url, '{bad-json', 'malformed')).status).toBe(400)
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      genericURL(f.url),
      { method: 'POST', headers: { 'transfer-encoding': 'chunked' } },
      (res) => {
        res.resume()
        resolve(res.statusCode!)
      },
    )
    req.on('error', reject)
    req.write(Buffer.alloc(600_000, 'x'))
    req.end(Buffer.alloc(600_000, 'x'))
  })
  expect(status).toBe(413)
  const calls = f.model.calls.length
  f.enabled.delete('one')
  expect((await sendGeneric(f.url, raw, 'disabled')).status).toBe(202)
  await drainChannels(f.vela)
  expect(f.model.calls.length).toBe(calls)
})

test('an unconfigured generic route is absent on a GitHub-only receiver', async () => {
  const f = await fixture()
  expect((await sendGeneric(f.url)).status).toBe(404)
})

test.each([
  { secret: genericSecret, source: 'github' },
  { secret: genericSecret, source: 'GiTHuB' },
  { secret: genericSecret, source: '' },
  { secret: '', source: 'sentry' },
  { secret: genericSecret, source: 'sentry', sources: ['other'] },
])(
  'generic config rejects reserved/invalid source and unsupported options: %j',
  async (generic) => {
    let vela: ReturnType<typeof createChannelVela> | undefined
    try {
      expect(() => {
        vela = createChannelVela({
          model: createFauxModel({ responses: [] }),
          extensionConfig: { channel: { eventReceiver: { generic } } },
        })
      }).toThrow(/eventReceiver/)
    } finally {
      await vela?.dispose()
    }
  },
)

test('the two adapters require separate configured secrets', async () => {
  expect(() =>
    createChannelVela({
      model: createFauxModel({ responses: [] }),
      extensionConfig: {
        channel: {
          eventReceiver: {
            github: { secret, repositories: [repo] },
            generic: { secret, source: 'sentry' },
          },
        },
      },
    }),
  ).toThrow(/eventReceiver/)
})
