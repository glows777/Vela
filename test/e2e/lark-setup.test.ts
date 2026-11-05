import { afterEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from '../../packages/vela/src/cli/setup.ts'
import { larkSetup } from '../../packages/vela/src/cli/tui/lark-setup.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function fixture(
  opts: { tokenError?: string; confirm?: boolean; cancel?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'vela-lark-setup-'))
  dirs.push(dir)
  const settings = join(dir, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      defaultModel: 'mock/a',
      extensionConfig: {
        lark: {
          owners: ['owner'],
          chats: [{ id: 'old', tools: ['read_file'] }],
        },
      },
    }),
  )
  const before = readFileSync(settings, 'utf8')
  const notices: string[] = [],
    sent: string[] = []
  let stopped = false
  const host = {
    agentDir: dir,
    input: async (title: string) =>
      opts.cancel ? undefined : title.includes('Secret') ? 'secret' : 'app-id',
    select: async (title: string) =>
      title.includes('Enable')
        ? opts.confirm === false
          ? 'no'
          : 'yes'
        : 'continue',
    addNotice: (message: string) => notices.push(message),
    setSummary: (message: string) => notices.push(message),
    connect: async () => {
      if (opts.tokenError) throw new Error(opts.tokenError)
      return {
        botId: 'bot',
        async waitForMention() {
          return { chatId: 'new', chatName: 'Test group' }
        },
        async send(chatId: string, text: string) {
          sent.push(`${chatId}:${text}`)
        },
        stop() {
          stopped = true
        },
      }
    },
  }
  return { dir, settings, before, notices, sent, host, stopped: () => stopped }
}

test('setup lark is parsed as setup, not as a prompt', () => {
  const args = parseArgs(['setup', 'lark'])
  expect(args.setup).toBe(true)
  expect(args.setupTarget).toBe('lark')
  expect(args.messages).toEqual([])
})

test('failed token or cancelled setup never writes credentials', async () => {
  for (const options of [
    { tokenError: 'Lark 999: invalid credentials' },
    { cancel: true },
    { confirm: false },
  ]) {
    const f = fixture(options)
    await larkSetup(f.host)
    expect(readFileSync(f.settings, 'utf8')).toBe(f.before)
    if (options.tokenError)
      expect(f.notices.join('\n')).toContain('invalid credentials')
  }
})

test('missing-scope errors show the provider detail', async () => {
  const f = fixture({ tokenError: 'missing scopes: im:message:send_as_bot' })
  await larkSetup(f.host)
  expect(f.notices.join('\n')).toContain('im:message:send_as_bot')
  expect(readFileSync(f.settings, 'utf8')).toBe(f.before)
})

test('confirmed group merges settings, protects secrets, sends and closes', async () => {
  const f = fixture()
  expect(await larkSetup(f.host)).toBe(true)
  const config = JSON.parse(readFileSync(f.settings, 'utf8'))
  expect(config.defaultModel).toBe('mock/a')
  expect(config.extensionConfig.lark).toEqual({
    owners: ['owner'],
    chats: [{ id: 'old', tools: ['read_file'] }, 'new'],
    appId: 'app-id',
    appSecret: 'secret',
  })
  expect(statSync(f.settings).mode & 0o777).toBe(0o600)
  expect(statSync(f.dir).mode & 0o777).toBe(0o700)
  expect(f.sent[0]).toContain('new:')
  expect(f.sent[0]).toContain('vela serve')
  expect(f.stopped()).toBe(true)
  expect(f.notices.join('\n')).not.toContain('secret')
})

test('discovery ignores a DM and group non-mention before a human mention', async () => {
  const { discoverLarkGroup } = await import('@glows777/vela-lark')
  // biome-ignore lint/suspicious/noExplicitAny: fake event fixture exercises partial SDK payloads
  let onMessage: ((event: any) => void) | undefined
  let stopped = false
  const transport = {
    async getBotId() {
      return 'bot'
    },
    // biome-ignore lint/suspicious/noExplicitAny: fake event fixture exercises partial SDK payloads
    async start(callback: (event: any) => void) {
      onMessage = callback
    },
    async send() {},
    stop() {
      stopped = true
    },
  }
  // biome-ignore lint/suspicious/noExplicitAny: fake transport implements only the used methods
  const pending = discoverLarkGroup(transport as any)
  await new Promise((r) => setTimeout(r, 0))
  onMessage!({
    sender: { sender_type: 'user' },
    message: {
      chat_type: 'p2p',
      chat_id: 'dm',
      mentions: [{ id: { open_id: 'bot' } }],
    },
  })
  onMessage!({
    sender: { sender_type: 'user' },
    message: { chat_type: 'group', chat_id: 'wrong', mentions: [] },
  })
  onMessage!({
    sender: { sender_type: 'user' },
    message: {
      chat_type: 'group',
      chat_id: 'right',
      mentions: [{ id: { open_id: 'bot' } }],
    },
  })
  expect((await pending).chatId).toBe('right')
  expect(stopped).toBe(false)
})
