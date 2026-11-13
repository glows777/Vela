import { afterEach, expect, test } from 'bun:test'
import { local } from '@glows777/vela-channels'
import { lark } from '@glows777/vela-lark'
import * as sdk from '@larksuiteoapi/node-sdk'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

type Callbacks = {
  onReady?: () => void
  onError?: (error: Error) => void
  onReconnecting?: () => void
  onReconnected?: () => void
}
const originalStart = sdk.WSClient.prototype.start
const originalClose = sdk.WSClient.prototype.close
const originalAdapter = sdk.defaultHttpInstance.defaults.adapter
const originalInfo = console.info

afterEach(async () => {
  await cleanupTestVelas()
  sdk.WSClient.prototype.start = originalStart
  sdk.WSClient.prototype.close = originalClose
  sdk.defaultHttpInstance.defaults.adapter = originalAdapter
  console.info = originalInfo
})

test('public Lark host follows real SDK readiness, sanitized errors and reconnect while Local stays connected', async () => {
  const sockets: Callbacks[] = []
  console.info = () => {}
  sdk.WSClient.prototype.start = async function () {
    sockets.push(this as unknown as Callbacks)
  }
  sdk.WSClient.prototype.close = () => {}
  sdk.defaultHttpInstance.defaults.adapter = async (config) => ({
    data: config.url?.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'test-token', expire: 7200 }
      : { code: 0, bot: { open_id: 'bot' } },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })
  const t = createTestVela({
    extensionConfig: {
      lark: { appId: 'local-host-test', appSecret: 'private-secret' },
    },
    extensions: [lark({ owners: [], chats: [] }), local({ port: 0 })],
  })
  await t.vela.ready()
  const host = t.vela.channel('lark')
  const localHost = t.vela.channel('local')
  const states: ReturnType<typeof host.connection>[] = []
  host.onConnection((state) => states.push(state))
  await t.vela.startChannels()
  expect(host.connection()).toEqual({ connected: false })
  expect(localHost.connection()).toEqual({ connected: true })
  const socket = sockets[0]!
  socket.onReady!()
  expect(host.connection()).toEqual({ connected: true })
  socket.onError!(new Error('private-secret https://provider/?token=private'))
  expect(host.connection()).toEqual({
    connected: false,
    error: 'Lark connection failed',
  })
  expect(JSON.stringify(states)).not.toContain('private-secret')
  socket.onReady!()
  expect(host.connection()).toEqual({ connected: true })
  socket.onReconnecting!()
  expect(host.connection()).toEqual({
    connected: false,
    error: 'Lark connection lost; reconnecting',
  })
  expect(localHost.connection()).toEqual({ connected: true })
  socket.onReconnected!()
  expect(host.connection()).toEqual({ connected: true })
  await t.vela.dispose()
  expect(host.connection()).toEqual({ connected: false })
  expect(localHost.connection()).toEqual({ connected: false })
  const count = states.length
  socket.onReady!()
  socket.onError!(new Error('late error'))
  expect(states).toHaveLength(count)
})
