import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLarkChannelAdapter,
  createRuntime,
  type LocalVelaRuntime,
} from '@glows777/vela'
import * as sdk from '@larksuiteoapi/node-sdk'
import { DaemonLarkHost } from '../../packages/vela/src/daemon/lark-host.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'

// The real Lark transport (`larkTransport`, built by `lark()` from appId / appSecret) and the real
// Lark SDK, with only the network swapped: the SDK's HTTP adapter answers with response bodies in the
// shape of the Open Platform docs, and the long connection hands the SDK's own event dispatcher to
// the test. Every other Lark e2e replaces the whole transport with a fake.

interface Call {
  method: string
  path: string
  params: Record<string, unknown>
  multipart?: Buffer
  body: Record<string, unknown>
}
type Route = (call: Call) => unknown

const APP_ID = 'cli_0123456789abcdef'
const calls: Call[] = []
let routes: Route[] = []
let dispatcher:
  | {
      invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown>
    }
  | undefined
/** Fires the SDK's own ready callback for tests that need a connected channel. */
let ready: ((client: { onReady?: () => void }) => void) | undefined
/** The long-connection stub: it never opens a socket, only hands over the dispatcher. */
const connectStub = async function (
  this: { onReady?: () => void },
  params: { eventDispatcher: typeof dispatcher },
) {
  dispatcher = params.eventDispatcher
  ready?.(this)
}
const original = {
  adapter: sdk.defaultHttpInstance.defaults.adapter,
  start: sdk.WSClient.prototype.start,
  close: sdk.WSClient.prototype.close,
}

const ok = (data: unknown) => ({ code: 0, msg: 'success', data })
// https://open.feishu.cn/document/server-docs/im-v1/message/reply (and create / forward): the message object
const sentMessage = (id: string, extra: Record<string, unknown> = {}) =>
  ok({
    message_id: id,
    root_id: '',
    parent_id: '',
    thread_id: '',
    msg_type: 'text',
    create_time: '1700000001000',
    update_time: '1700000001000',
    deleted: false,
    updated: false,
    chat_id: 'oc_group',
    sender: {
      id: APP_ID,
      id_type: 'app_id',
      sender_type: 'app',
      tenant_key: 'tk',
    },
    body: { content: '{"text":"…"}' },
    ...extra,
  })

/** Answers documented by the Open Platform; a test puts its own routes first. */
const defaults: Route[] = [
  // https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
  (c) =>
    c.path === '/open-apis/auth/v3/tenant_access_token/internal' && {
      code: 0,
      msg: 'ok',
      tenant_access_token: 't-test',
      expire: 7200,
    },
  // https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info
  (c) =>
    c.path === '/open-apis/bot/v3/info' && {
      code: 0,
      msg: 'ok',
      bot: { activate_status: 2, app_name: 'Vela', open_id: 'ou_bot' },
    },
  // https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
  (c) =>
    c.method === 'POST' &&
    c.path.endsWith('/reactions') &&
    ok({
      reaction_id: `r_${(c.body.reaction_type as { emoji_type: string }).emoji_type}`,
      operator: { operator_id: APP_ID, operator_type: 'app' },
      action_time: '1700000001000',
      reaction_type: c.body.reaction_type,
    }),
  (c) => c.method === 'DELETE' && c.path.includes('/reactions/') && ok({}),
  // https://open.feishu.cn/document/server-docs/contact-v3/user/get
  (c) =>
    c.path === '/open-apis/contact/v3/users/ou_alice' &&
    ok({ user: { open_id: 'ou_alice', name: 'Alice' } }),
  // https://open.feishu.cn/document/server-docs/im-v1/message/list
  (c) =>
    c.method === 'GET' &&
    c.path === '/open-apis/im/v1/messages' &&
    ok({ has_more: false, page_token: '', items: [] }),
  (c) => c.path.endsWith('/reply') && sentMessage('om_reply'),
  (c) =>
    c.method === 'POST' &&
    c.path === '/open-apis/im/v1/messages' &&
    sentMessage('om_sent'),
  // https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
  (c) => c.method === 'PATCH' && ok({}),
]

// The SDK logs "client ready" with console.info; keep test output clean
const consoleInfo = console.info
beforeAll(() => {
  console.info = () => {}
  sdk.defaultHttpInstance.defaults.adapter = async (config) => {
    const url = new URL(config.url ?? '', 'https://open.feishu.cn')
    const call: Call = {
      method: (config.method ?? 'get').toUpperCase(),
      path: url.pathname,
      params: { ...config.params },
      body: typeof config.data === 'string' ? JSON.parse(config.data) : {},
      multipart: config.data?.getBuffer?.(),
    }
    calls.push(call)
    for (const route of [...routes, ...defaults]) {
      const data = route(call)
      if (data)
        return { data, status: 200, statusText: 'OK', headers: {}, config }
    }
    throw new Error(`no fake Lark route for ${call.method} ${call.path}`)
  }
  sdk.WSClient.prototype.start = connectStub
  sdk.WSClient.prototype.close = () => {}
})
afterAll(() => {
  console.info = consoleInfo
  sdk.defaultHttpInstance.defaults.adapter = original.adapter
  sdk.WSClient.prototype.start = original.start
  sdk.WSClient.prototype.close = original.close
})
const dirs: string[] = []
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) {
    await dispose().catch(() => {})
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  calls.length = 0
  routes = []
  dispatcher = undefined
  ready = undefined
})

async function start(
  responses: NonNullable<Parameters<typeof createFauxModel>[0]>['responses'],
) {
  const agentDir = mkdtempSync(join(tmpdir(), 'vela-lark-tx-'))
  dirs.push(agentDir)
  const model = createFauxModel({ responses })
  const runtime: LocalVelaRuntime = createRuntime({
    agentDir,
    defaultModel: model,
    hostEnv: {},
    mcp: false,
  })
  const host = new DaemonLarkHost(runtime, {
    agentDir,
    hostEnv: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  disposers.push(async () => {
    await host.stop()
    await runtime.dispose()
  })
  await runtime.ready()
  await host.sync(
    {
      lark: {
        appId: APP_ID,
        appSecret: 'secret',
        chats: ['oc_group'],
        owners: ['ou_alice'],
      },
    },
    true,
  )
  const rootBinding = (await runtime.bindings.list({ channel: 'lark' })).find(
    (b) => b.externalId === 'oc_group' && !b.threadId,
  )
  const project = rootBinding?.projectId
    ? await runtime.projects.get(rootBinding.projectId)
    : undefined
  return {
    agentDir,
    runtime,
    host,
    model,
    groupSessionId: project!.hubSessionId!,
  }
}

// https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
function receive(message: Record<string, unknown>) {
  const now = String(Date.now())
  return dispatcher!.invoke(
    {
      schema: '2.0',
      header: {
        event_id: crypto.randomUUID(),
        event_type: 'im.message.receive_v1',
        create_time: now,
        token: '',
        app_id: APP_ID,
        tenant_key: 'tk',
      },
      event: {
        sender: {
          sender_id: {
            open_id: 'ou_alice',
            union_id: 'on_alice',
            user_id: null,
          },
          sender_type: 'user',
          tenant_key: 'tk',
        },
        message: {
          message_id: 'om_in',
          root_id: '',
          parent_id: '',
          create_time: now,
          update_time: now,
          chat_id: 'oc_group',
          thread_id: '',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 hello' }),
          mentions: [
            {
              key: '@_user_1',
              id: { open_id: 'ou_bot', union_id: 'on_bot', user_id: null },
              name: 'Vela',
              tenant_key: 'tk',
            },
          ],
          user_agent: '',
          ...message,
        },
      },
    },
    { needCheck: false },
  )
}

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(
        `timed out; Lark calls: ${calls.map((c) => `${c.method} ${c.path}`).join(', ')}`,
      )
    await Bun.sleep(2)
  }
}

const shape = () => calls.map((c) => `${c.method} ${c.path}`)
const reactions = () =>
  calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/reactions'))
    .map((c) => (c.body.reaction_type as { emoji_type: string }).emoji_type)

test('a group @ goes through the real SDK: documented event in, documented requests out, the answer replied', async () => {
  const sent = Date.now()
  // https://open.feishu.cn/document/server-docs/im-v1/message/list: a history item, newest first
  routes = [
    (c) =>
      c.method === 'GET' &&
      c.path === '/open-apis/im/v1/messages' &&
      ok({
        has_more: false,
        page_token: '',
        items: [
          {
            message_id: 'om_old',
            root_id: '',
            parent_id: '',
            thread_id: '',
            msg_type: 'text',
            create_time: String(sent - 60_000),
            update_time: String(sent - 60_000),
            deleted: false,
            updated: false,
            chat_id: 'oc_group',
            sender: {
              id: 'ou_alice',
              id_type: 'open_id',
              sender_type: 'user',
              tenant_key: 'tk',
            },
            body: {
              content: JSON.stringify({ text: 'the build is red again' }),
            },
            mentions: [],
          },
        ],
      }),
  ]
  const t = await start([fauxText('answer')])
  await receive({
    create_time: String(sent),
    content: JSON.stringify({ text: '@_user_1 why?' }),
  })
  await until(() => reactions().includes('DONE'))

  expect(shape()).toEqual([
    'POST /open-apis/auth/v3/tenant_access_token/internal',
    'GET /open-apis/bot/v3/info',
    'GET /open-apis/contact/v3/users/ou_alice',
    'GET /open-apis/im/v1/messages',
    'POST /open-apis/im/v1/messages/om_in/reactions',
    'POST /open-apis/im/v1/messages/om_in/reply',
    'DELETE /open-apis/im/v1/messages/om_in/reactions/r_OnIt',
    'POST /open-apis/im/v1/messages/om_in/reactions',
  ])
  // History before the question: list takes seconds, newest first
  expect(calls[3]!.params).toEqual({
    container_id_type: 'chat',
    container_id: 'oc_group',
    sort_type: 'ByCreateTimeDesc',
    page_size: 50,
    end_time: String(Math.floor(sent / 1000) + 1),
  })
  expect(calls[2]!.params).toEqual({ user_id_type: 'open_id' })
  // The parsed event, history item and user name reach the model
  const input = t.model.calls[0]!.lastUserText
  expect(input).toContain('why?')
  expect(input).toContain('the build is red again')
  expect(input).toContain('Alice')
  expect(calls[5]!.body).toEqual({
    uuid: expect.stringMatching(/^[0-9a-f-]+:reply$/),
    msg_type: 'text',
    content: JSON.stringify({ text: 'answer' }),
  })
})

test('a topic handoff replies in thread and later posts go to the returned topic message', async () => {
  routes = [
    (c) =>
      c.path === '/open-apis/im/v1/messages/om_in/reply' &&
      c.body.reply_in_thread === true &&
      sentMessage('om_topic', {
        root_id: 'om_in',
        parent_id: 'om_in',
        thread_id: 'omt_topic',
      }),
  ]
  await start([
    fauxToolCall('session_start', {
      title: 'Check cobalt',
      brief: 'Check cobalt prices',
    }),
    fauxText('handed off'),
    fauxText('topic answer'),
  ])
  await receive({
    content: JSON.stringify({ text: '@_user_1 investigate cobalt' }),
  })
  await until(() => reactions().includes('DONE'))

  const handoff = calls.find((c) => c.body.reply_in_thread)!
  expect(handoff.path).toBe('/open-apis/im/v1/messages/om_in/reply')
  expect(handoff.body).toEqual({
    uuid: expect.stringMatching(/^[0-9a-f-]+:topic$/),
    msg_type: 'text',
    content: JSON.stringify({ text: 'Check cobalt' }),
    reply_in_thread: true,
  })
  // The topic handoff answer replies in thread using the resolved root message ID
  const topicPosts = calls.filter(
    (c) =>
      c !== handoff &&
      c.path === '/open-apis/im/v1/messages/om_in/reply' &&
      c.body.reply_in_thread === true,
  )
  expect(topicPosts.map((c) => c.body.msg_type)).toEqual(['text'])
  expect(JSON.parse(topicPosts[0]!.body.content as string).text).toContain(
    'topic answer',
  )
})

test(
  'a Lark error code is reported with its code and message, not treated as success',
  async () => {
    // https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code: HTTP 200 with a nonzero code
    routes = [
      (c) =>
        c.path === '/open-apis/im/v1/messages/om_in/reply' && {
          code: 230002,
          msg: 'Bot/User can NOT be out of the chat.',
        },
    ]
    await start([fauxText('answer')])
    await receive({})
    await until(() => reactions().length === 2, 20_000)
    expect(reactions()).toEqual(['OnIt', 'CrossMark'])
  },
  { timeout: 25_000 },
)

test('the typed Lark host uses real SDK history paging and explicit thread replies', async () => {
  sdk.WSClient.prototype.start = async function () {
    ;(this as unknown as { onReady: () => void }).onReady()
  }
  try {
    routes = [
      (c) =>
        c.method === 'GET' &&
        c.path === '/open-apis/im/v1/messages' &&
        c.params.container_id_type === 'chat' &&
        c.params.start_time === '0' &&
        ok(
          c.params.page_token
            ? { has_more: false, items: [] }
            : { has_more: true, page_token: 'next', items: [] },
        ),
      (c) =>
        c.path === '/open-apis/im/v1/messages/om_sent/reply' &&
        c.body.reply_in_thread === true &&
        sentMessage(
          (c.body.content as string).includes('Continue')
            ? 'om_followup'
            : 'om_title',
          { root_id: 'om_sent', thread_id: 'omt_owned' },
        ),
    ]
    const t = await start([
      fauxText('First reply'),
      fauxText('Continued reply'),
    ])
    const chatId = 'oc_group'
    const author = { id: 'desktop-alex', name: 'Alex' }
    const group = await t.runtime.sessions.messages({
      sessionId: t.groupSessionId,
      limit: 1,
    })
    expect(group.nextCursor).toBeDefined()
    await t.runtime.sessions.messages({
      sessionId: t.groupSessionId,
      cursor: group.nextCursor,
    })
    const listings = calls.filter((c) => c.params.start_time === '0')
    expect(listings).toHaveLength(2)
    expect(listings[1]!.params).toEqual({
      ...listings[0]!.params,
      page_token: 'next',
    })
    const opened = await t.runtime.channels.submit('lark', {
      chatId,
      author,
      text: 'Please review',
      newTopic: { title: 'Review' },
    })
    expect(opened.topic).toEqual({ rootId: 'om_sent', threadId: 'omt_owned' })
    await until(() =>
      calls.some(
        (c) =>
          c.path === '/open-apis/im/v1/messages/om_title/reply' &&
          c.body.msg_type === 'text' &&
          String(c.body.content).includes('First reply'),
      ),
    )
    const followup = await t.runtime.channels.submit('lark', {
      chatId,
      author,
      sessionId: opened.sessionId,
      text: 'Continue',
    })
    expect(followup.messageId).toBe('om_followup')
    await until(() =>
      calls.some(
        (c) =>
          c.path === '/open-apis/im/v1/messages/om_followup/reply' &&
          c.body.msg_type === 'text' &&
          String(c.body.content).includes('Continued reply'),
      ),
    )
    expect(calls.find((c) => c.body.receive_id === chatId)?.body.content).toBe(
      '{"text":"Alex: Please review"}',
    )
    expect(
      calls.filter((c) => c.body.reply_in_thread).map((c) => c.body.content),
    ).toEqual(['{"text":"Review"}', '{"text":"Alex: Continue"}'])
    expect(shape()).toContain('POST /open-apis/im/v1/messages/om_title/reply')
    expect(shape()).toContain(
      'POST /open-apis/im/v1/messages/om_followup/reply',
    )
  } finally {
    // Restore this file's connect stub and don't change unrelated test lifetimes.
    sdk.WSClient.prototype.start = connectStub
  }
})

for (const fixture of [
  {
    name: 'report.patch',
    content: Buffer.from('diff'),
    endpoint: 'files',
    msgType: 'file',
    key: 'file_key',
  },
  {
    name: 'plot.png',
    content: Buffer.from('89504e470d0a1a0a', 'hex'),
    endpoint: 'images',
    msgType: 'image',
    key: 'image_key',
  },
]) {
  test(`the SDK uploads ${fixture.name} and replies with its resource key`, async () => {
    const t = await start([
      fauxToolCall('send_file', { path: fixture.name }),
      fauxText('done'),
    ])
    const workspace = join(
      t.agentDir,
      'channels',
      'lark',
      'oc_group',
      'workspace',
    )
    await mkdir(workspace, { recursive: true })
    await writeFile(`${workspace}/${fixture.name}`, fixture.content)
    routes = [
      (c) =>
        c.path === `/open-apis/im/v1/${fixture.endpoint}` &&
        ok({ [fixture.key]: 'uploaded' }),
    ]
    await receive({})
    await until(() => reactions().includes('DONE'))
    const uploads = calls.filter(
      (c) => c.path === `/open-apis/im/v1/${fixture.endpoint}`,
    )
    expect(uploads).toHaveLength(1)
    const form = uploads[0]?.multipart
    expect(form?.includes(fixture.content)).toBe(true)
    if (fixture.msgType === 'image') {
      expect(form?.toString('latin1')).toContain(
        'name="image_type"\r\n\r\nmessage',
      )
    } else {
      expect(form?.toString('latin1')).toContain(
        'name="file_type"\r\n\r\nstream',
      )
      expect(form?.toString('latin1')).toContain(
        'name="file_name"\r\n\r\nreport.patch',
      )
    }
    const posts = calls.filter((c) => c.body.msg_type === fixture.msgType)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      path: '/open-apis/im/v1/messages/om_in/reply',
      body: {
        content: JSON.stringify({ [fixture.key]: 'uploaded' }),
        uuid: expect.any(String),
      },
    })
  })
}

const rejectedFile = {
  code: 230002,
  msg: 'Bot/User can NOT be out of the chat.\nProvider diagnostics.',
  error: { troubleshooting: 'Private request details' },
}
const rejectedReply = 'Lark 230002: Bot/User can NOT be out of the chat.'
const uncertainReply =
  'Lark did not confirm delivery. Check this conversation before asking me to resend.'

for (const [scenario, post, expected] of [
  ['provider rejection', () => rejectedFile, rejectedReply],
  [
    'HTTP rejection with a Feishu code',
    () => {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: rejectedFile },
      })
    },
    rejectedReply,
  ],
  ['missing receipt', () => ok({}), uncertainReply],
  [
    'lost connection',
    () => {
      throw new Error('Connection reset after posting')
    },
    uncertainReply,
  ],
] as const) {
  test(`an attachment post with ${scenario} reports one result without resending`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vela-lark-file-err-'))
    dirs.push(dir)
    const filePath = join(dir, 'report.patch')
    await writeFile(filePath, 'diff')
    const adapter = createLarkChannelAdapter({
      appId: APP_ID,
      appSecret: 'secret',
      chats: ['oc_group'],
      owners: ['ou_alice'],
    })
    disposers.push(() => adapter.stop())
    routes = [
      (c) => c.path.endsWith('/files') && ok({ file_key: 'uploaded' }),
      (c) => c.body.msg_type === 'file' && post(),
    ]
    await adapter.start({
      ingest: async () => {},
    })
    await expect(
      adapter.deliver({
        outboxId: 'ob-file-err',
        kind: 'file',
        channel: 'lark',
        externalChatId: 'oc_group',
        replyToMessageId: 'om_in',
        text: '',
        files: [{ path: filePath, name: 'report.patch' }],
      }),
    ).rejects.toThrow(expected)
    expect(calls.filter((c) => c.path.endsWith('/files'))).toHaveLength(1)
    expect(
      calls.filter((c) => c.body.msg_type === 'file').map((c) => c.path),
    ).toEqual(['/open-apis/im/v1/messages/om_in/reply'])
  })
}

// https://open.feishu.cn/document/server-docs/im-v1/chat/get
test('chats() names the enabled groups from the default transport only', async () => {
  ready = (client) => client.onReady?.()
  const t = await start([])
  routes = [
    (c) =>
      c.path === '/open-apis/im/v1/chats/oc_group' && ok({ name: 'Vela dev' }),
  ]
  expect(await t.runtime.channels.chats('lark')).toEqual([
    { chatId: 'oc_group', name: 'Vela dev' },
  ])
  expect(
    calls.filter((call) => call.path.startsWith('/open-apis/im/v1/chats/')),
  ).toMatchObject([{ method: 'GET', path: '/open-apis/im/v1/chats/oc_group' }])

  // A refused or nameless lookup is display-only: the group stays, without a name.
  routes = [
    (c) =>
      c.path === '/open-apis/im/v1/chats/oc_group' && {
        code: 230002,
        msg: 'bot not in chat',
      },
  ]
  expect(await t.runtime.channels.chats('lark')).toEqual([
    { chatId: 'oc_group' },
  ])
  routes = [(c) => c.path === '/open-apis/im/v1/chats/oc_group' && ok({})]
  expect(await t.runtime.channels.chats('lark')).toEqual([
    { chatId: 'oc_group' },
  ])
})
