// Offline product journey: real HTTP/signature/GitHub adapter/Runtime/SQLite storage, fake model & Lark transport.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRuntime, RuntimeWebhookReceiver } from '@glows777/vela'
import { DaemonLarkHost } from '../../../packages/vela/src/legacy-desktop.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../../../test/support/lark.ts'
import { prepareWorkspace } from './workspace.ts'

prepareWorkspace()

const secret = 'offline-webhook-fixture'
const fake = fakeLark()
const logs: string[] = []
const logger = {
  debug: (s: string) => logs.push(s),
  info: (s: string) => logs.push(s),
  warn: (s: string) => logs.push(s),
  error: (s: string) => logs.push(s),
}
const model = createFauxModel({
  responses: [
    fauxToolCall('subscriptions', {
      action: 'create',
      source: 'github',
      key: 'github:owner/repo#pr/171',
    }),
    fauxText('Subscribed to fixture PR'),
    fauxText('Fixture CI handled'),
    fauxText('Fixture comment handled'),
    fauxText('Fixture review handled'),
  ],
})
const agentDir = join(process.cwd(), '.vela-data-webhook')
const runtime = createRuntime({
  agentDir,
  defaultModel: model,
  mcp: false,
  logger,
})
const host = new DaemonLarkHost(runtime, {
  agentDir,
  hostEnv: {},
  logger,
  transport: fake.transport,
})
const receiver = new RuntimeWebhookReceiver(
  {
    port: 0,
    github: { secret, repositories: ['owner/repo'] },
    generic: { secret: 'generic-fixture-secret', source: 'sentry' },
  },
  async (event) => {
    await runtime.ingestWebhookEvent(event)
  },
  logger,
)

let url = ''
type Fake = ReturnType<typeof fakeLark>
function lastTopicOrSent(target: Fake) {
  const top = target.topics.at(-1)
  const sent = target.sent.at(-1)
  return {
    topics: target.topics,
    sent: target.sent,
    has(text: string, messageId?: string) {
      return (
        target.sent.some(
          (m) =>
            m.text.includes(text) && (!messageId || m.messageId === messageId),
        ) ||
        target.topics.some(
          (t) =>
            t.title.includes(text) && (!messageId || t.messageId === messageId),
        )
      )
    },
    top,
    sentMsg: sent,
  }
}
async function until(what: string, ok: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
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
type IssueLabel = { name: string }

function issueBody(
  action: string,
  labels: IssueLabel[],
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    repository: { full_name: 'owner/repo' },
    issue: {
      number: 332,
      title: 'Fixture issue',
      html_url: 'https://github.com/owner/repo/issues/332',
      user: { login: 'author' },
      body: 'Fixture issue body',
      labels,
    },
    ...extra,
  }
}

function issueNote(body: string, labels: IssueLabel[]) {
  return {
    action: 'created',
    repository: { full_name: 'owner/repo' },
    issue: { number: 332, title: 'Fixture issue', labels },
    comment: {
      body,
      html_url: 'https://github.com/owner/repo/issues/332#issuecomment-1',
      user: { login: 'same-author' },
    },
  }
}

async function proveIssueLabelAllowlist(
  issueLabels: string[] | { all: string[] },
  slug: string,
): Promise<void> {
  const feedLogs: string[] = []
  const feedLogger = {
    debug: (s: string) => feedLogs.push(s),
    info: (s: string) => feedLogs.push(s),
    warn: (s: string) => feedLogs.push(s),
    error: (s: string) => feedLogs.push(s),
  }
  const feedModel = createFauxModel({
    responses: [
      fauxToolCall('subscriptions', {
        action: 'create',
        source: 'github',
        key: 'github:owner/repo#issues',
      }),
      fauxText(`Subscribed ${slug} issue feed`),
      fauxToolCall('subscriptions', {
        action: 'create',
        source: 'github',
        key: 'github:owner/repo#pr/171',
      }),
      fauxText(`Subscribed ${slug} fixture PR`),
    ],
  })
  const feedFake = fakeLark()
  const feedAgentDir = join(process.cwd(), `.vela-data-labels-${slug}`)
  const feedRuntime = createRuntime({
    agentDir: feedAgentDir,
    defaultModel: feedModel,
    mcp: false,
    logger: feedLogger,
  })
  const feedHost = new DaemonLarkHost(feedRuntime, {
    agentDir: feedAgentDir,
    hostEnv: {},
    logger: feedLogger,
    transport: feedFake.transport,
  })
  const feedReceiver = new RuntimeWebhookReceiver(
    {
      port: 0,
      github: { secret, repositories: ['owner/repo'], issueLabels },
    },
    async (event) => {
      await feedRuntime.ingestWebhookEvent(event)
    },
    feedLogger,
  )
  const legacyVela =
    Array.isArray(issueLabels) && issueLabels.includes('to:vela')
  const strict = !Array.isArray(issueLabels)
  const prRoot = `${slug}-root`
  try {
    await feedRuntime.ready()
    await feedHost.sync(
      {
        lark: {
          appId: 'bot',
          owners: ['ou_alice'],
          chats: ['oc_group'],
        },
      },
      true,
    )
    await feedReceiver.start()
    const feedUrl = `http://127.0.0.1:${feedReceiver.port}/events/github`
    const post = (payload: unknown, event: string, id: string) => {
      const body = JSON.stringify(payload)
      return fetch(feedUrl, {
        method: 'POST',
        headers: {
          'x-github-event': event,
          'x-github-delivery': id,
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        body,
      })
    }
    const waitForText = async (text: string, deliver: () => void) => {
      deliver()
      await until(text, () => lastTopicOrSent(feedFake).has(text))
    }
    await waitForText(`Subscribed ${slug} issue feed`, () => {
      feedFake.deliver(
        larkEvent({
          message_id: `${slug}-group`,
          content: `{"text":"@_user_1 Subscribe ${slug} issue feed"}`,
        }),
      )
    })
    await waitForText(`Subscribed ${slug} fixture PR`, () => {
      feedFake.deliver(
        larkEvent({
          message_id: `${slug}-topic`,
          root_id: prRoot,
          thread_id: `thread_${prRoot}`,
          content: `{"text":"@_user_1 Subscribe ${slug} fixture PR"}`,
        }),
      )
    })
    let calls = feedModel.calls.length
    const rows: {
      id: string
      payload: unknown
      event: string
      wake: boolean
    }[] = [
      {
        id: `${slug}-opened-plain`,
        payload: issueBody('opened', []),
        event: 'issues',
        wake: false,
      },
      {
        id: `${slug}-opened-other`,
        payload: issueBody('opened', [{ name: 'bug' }]),
        event: 'issues',
        wake: false,
      },
      {
        id: `${slug}-opened-labeled`,
        payload: issueBody('opened', [{ name: 'to:vela' }]),
        event: 'issues',
        wake: legacyVela,
      },
      {
        id: `${slug}-closed-labeled`,
        payload: issueBody('closed', [{ name: 'to:vela' }]),
        event: 'issues',
        wake: legacyVela,
      },
      {
        id: `${slug}-action-labeled`,
        payload: issueBody('labeled', [{ name: 'to:vela' }], {
          label: { name: 'to:vela' },
        }),
        event: 'issues',
        wake: legacyVela,
      },
      {
        id: `${slug}-comment-plain`,
        payload: issueNote('Ordinary issue comment', []),
        event: 'issue_comment',
        wake: false,
      },
      {
        id: `${slug}-comment-labeled`,
        payload: issueNote('Labeled issue comment', [{ name: 'to:vela' }]),
        event: 'issue_comment',
        wake: legacyVela,
      },
    ]
    if (strict) {
      const assigned = { name: 'to:vela' }
      const ready = { name: 'status:ready' }
      const other = { name: 'to:friday' }
      const priority = { name: 'P1' }
      const both = [assigned, ready]
      rows.push(
        {
          id: 'all-opened',
          payload: issueBody('opened', both),
          event: 'issues',
          wake: true,
        },
        {
          id: 'all-closed',
          payload: issueBody('closed', both),
          event: 'issues',
          wake: true,
        },
        {
          id: 'all-comment',
          payload: issueNote('Ready for Vela', both),
          event: 'issue_comment',
          wake: true,
        },
        {
          id: 'ready-only',
          payload: issueBody('opened', [ready]),
          event: 'issues',
          wake: false,
        },
        {
          id: 'all-applied',
          payload: issueBody('labeled', both, { label: ready }),
          event: 'issues',
          wake: true,
        },
        {
          id: 'friday-applied',
          payload: issueBody('labeled', [other, ready], { label: ready }),
          event: 'issues',
          wake: false,
        },
        {
          id: 'priority-applied',
          payload: issueBody('labeled', [...both, priority], {
            label: priority,
          }),
          event: 'issues',
          wake: false,
        },
      )
    }
    for (const row of rows) {
      if (row.wake) feedModel.push(fauxText(`${row.id} handled`))
      const sentBefore = feedFake.sent.length
      assert.equal((await post(row.payload, row.event, row.id)).status, 202)
      if (row.wake) {
        await until(row.id, () =>
          feedFake.sent
            .slice(sentBefore)
            .some((m) => m.text.includes(`${row.id} handled`)),
        )
        calls += 1
      } else {
        await feedRuntime.waitForIdle()
      }
      assert.equal(feedModel.calls.length, calls)
      if (!row.wake) continue
      assert(feedFake.sent.at(-1)?.text.includes(`${row.id} handled`))
      assert.notEqual(feedFake.sent.at(-1)?.messageId, prRoot)
      assert(
        feedModel.calls
          .at(-1)!
          .lastUserText.includes('github:owner/repo#issues'),
      )
    }
    assert.deepEqual(
      (await feedRuntime.subscriptions.list()).map((s) => s.eventKey),
      ['github:owner/repo#issues', 'github:owner/repo#pr/171'],
    )
    feedModel.push(fauxText(`${slug} PR comment handled`))
    assert.equal(
      (
        await post(
          {
            action: 'created',
            repository: { full_name: 'owner/repo' },
            issue: {
              number: 171,
              title: 'Fixture',
              pull_request: {},
              labels: [],
            },
            comment: {
              body: 'PR feedback',
              html_url: 'https://github.com/owner/repo/pull/171#comment',
              user: { login: 'same-author' },
            },
          },
          'issue_comment',
          `${slug}-pr-comment`,
        )
      ).status,
      202,
    )
    await until('pr comment reply', () =>
      lastTopicOrSent(feedFake).has(`${slug} PR comment handled`, prRoot),
    )
    assert.equal(feedModel.calls.length, calls + 1)
    assert(
      feedModel.calls.at(-1)!.lastUserText.includes('github:owner/repo#pr/171'),
    )
    assert(
      !feedModel.calls
        .at(-1)!
        .lastUserText.includes('github:owner/repo#issues'),
    )
    console.log(
      `PASS ${slug} Issue label filter; PR comments still reach only their topic`,
    )
  } finally {
    await feedReceiver.stop()
    await feedHost.stop()
    await feedRuntime.dispose()
  }
  assert(!feedLogs.join('\n').includes(secret))
}

try {
  await runtime.ready()
  await host.sync(
    {
      lark: {
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
      },
    },
    true,
  )
  await receiver.start()
  url = `http://127.0.0.1:${receiver.port}/events/github`

  fake.deliver(
    larkEvent({
      root_id: 'root',
      thread_id: 'thread_root',
      content: '{"text":"@_user_1 Subscribe to fixture PR"}',
    }),
  )
  await until('pr subscribed', () =>
    lastTopicOrSent(fake).has('Subscribed to fixture PR'),
  )
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
  await until('ci handled', () =>
    lastTopicOrSent(fake).has('Fixture CI handled', 'root'),
  )
  assert.equal(model.calls.length, calls + 1)
  assert(model.calls.at(-1)!.lastUserText.includes('untrusted external data'))
  console.log(
    'PASS real loopback signed GitHub suite wakes original Lark topic once; bad signature does not consume ID',
  )

  const comment = (body: string) => ({
    action: 'created',
    repository: { full_name: 'owner/repo' },
    issue: { number: 171, title: 'Fixture', pull_request: {} },
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
  await runtime.waitForIdle()
  assert.equal(model.calls.length, calls + 1)
  assert.equal(
    (await send(comment('!stop\n/skill:untrusted'), 'issue_comment', 'human'))
      .status,
    202,
  )
  await until('comment handled', () =>
    lastTopicOrSent(fake).has('Fixture comment handled', 'root'),
  )
  assert.equal(model.calls.length, calls + 2)
  assert(model.calls.at(-1)!.lastUserText.includes('!stop'))
  console.log(
    'PASS full-body self-origin marker skips echo; unmarked same-author command text stays untrusted data',
  )

  assert.equal(
    (
      await send(
        {
          action: 'submitted',
          repository: { full_name: 'owner/repo' },
          pull_request: { number: 171 },
          review: {
            id: 5968407723,
            body: 'Here are some automated review suggestions',
            user: { login: 'chatgpt-codex-connector[bot]' },
            html_url:
              'https://github.com/owner/repo/pull/171#pullrequestreview-5968407723',
            state: 'commented',
            commit_id: 'b'.repeat(40),
          },
        },
        'pull_request_review',
        'review',
      )
    ).status,
    202,
  )
  await until('review handled', () =>
    lastTopicOrSent(fake).has('Fixture review handled', 'root'),
  )
  assert.equal(model.calls.length, calls + 3)
  assert(
    model.calls
      .at(-1)!
      .lastUserText.includes(
        'GET /repos/owner/repo/pulls/171/reviews/5968407723/comments',
      ),
  )
  console.log(
    'PASS a signed review wakes the topic with its review id and inline-comment endpoint',
  )

  assert.equal(
    (
      await send(
        { ...suite, action: 'created' },
        'pull_request_review_comment',
        'inline',
      )
    ).status,
    202,
  )
  await runtime.waitForIdle()
  assert.equal(model.calls.length, calls + 3)
  assert(
    logs.some((line) =>
      line.includes(
        'GitHub "pull_request_review_comment" event type is not mapped',
      ),
    ),
  )
  console.log(
    'PASS an unmapped inline-comment delivery logs one debug line and wakes nobody',
  )

  model.push(
    fauxToolCall('subscriptions', {
      action: 'create',
      source: 'github',
      key: 'github:owner/repo#issues',
    }),
    fauxText('Subscribed to fixture issue feed'),
    fauxText('Fixture PR comment handled'),
  )
  fake.deliver(
    larkEvent({
      content: '{"text":"@_user_1 Subscribe this group to the issue feed"}',
    }),
  )
  await until('issue feed subscribed', () =>
    fake.sent.some((m) => m.text === 'Subscribed to fixture issue feed'),
  )
  const feedCalls = model.calls.length
  const feedSent = fake.sent.length
  const silentIssues = [
    [issueBody('opened', []), 'issues', 'issue-opened'],
    [
      issueBody('opened', [{ name: 'to:vela' }]),
      'issues',
      'issue-opened-labeled',
    ],
    [issueBody('closed', [{ name: 'to:vela' }]), 'issues', 'issue-closed'],
    [
      issueBody('labeled', [{ name: 'to:vela' }], {
        label: { name: 'to:vela' },
      }),
      'issues',
      'issue-labeled',
    ],
    [issueNote('Ordinary issue comment', []), 'issue_comment', 'issue-comment'],
    [
      issueNote('Labeled issue comment', [{ name: 'to:vela' }]),
      'issue_comment',
      'issue-comment-labeled',
    ],
  ] as const
  for (const [payload, event, id] of silentIssues)
    assert.equal((await send(payload, event, id)).status, 202)
  await runtime.waitForIdle()
  assert.equal(model.calls.length, feedCalls)
  assert.equal(fake.sent.length, feedSent)
  assert.equal(
    (await send(comment('PR feedback'), 'issue_comment', 'pr-comment')).status,
    202,
  )
  await until('pr comment reply', () =>
    lastTopicOrSent(fake).has('Fixture PR comment handled', 'root'),
  )
  assert.equal(model.calls.length, feedCalls + 1)
  assert(model.calls.at(-1)!.lastUserText.includes('github:owner/repo#pr/171'))
  console.log(
    'PASS omitted issueLabels accepts Issue events with 202 and no model turn; a PR comment stays in its topic',
  )
  await proveIssueLabelAllowlist([], 'empty')
  await proveIssueLabelAllowlist(['to:vela'], 'allow')
  await proveIssueLabelAllowlist({ all: ['to:vela', 'status:ready'] }, 'all')

  model.push(fauxText('Fixture closure handled'))
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
    (await runtime.subscriptions.list()).map((record) => record.eventKey),
    ['github:owner/repo#issues'],
  )
  await until('closure reply', () =>
    lastTopicOrSent(fake).has('Fixture closure handled', 'root'),
  )
  console.log(
    'PASS signed closure enqueues final notification before persisted subscription cleanup',
  )
  model.push(
    fauxToolCall('subscriptions', {
      action: 'create',
      source: 'sentry',
      key: 'sentry:project',
    }),
    fauxText('Subscribed to fixture alert'),
    fauxText('Fixture generic alert handled'),
  )
  fake.deliver(
    larkEvent({
      message_id: 'generic-human',
      root_id: 'root',
      thread_id: 'thread_root',
      content: '{"text":"@_user_1 Subscribe to fixture alert"}',
    }),
  )
  await until('alert subscribed', () =>
    lastTopicOrSent(fake).has('Subscribed to fixture alert', 'generic-human'),
  )
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
  await until('generic alert handled', () =>
    lastTopicOrSent(fake).has('Fixture generic alert handled'),
  )
  const alertCalls = model.calls.length
  assert(model.calls.at(-1)!.lastUserText.includes('untrusted external data'))
  assert.equal((await postAlert(alert, 'suite-1')).status, 202)
  await runtime.waitForIdle()
  assert.equal(model.calls.length, alertCalls)
  const remaining = await runtime.subscriptions.list()
  assert.deepEqual(
    remaining.map((record) => record.eventKey),
    ['github:owner/repo#issues'],
  )
  console.log(
    'PASS generic openssl+curl HMAC/namespace/queue/final cleanup; same delivery ID isolated from GitHub, duplicate ignored',
  )

  model.push(
    fauxToolCall('subscriptions', { action: 'list' }),
    fauxText('Listed fixture feed'),
    fauxToolCall('subscriptions', {
      action: 'remove',
      id: remaining[0]!.id,
    }),
    fauxText('Removed fixture feed'),
  )
  fake.deliver(
    larkEvent({ content: '{"text":"@_user_1 List the issue feed"}' }),
  )
  await until('listed feed', () =>
    fake.sent.some((m) => m.text === 'Listed fixture feed'),
  )
  assert(
    model.calls
      .at(-1)!
      .toolResults.at(-1)!
      .output.includes('github:owner/repo#issues'),
  )
  fake.deliver(
    larkEvent({ content: '{"text":"@_user_1 Remove the issue feed"}' }),
  )
  await until('removed feed', () =>
    fake.sent.some((m) => m.text === 'Removed fixture feed'),
  )
  assert.deepEqual(await runtime.subscriptions.list(), [])
  console.log(
    'PASS the group lists and removes its own repository feed subscription',
  )
} finally {
  await receiver.stop()
  await host.stop()
  await runtime.dispose()
}
assert.equal(await fetch(url).catch(() => undefined), undefined)
assert(!logs.join('\n').includes(secret))
assert(!logs.join('\n').includes('generic-fixture-secret'))
console.log(
  'PASS dispose closes HTTP ingress; diagnostics contain no fixture secret',
)
