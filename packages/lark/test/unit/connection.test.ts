import { afterEach, expect, test } from 'bun:test'
import { silentLogger } from '@glows777/vela-core'
import * as sdk from '@larksuiteoapi/node-sdk'
import { LarkChannel } from '../../src/channel.ts'
import { type LarkTransport, larkTransport } from '../../src/transport.ts'

type Connection = { connected: boolean; error?: string }
type Callbacks = {
  onReconnected?: () => void
  onReady?: () => void
  onError?: (error: Error) => void
  onReconnecting?: () => void
}
const originalStart = sdk.WSClient.prototype.start
const originalClose = sdk.WSClient.prototype.close
const originalAdapter = sdk.defaultHttpInstance.defaults.adapter
const originalInfo = console.info
const sockets: Callbacks[] = []
function intercept() {
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
}
afterEach(() => {
  sdk.WSClient.prototype.start = originalStart
  sdk.WSClient.prototype.close = originalClose
  sdk.defaultHttpInstance.defaults.adapter = originalAdapter
  console.info = originalInfo
  sockets.length = 0
})
function channel(transport?: LarkTransport) {
  return new LarkChannel({
    appId: 'connection-test',
    appSecret: 'private-secret',
    owners: [],
    dataDir: '/tmp',
    logger: silentLogger,
    transport,
  })
}

test('real SDK start resolution is not readiness; lifecycle callbacks update and clear safe connection errors', async () => {
  intercept()
  const c = channel()
  const states: Connection[] = []
  const unsubscribe = c.onConnection((value) => states.push(value))
  await c.start()
  expect(states.at(-1)).toEqual({ connected: false })
  const socket = sockets[0]!
  expect(socket.onReady).toBeFunction()
  expect(socket.onError).toBeFunction()
  expect(socket.onReconnecting).toBeFunction()
  socket.onReady!()
  expect(states.at(-1)).toEqual({ connected: true })
  socket.onError!(new Error('private-secret https://provider/?token=private'))
  expect(states.at(-1)).toEqual({
    connected: false,
    error: 'Lark connection failed',
  })
  socket.onReady!()
  expect(states.at(-1)).toEqual({ connected: true })
  socket.onReconnecting!()
  expect(states.at(-1)).toEqual({
    connected: false,
    error: 'Lark connection lost; reconnecting',
  })
  socket.onReconnected!()
  expect(states.at(-1)).toEqual({ connected: true })
  await c.stop()
  expect(states.at(-1)).toEqual({ connected: false })
  const count = states.length
  socket.onReady!()
  socket.onError!(new Error('late'))
  expect(states).toHaveLength(count)
  unsubscribe()
  await c.start()
  expect(states).toHaveLength(count)
  await c.stop()
})

test('callbacks from a replaced real connection cannot change the current connection', async () => {
  intercept()
  const c = channel()
  const states: Connection[] = []
  c.onConnection((value) => states.push(value))
  await c.start()
  const first = sockets[0]!
  await c.start()
  sockets[1]!.onReady!()
  first.onError!(new Error('old connection'))
  first.onReconnecting!()
  expect(states.at(-1)).toEqual({ connected: true })
  await c.stop()
})

test('quiet setup retains ready, error, reconnect callbacks and ignores callbacks after stop', async () => {
  intercept()
  const errors: Error[] = []
  let ready = 0
  const transport = larkTransport(
    'setup-test',
    'secret',
    true,
    (error) => errors.push(error),
    () => ready++,
  )
  await transport.start(
    () => {},
    () => ({ toast: { type: 'info', content: 'ignored' } }),
  )
  const socket = sockets[0]!
  const error = new Error('setup failed')
  socket.onReady!()
  socket.onError!(error)
  socket.onReconnecting!()
  expect(ready).toBe(1)
  expect(errors[0]).toBe(error)
  expect(errors[1]?.message).toBe('Lark connection dropped; retry setup')
  transport.stop()
  socket.onReady!()
  socket.onReconnected!()
  expect(ready).toBe(1)
})

test('custom transports use start success/failure fallback and ignore completion after stop', async () => {
  const transport = {
    getBotId: async () => 'bot',
    start: async () => {},
    stop() {},
  } as unknown as LarkTransport
  const c = channel(transport)
  const states: Connection[] = []
  c.onConnection((value) => states.push(value))
  await c.start()
  expect(states.at(-1)).toEqual({ connected: true })
  transport.start = async () => {
    throw new Error('private-secret')
  }
  await expect(c.start()).rejects.toThrow('private-secret')
  expect(states.at(-1)).toEqual({
    connected: false,
    error: 'Lark connection failed',
  })
  let finish!: () => void
  transport.start = () =>
    new Promise<void>((resolve) => {
      finish = resolve
    })
  const starting = c.start()
  await Promise.resolve()
  await c.stop()
  finish()
  await starting
  expect(states.at(-1)).toEqual({ connected: false })
})
