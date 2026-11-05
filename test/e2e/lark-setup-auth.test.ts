import { expect, test } from 'bun:test'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { larkTransport } from '../../packages/lark/src/transport.ts'

test('setup transport authenticates bot lookup and confirmation message', async () => {
  const original = defaultHttpInstance.defaults.adapter
  const requests: { url: string; authorization: unknown }[] = []
  defaultHttpInstance.defaults.adapter = async (config) => {
    const url = config.url ?? ''
    requests.push({ url, authorization: config.headers.Authorization })
    const data = url.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'fake-setup-token', expire: 7200 }
      : url.includes('/bot/v3/info')
        ? { code: 0, bot: { open_id: 'fake-bot' } }
        : { code: 0, data: { message_id: 'fake-message', create_time: '123' } }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  try {
    const transport = larkTransport('fake-setup-auth-app', 'fake-secret', true)
    await transport.getBotId()
    await transport.send('fake-chat', 'setup complete')
    const bot = requests.find((request) => request.url.includes('/bot/v3/info'))
    const message = requests.find((request) =>
      request.url.includes('/im/v1/messages'),
    )
    expect(bot?.authorization).toBe('Bearer fake-setup-token')
    expect(message?.authorization).toBe('Bearer fake-setup-token')
  } finally {
    defaultHttpInstance.defaults.adapter = original
  }
})
