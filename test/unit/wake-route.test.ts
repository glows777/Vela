import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

const FORGE_ID =
  'v1/acme%2Fvela/forge/issues/labeled/1284/l/to%3Aforge@2026-10-26T15:04:05Z'

type Plan = {
  posts: Array<{
    sink: string
    route: string
    deliveryId: string
    bucket: number
    body: Record<string, unknown>
  }>
  skips: Array<{
    code: string
    route?: string
    deliveryId?: string
    detail?: string
  }>
}

function run(
  eventName: string,
  payload: unknown,
  state?: string,
): { status: number; plan: Plan } {
  const dir = mkdtempSync(join(tmpdir(), 'wake-route-'))
  const eventPath = join(dir, 'event.json')
  writeFileSync(eventPath, JSON.stringify(payload))
  const statePath = state === undefined ? undefined : join(dir, 'buckets.json')
  if (statePath !== undefined && state !== undefined)
    writeFileSync(statePath, state)
  const env = {
    ...process.env,
    WAKE_EVENT_NAME: eventName,
    WAKE_EVENT_PATH: eventPath,
    ...(statePath ? { WAKE_STATE_PATH: statePath } : {}),
  }
  const result = spawnSync(process.execPath, ['.github/wake/decide.mjs'], {
    env,
    encoding: 'utf8',
  })
  const stdout = result.stdout ?? ''
  return {
    status: result.status ?? 1,
    plan: stdout.trim()
      ? (JSON.parse(stdout) as Plan)
      : { posts: [], skips: [] },
  }
}

function issue(options?: {
  action?: string
  labels?: string[]
  added?: string
  sender?: string
  state?: string
  updatedAt?: string
  assignee?: string
  title?: string
}) {
  const labels = options?.labels ?? ['to:forge']
  const action = options?.action ?? 'labeled'
  return {
    action,
    repository: { full_name: 'acme/vela' },
    sender: options?.sender ? { login: options.sender } : { login: 'liam' },
    label:
      action === 'labeled' ? { name: options?.added ?? labels[0] } : undefined,
    assignee: options?.assignee ? { login: options.assignee } : undefined,
    issue: {
      number: 1284,
      title: options?.title ?? 'Debounce wake posts',
      html_url: 'https://github.com/acme/vela/issues/1284',
      labels: labels.map((name) => ({ name })),
      state: options?.state ?? 'open',
      updated_at: options?.updatedAt ?? '2026-10-26T15:04:05Z',
    },
  }
}

function pull(options?: {
  action?: string
  labels?: string[]
  merged?: boolean
  state?: string
  updatedAt?: string
  sha?: string
  added?: string
}) {
  const labels = options?.labels ?? []
  const action = options?.action ?? 'opened'
  return {
    action,
    repository: { full_name: 'acme/vela' },
    sender: { login: 'liam' },
    label:
      action === 'labeled' ? { name: options?.added ?? labels[0] } : undefined,
    pull_request: {
      number: 90,
      title: 'Review the filter',
      html_url: 'https://github.com/acme/vela/pull/90',
      labels: labels.map((name) => ({ name })),
      state: options?.state ?? 'open',
      merged: options?.merged ?? false,
      updated_at: options?.updatedAt ?? '2026-10-26T15:04:05Z',
      head: { sha: options?.sha ?? 'abc123' },
    },
  }
}

test('label to:forge posts one Grok body with a stable delivery id', () => {
  const first = run('issues', issue())
  const second = run('issues', issue())
  expect(first.status).toBe(0)
  expect(first.plan.posts).toHaveLength(1)
  expect(first.plan.posts[0]).toMatchObject({
    sink: 'grok',
    route: 'forge',
    deliveryId: FORGE_ID,
  })
  expect(first.plan.posts[0]?.body).toEqual({
    delivery_id: FORGE_ID,
    event: 'issues',
    action: 'labeled',
    number: 1284,
    title: 'Debounce wake posts',
    html_url: 'https://github.com/acme/vela/issues/1284',
    labels: ['to:forge'],
    actor_login: 'liam',
    route: 'forge',
    reason: 'label:to:forge',
  })
  expect(second.plan.posts[0]?.deliveryId).toBe(FORGE_ID)
})

test('Forge and to:forge together post one forge wake', () => {
  const { plan } = run(
    'issues',
    issue({ labels: ['Forge', 'to:forge'], added: 'Forge' }),
  )
  expect(plan.posts.map((post) => post.route)).toEqual(['forge'])
  expect(plan.posts[0]?.body.reason).toBe('label:to:forge')
})

test('Taste posts route taste on the Grok sink', () => {
  const { plan } = run('issues', issue({ labels: ['Taste'], added: 'Taste' }))
  expect(plan.posts[0]).toMatchObject({ sink: 'grok', route: 'taste' })
  expect(plan.posts[0]?.body.route).toBe('taste')
})

test('to:forge and Taste post two bodies with different ids', () => {
  const { plan } = run(
    'issues',
    issue({ labels: ['to:forge', 'Taste'], added: 'Taste' }),
  )
  expect(plan.posts.map((post) => post.route)).toEqual(['forge', 'taste'])
  expect(plan.posts[0]?.deliveryId).not.toBe(plan.posts[1]?.deliveryId)
})

test('to:vela posts a Feishu text summary and not the Grok object', () => {
  const { plan } = run(
    'issues',
    issue({ labels: ['to:vela'], added: 'to:vela' }),
  )
  const body = plan.posts[0]?.body
  expect(plan.posts[0]).toMatchObject({ sink: 'feishu', route: 'vela' })
  expect(Object.keys(body ?? {}).sort()).toEqual(['content', 'msg_type'])
  expect(body).toEqual({
    msg_type: 'text',
    content: {
      text: [
        'Look at #1284',
        'Debounce wake posts',
        'https://github.com/acme/vela/issues/1284',
        `delivery_id: ${plan.posts[0]?.deliveryId}`,
      ].join('\n'),
    },
  })
})

test('a bare bug label wakes nobody', () => {
  const { plan } = run('issues', issue({ labels: ['bug'], added: 'bug' }))
  expect(plan.posts).toHaveLength(0)
  expect(plan.skips[0]?.code).toBe('no-route')
})

test('adding bug while to:forge is present still wakes forge for the forge label', () => {
  const { plan } = run(
    'issues',
    issue({ labels: ['to:forge', 'bug'], added: 'bug' }),
  )
  expect(plan.posts).toHaveLength(1)
  expect(plan.posts[0]?.body.reason).toBe('label:to:forge')
  expect(plan.posts[0]?.deliveryId).not.toBe(FORGE_ID)
})

test('bot actors drop', () => {
  for (const sender of [
    'some-app[bot]',
    'dependabot',
    'cursoragent',
    'chatgpt-codex',
    'chatgpt-codex-connector',
    'claude-code',
  ]) {
    const { plan } = run('issues', issue({ sender }))
    expect(plan.posts).toHaveLength(0)
    expect(plan.skips[0]?.code).toBe('bot')
  }
})

test('a closed issue and a merged pull request drop', () => {
  expect(run('issues', issue({ state: 'closed' })).plan.skips[0]?.code).toBe(
    'closed',
  )
  expect(
    run(
      'pull_request',
      pull({ merged: true, state: 'closed', labels: ['Forge'] }),
    ).plan.skips[0]?.code,
  ).toBe('closed')
})

test('a submitted review wakes only when a route label is present', () => {
  const bare = run('pull_request_review', {
    action: 'submitted',
    repository: { full_name: 'acme/vela' },
    sender: { login: 'liam' },
    review: { id: 9, submitted_at: '2026-10-26T15:04:05Z' },
    pull_request: {
      number: 90,
      title: 'Review the filter',
      html_url: 'https://github.com/acme/vela/pull/90',
      labels: [],
      state: 'open',
      merged: false,
      updated_at: '2026-10-26T15:04:05Z',
    },
  })
  expect(bare.plan.posts).toHaveLength(0)
  expect(bare.plan.skips[0]?.code).toBe('no-route')

  const taste = run('pull_request_review', {
    action: 'submitted',
    repository: { full_name: 'acme/vela' },
    sender: { login: 'liam' },
    review: { id: 9, submitted_at: '2026-10-26T15:04:05Z', body: 'to:forge' },
    pull_request: {
      number: 90,
      title: 'Review the filter',
      html_url: 'https://github.com/acme/vela/pull/90',
      labels: [{ name: 'Taste' }],
      state: 'open',
      merged: false,
      updated_at: '2026-10-26T15:04:05Z',
    },
  })
  expect(taste.plan.posts[0]).toMatchObject({ route: 'taste', sink: 'grok' })
  expect(taste.plan.posts[0]?.body.reason).toBe('review')
})

test('comment tokens match whole words only', () => {
  const hit = run('issue_comment', {
    action: 'created',
    repository: { full_name: 'acme/vela' },
    sender: { login: 'liam' },
    issue: {
      number: 90,
      title: 'Review the filter',
      html_url: 'https://github.com/acme/vela/pull/90',
      labels: [],
      state: 'open',
      updated_at: '2026-10-26T15:04:05Z',
    },
    comment: {
      id: 555,
      body: 'please to:forge.',
      created_at: '2026-10-26T15:04:05Z',
    },
  })
  expect(hit.plan.posts[0]?.body.reason).toBe('token:to:forge')

  for (const body of [
    'to:forget',
    'Tastes',
    'notto:forge',
    'Tasteful',
    'email@forge.com',
    'to:forge-bot',
  ]) {
    const miss = run('issue_comment', {
      action: 'created',
      repository: { full_name: 'acme/vela' },
      sender: { login: 'liam' },
      issue: {
        number: 90,
        title: 'Review the filter',
        html_url: 'https://github.com/acme/vela/pull/90',
        labels: ['Forge'],
        state: 'open',
        updated_at: '2026-10-26T15:04:05Z',
      },
      comment: { id: 556, body, created_at: '2026-10-26T15:04:05Z' },
    })
    expect(miss.plan.posts).toHaveLength(0)
  }
})

test('a comment token does not also wake labels on the thread', () => {
  const { plan } = run('issue_comment', {
    action: 'created',
    repository: { full_name: 'acme/vela' },
    sender: { login: 'liam' },
    issue: {
      number: 90,
      title: 'Review the filter',
      html_url: 'https://github.com/acme/vela/pull/90',
      labels: [{ name: 'Forge' }],
      state: 'open',
      updated_at: '2026-10-26T15:04:05Z',
    },
    comment: { id: 555, body: '@vela', created_at: '2026-10-26T15:04:05Z' },
  })
  expect(plan.posts.map((post) => post.route)).toEqual(['vela'])
})

test('one comment can wake forge and vela from two tokens', () => {
  const { plan } = run('issue_comment', {
    action: 'created',
    repository: { full_name: 'acme/vela' },
    sender: { login: 'liam' },
    issue: {
      number: 90,
      title: 'Review the filter',
      html_url: 'https://github.com/acme/vela/pull/90',
      labels: [],
      state: 'open',
      updated_at: '2026-10-26T15:04:05Z',
    },
    comment: {
      id: 555,
      body: 'hand this to @forge and to:vela',
      created_at: '2026-10-26T15:04:05Z',
    },
  })
  expect(plan.posts.map((post) => post.route)).toEqual(['forge', 'vela'])
})

test('assigned wakes only when a route label is already present', () => {
  const bare = run(
    'issues',
    issue({ action: 'assigned', labels: [], assignee: 'liam' }),
  )
  expect(bare.plan.posts).toHaveLength(0)
  expect(bare.plan.skips[0]?.code).toBe('no-route')
  const vela = run(
    'issues',
    issue({ action: 'assigned', labels: ['to:vela'], assignee: 'liam' }),
  )
  expect(vela.plan.posts[0]).toMatchObject({ route: 'vela', sink: 'feishu' })
  const forge = run(
    'issues',
    issue({ action: 'assigned', labels: ['to:forge'], assignee: 'liam' }),
  )
  expect(forge.plan.posts[0]?.body.reason).toBe('assigned')
})

test('unlabeled, edited, and review_requested do not wake', () => {
  for (const [eventName, action] of [
    ['issues', 'unlabeled'],
    ['issue_comment', 'edited'],
    ['pull_request', 'review_requested'],
  ] as const) {
    const { status, plan } = run(eventName, { ...issue(), action })
    expect(status).toBe(0)
    expect(plan.posts).toHaveLength(0)
    expect(plan.skips[0]?.code).toBe('unhandled-event')
  }
})

test('a later event in the same 90 second bucket is skipped and the next bucket posts', () => {
  const first = run('issues', issue({ updatedAt: '2026-10-26T15:03:01Z' }))
  const bucket = first.plan.posts[0]?.bucket
  expect(bucket).toBeTypeOf('number')
  const held = run(
    'issues',
    issue({ updatedAt: '2026-10-26T15:04:28Z' }),
    JSON.stringify({ forge: bucket }),
  )
  expect(held.plan.posts).toHaveLength(0)
  expect(
    held.plan.skips.some(
      (skip) => skip.code === 'debounced' && skip.route === 'forge',
    ),
  ).toBe(true)
  const boundary = run(
    'issues',
    issue({ updatedAt: '2026-10-26T15:04:29Z' }),
    JSON.stringify({ forge: bucket }),
  )
  expect(boundary.plan.posts).toHaveLength(0)
  const next = run(
    'issues',
    issue({ updatedAt: '2026-10-26T15:04:30Z' }),
    JSON.stringify({ forge: bucket }),
  )
  expect(next.plan.posts).toHaveLength(1)
  expect(next.plan.posts[0]?.bucket).not.toBe(bucket)
})

test('a new route in the same bucket still posts when an older route is debounced', () => {
  const first = run('issues', issue({ updatedAt: '2026-10-26T15:03:01Z' }))
  const bucket = first.plan.posts[0]?.bucket
  const added = run(
    'issues',
    issue({
      labels: ['to:forge', 'to:vela'],
      added: 'to:vela',
      updatedAt: '2026-10-26T15:04:28Z',
    }),
    JSON.stringify({ forge: bucket }),
  )
  expect(added.plan.posts.map((post) => post.route)).toEqual(['vela'])
  expect(
    added.plan.skips.some(
      (skip) => skip.route === 'forge' && skip.code === 'debounced',
    ),
  ).toBe(true)
})

test('a missing state file posts, and a corrupt state file sends nothing', () => {
  const missing = run('issues', issue())
  expect(missing.status).toBe(0)
  expect(missing.plan.posts).toHaveLength(1)
  const corrupt = run('issues', issue(), 'not-json')
  expect(corrupt.status).toBe(1)
  expect(corrupt.plan.posts).toHaveLength(0)
  expect(corrupt.plan.skips[0]?.code).toBe('state-unreadable')
})

test('the workflow listens only to the route events and cannot comment', () => {
  const text = Bun.file('.github/workflows/wake-route.yml').text()
  return text.then((source) => {
    const doc = parse(source) as {
      on: Record<string, { types: string[] }>
      permissions: Record<string, string>
      concurrency: { 'cancel-in-progress': boolean }
    }
    expect(doc.on).toEqual({
      issues: { types: ['labeled', 'assigned'] },
      pull_request: {
        types: [
          'opened',
          'ready_for_review',
          'reopened',
          'synchronize',
          'labeled',
        ],
      },
      pull_request_review: { types: ['submitted'] },
      issue_comment: { types: ['created'] },
      pull_request_review_comment: { types: ['created'] },
    })
    expect(doc.permissions).toEqual({ contents: 'read', actions: 'write' })
    expect(doc.concurrency['cancel-in-progress']).toBe(false)
    expect(source).not.toContain('pull_request_target')
    expect(source).not.toContain('github-script')
    expect(source).not.toContain('issues: write')
    expect(source).not.toContain('pull-requests: write')
    expect(source).not.toContain('unlabeled')
    expect(source).not.toContain('review_requested')
  })
})

test('an ordinary comment after a queued Forge mention preserves the wake', async () => {
  const doc = parse(await Bun.file('.github/workflows/wake-route.yml').text())
  // Model GitHub's documented pending queue while the first comment run is held.
  // single replaces the pending run; max retains up to 100 pending runs.
  const pending: string[] = []
  for (const body of ['@forge', 'thanks']) {
    if (doc.concurrency.queue !== 'max') pending.pop()
    pending.push(body)
  }
  const routes = pending.flatMap((body, index) =>
    run('issue_comment', {
      ...issue({ labels: [] }),
      action: 'created',
      comment: { id: 555 + index, body, created_at: '2026-10-26T15:04:05Z' },
    }).plan.posts.map((post) => post.route),
  )
  expect(routes).toEqual(['forge'])
})
