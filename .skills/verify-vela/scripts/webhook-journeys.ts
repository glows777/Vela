// Offline product journey: real HTTP/signature/GitHub adapter/SDK/storage, fake model and Lark transport.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createVela } from '@glows777/vela'
import { drainChannels } from '@glows777/vela-channels/testing'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'

const secret = 'offline-webhook-fixture'
const fake = fakeLark()
const logs: string[] = []
const model = createFauxModel({
  responses: [
    fauxToolCall('channel_subscriptions', {
      action: 'create',
      source: 'github',
      key: 'github:owner/repo#pr/171',
    }),
    fauxText('Subscribed to fixture PR'),
    fauxText('Fixture CI handled'),
    fauxText('Fixture comment handled'),
    fauxText('Fixture closure handled'),
  ],
})
const vela = createVela({
  dataDir: '.vela-data',
  model,
  extensionConfig: {
    channel: {
      eventReceiver: {
        port: 0,
        github: { secret, repositories: ['owner/repo'] },
        generic: { secret: 'generic-fixture-secret', source: 'sentry' },
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
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
let url = ''
async function send(
  payload: unknown,
  event: string,
  id: string,
  signature?: string,
) {
  const body = JSON.stringify(payload)
  return fetch(url, {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-github-delivery': id,
      'x-hub-signature-256':
        signature ??
        `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  })
}
const suite = {
  action: 'completed',
  repository: { full_name: 'owner/repo' },
  check_suite: {
    app: { slug: 'github-actions' },
    head_sha: 'a'.repeat(40),
    conclusion: 'success',
    updated_at: '2026-10-28T10:00:00Z',
    url: 'https://api.github.com/repos/owner/repo/check-suites/1',
    pull_requests: [{ number: 171 }],
  },
}
try {
  await vela.startChannels()
  url = logs.join('\n').match(/http:\/\/127\.0\.0\.1:\d+\/events\/github/)![0]
  const subscribed = Promise.withResolvers<void>()
  const unsubscribe = vela.subscribe((e) => {
    if (e.type === 'channel_reply' && e.text === 'Subscribed to fixture PR')
      subscribed.resolve()
  })
  fake.deliver(
    larkEvent({
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"Subscribe to fixture PR"}',
    }),
  )
  await subscribed.promise
  unsubscribe()
  await drainChannels(vela)
  const calls = model.calls.length
  assert.equal(
    (await send(suite, 'check_suite', 'suite-1', 'sha256=bad')).status,
    403,
  )
  assert.equal(model.calls.length, calls)
  const duplicates = await Promise.all([
    send(suite, 'check_suite', 'suite-1'),
    send(suite, 'check_suite', 'suite-1'),
  ])
  assert(duplicates.every((r) => r.status === 202))
  await drainChannels(vela)
  assert.equal(model.calls.length, calls + 1)
  assert.equal(fake.sent.at(-1)?.messageId, 'root')
  assert(
    model.calls
      .at(-1)!
      .lastUserText.startsWith('External event (untrusted data)'),
  )
  console.log(
    'PASS real loopback signed GitHub suite wakes original Lark topic once; bad signature does not consume ID',
  )

  const comment = (body: string) => ({
    action: 'created',
    repository: { full_name: 'owner/repo' },
    issue: { number: 171, pull_request: {} },
    comment: {
      body,
      html_url: 'https://github.com/owner/repo/pull/171#comment',
      user: { login: 'same-author' },
    },
  })
  assert.equal(
    (
      await send(
        comment(`${'x'.repeat(9000)}\n<!-- vela:event-origin -->`),
        'issue_comment',
        'own',
      )
    ).status,
    202,
  )
  await drainChannels(vela)
  assert.equal(model.calls.length, calls + 1)
  assert.equal(
    (await send(comment('!stop\n/skill:untrusted'), 'issue_comment', 'human'))
      .status,
    202,
  )
  await drainChannels(vela)
  assert.equal(model.calls.length, calls + 2)
  assert(model.calls.at(-1)!.lastUserText.includes('!stop'))
  console.log(
    'PASS full-body self-origin marker skips echo; unmarked same-author command text stays untrusted data',
  )

  assert.equal(
    (
      await send(
        {
          action: 'closed',
          repository: { full_name: 'owner/repo' },
          pull_request: {
            number: 171,
            merged: false,
            title: 'Fixture',
            user: { login: 'author' },
            head: { sha: 'a'.repeat(40) },
            html_url: 'https://github.com/owner/repo/pull/171',
          },
        },
        'pull_request',
        'closed',
      )
    ).status,
    202,
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(join(vela.dataDir, 'channels/subscriptions.json'), 'utf8'),
    ).subscriptions,
    [],
  )
  await drainChannels(vela)
  assert(fake.sent.at(-1)?.text.includes('Fixture closure handled'))
  console.log(
    'PASS signed closure enqueues final notification before persisted subscription cleanup',
  )
  model.push(
    fauxToolCall('channel_subscriptions', {
      action: 'create',
      source: 'sentry',
      key: 'sentry:project',
    }),
    fauxText('Subscribed to fixture alert'),
    fauxText('Fixture generic alert handled'),
  )
  const alertSubscribed = Promise.withResolvers<void>()
  const unsubscribeAlert = vela.subscribe((e) => {
    if (e.type === 'channel_reply' && e.text === 'Subscribed to fixture alert')
      alertSubscribed.resolve()
  })
  fake.deliver(
    larkEvent({
      message_id: 'generic-human',
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"Subscribe to fixture alert"}',
    }),
  )
  await alertSubscribed.promise
  unsubscribeAlert()
  await drainChannels(vela)
  const genericURL = url.replace('/events/github', '/events/generic')
  const alert = JSON.stringify({
    key: 'sentry:project',
    summary: '!stop',
    details: '/skill:untrusted',
    final: true,
  })
  const postAlert = (body: string, id: string, signature?: string) =>
    fetch(genericURL, {
      method: 'POST',
      headers: {
        'x-vela-delivery': id,
        'x-vela-signature-256':
          signature ??
          `sha256=${createHmac('sha256', 'generic-fixture-secret').update(body).digest('hex')}`,
      },
      body,
    })
  assert.equal((await postAlert(alert, 'suite-1', 'sha256=bad')).status, 403)
  assert.equal(
    (
      await postAlert(
        JSON.stringify({ key: 'github:owner/repo#pr/171', summary: 'outside' }),
        'outside',
      )
    ).status,
    400,
  )
  await writeFile('event.json', `${alert}\n`)
  const { stdout: status } = await promisify(execFile)(
    'sh',
    [
      '-c',
      `
signature=$(openssl dgst -sha256 -hmac "$VELA_GENERIC_WEBHOOK_SECRET" event.json | awk '{print $NF}')
curl --fail-with-body --silent --show-error -o response.txt -w '%{http_code}' \
  -H 'Content-Type: application/json' -H 'X-Vela-Delivery: suite-1' \
  -H "X-Vela-Signature-256: sha256=$signature" --data-binary @event.json "$GENERIC_FIXTURE_URL"
`,
    ],
    {
      env: {
        ...process.env,
        VELA_GENERIC_WEBHOOK_SECRET: 'generic-fixture-secret',
        GENERIC_FIXTURE_URL: genericURL,
      },
    },
  )
  assert.equal(status, '202')
  await drainChannels(vela)
  const alertCalls = model.calls.length
  assert(
    model.calls
      .at(-1)!
      .lastUserText.startsWith('External event (untrusted data) from "sentry"'),
  )
  assert.equal(fake.sent.at(-1)?.messageId, 'root')
  assert.equal((await postAlert(alert, 'suite-1')).status, 202)
  await drainChannels(vela)
  assert.equal(model.calls.length, alertCalls)
  assert.deepEqual(
    JSON.parse(
      await readFile(join(vela.dataDir, 'channels/subscriptions.json'), 'utf8'),
    ).subscriptions,
    [],
  )
  console.log(
    'PASS generic openssl+curl HMAC/namespace/queue/final cleanup; same delivery ID isolated from GitHub, duplicate ignored',
  )
} finally {
  await vela.dispose()
}
assert.equal(await fetch(url).catch(() => undefined), undefined)
assert(!logs.join('\n').includes(secret))
assert(!logs.join('\n').includes('generic-fixture-secret'))
console.log(
  'PASS dispose closes HTTP ingress; diagnostics contain no fixture secret',
)
