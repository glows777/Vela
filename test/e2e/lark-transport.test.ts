import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import * as sdk from '@larksuiteoapi/node-sdk'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

// The real Lark transport (`larkTransport`, built by `lark()` from appId / appSecret) and the real
// Lark SDK, with only the network swapped: the SDK's HTTP adapter answers with response bodies in the
// shape of the Open Platform docs, and the long connection hands the SDK's own event dispatcher to
// the test. Every other Lark e2e replaces the whole transport with a fake.

interface Call {
  method: string
  path: string
  params: Record<string, unknown>
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
    }
    calls.push(call)
    for (const route of [...routes, ...defaults]) {
      const data = route(call)
      if (data)
        return { data, status: 200, statusText: 'OK', headers: {}, config }
    }
    throw new Error(`no fake Lark route for ${call.method} ${call.path}`)
  }
  sdk.WSClient.prototype.start = async (params: {
    eventDispatcher: typeof dispatcher
  }) => {
    dispatcher = params.eventDispatcher
  }
  sdk.WSClient.prototype.close = () => {}
})
afterAll(() => {
  console.info = consoleInfo
  sdk.defaultHttpInstance.defaults.adapter = original.adapter
  sdk.WSClient.prototype.start = original.start
  sdk.WSClient.prototype.close = original.close
})
afterEach(async () => {
  await cleanupTestVelas()
  calls.length = 0
  routes = []
  dispatcher = undefined
})

async function start(
  responses: NonNullable<Parameters<typeof createTestVela>[0]>['responses'],
) {
  const t = createTestVela({
    responses,
    extensions: [
      lark({
        appId: APP_ID,
        appSecret: 'secret',
        chats: ['oc_group'],
        owners: ['ou_alice'],
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  return t
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

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
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
    'POST /open-apis/im/v1/messages/om_in/reactions',
    'GET /open-apis/contact/v3/users/ou_alice',
    'GET /open-apis/im/v1/messages',
    'POST /open-apis/im/v1/messages/om_in/reply',
    'DELETE /open-apis/im/v1/messages/om_in/reactions/r_OnIt',
    'POST /open-apis/im/v1/messages/om_in/reactions',
  ])
  // History before the question: list takes seconds, newest first
  expect(calls[4]!.params).toEqual({
    container_id_type: 'chat',
    container_id: 'oc_group',
    sort_type: 'ByCreateTimeDesc',
    page_size: 50,
    end_time: String(Math.floor(sent / 1000) + 1),
  })
  expect(calls[3]!.params).toEqual({ user_id_type: 'open_id' })
  // The parsed event, history item and user name reach the model
  const input = t.model.calls[0]!.lastUserText
  expect(input).toContain('why?')
  expect(input).toContain('the build is red again')
  expect(input).toContain('Alice')
  expect(calls[5]!.body).toEqual({
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
    fauxToolCall('lark_start_topic', {
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
    msg_type: 'text',
    content: JSON.stringify({ text: 'Check cobalt' }),
    reply_in_thread: true,
  })
  // The topic's control card and answer reply to the topic message the API returned
  const topicPosts = calls.filter(
    (c) => c.path === '/open-apis/im/v1/messages/om_topic/reply',
  )
  expect(topicPosts.map((c) => c.body.msg_type)).toEqual([
    'interactive',
    'text',
  ])
  expect(JSON.parse(topicPosts[1]!.body.content as string).text).toContain(
    'topic answer',
  )
  // The card is updated in place through its returned message ID
  const patch = calls.find((c) => c.method === 'PATCH')!
  expect(patch.path).toBe('/open-apis/im/v1/messages/om_reply')
  expect(JSON.parse(patch.body.content as string).header.title.content).toBe(
    'Finished',
  )
})

test('a Lark error code is reported with its code and message, not treated as success', async () => {
  // https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code: HTTP 200 with a nonzero code
  routes = [
    (c) =>
      c.path === '/open-apis/im/v1/messages/om_in/reply' && {
        code: 230002,
        msg: 'Bot/User can NOT be out of the chat.',
      },
  ]
  const t = await start([fauxText('answer')])
  await receive({})
  await until(() => t.eventsOf('channel_error').length > 0)
  expect(String(t.eventsOf('channel_error')[0]!.error)).toContain(
    'Lark 230002: Bot/User can NOT be out of the chat.',
  )
  // The failed reply is not marked as done
  await until(() => reactions().length === 2)
  expect(reactions()).toEqual(['OnIt', 'CrossMark'])
})
