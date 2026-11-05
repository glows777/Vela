import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { connectLarkSetup } from '@glows777/vela-lark'

interface Connection {
  waitForMention(): Promise<{ chatId: string; chatName?: string }>
  send(chatId: string, text: string): Promise<unknown>
  stop(): void
}
interface Host {
  agentDir: string
  projectSettingsPath?: string
  input(
    title: string,
    placeholder?: string,
    signal?: AbortSignal,
    secret?: boolean,
  ): Promise<string | undefined>
  select(
    title: string,
    choices: { value: string; label: string }[],
  ): Promise<string | undefined>
  addNotice(text: string, level?: 'info' | 'warning' | 'error' | 'dim'): void
  setSummary(text: string): void
  signal?: AbortSignal
  connect?: (
    appId: string,
    appSecret: string,
    signal?: AbortSignal,
  ) => Promise<Connection>
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export async function larkSetup(host: Host): Promise<boolean> {
  const path = join(host.agentDir, 'settings.json')
  const settings = existsSync(path)
    ? object(JSON.parse(readFileSync(path, 'utf8')))
    : {}
  const extensionConfig = object(settings.extensionConfig)
  const lark = object(extensionConfig.lark)
  const checklist =
    'Create and publish a Lark app, enable its bot, select long connection, subscribe to im.message.receive_v1 and card.action.trigger, grant permissions, and add the bot to the group. Card callback and scopes are not checked by setup. Console: https://open.feishu.cn/app'
  if (
    !(await host.select(checklist, [{ value: 'continue', label: 'Continue' }]))
  )
    return false
  const expand = (value: string) =>
    value.replace(
      /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, a, b) => (match === '$$' ? '$' : (process.env[a ?? b] ?? '')),
    )
  let appId: string | undefined
  let secretInput: string | undefined
  if (typeof lark.appId === 'string' && typeof lark.appSecret === 'string') {
    const choice = await host.select('Lark credentials are saved', [
      { value: 'keep', label: 'Keep saved credentials' },
      { value: 'change', label: 'Replace credentials' },
    ])
    if (!choice) return false
    if (choice === 'change') {
      appId = await host.input('Lark App ID', undefined, host.signal)
      if (!appId) return false
      secretInput = await host.input('App Secret', undefined, host.signal, true)
      if (!secretInput) return false
    }
  } else {
    appId = await host.input('Lark App ID', undefined, host.signal)
    if (!appId) return false
    secretInput = await host.input('App Secret', undefined, host.signal, true)
    if (!secretInput) return false
  }
  const id =
    appId?.trim() || (typeof lark.appId === 'string' ? expand(lark.appId) : '')
  const secret =
    secretInput ||
    (typeof lark.appSecret === 'string' ? expand(lark.appSecret) : '')
  if (!id || !secret) {
    host.addNotice('App ID and App Secret are required', 'error')
    return false
  }
  let connection: Connection | undefined
  try {
    connection = await (host.connect ?? connectLarkSetup)(
      id,
      secret,
      host.signal,
    )
    host.addNotice(
      'Credentials verified. Mention the bot in the group to enable (Ctrl+C twice to cancel).',
    )
    const group = await connection.waitForMention()
    const confirmed = await host.select(
      `Enable ${group.chatName ?? group.chatId} (${group.chatId})? Every member of an enabled group has full access to Vela tools.`,
      [
        { value: 'yes', label: 'Enable group' },
        { value: 'no', label: 'Cancel' },
      ],
    )
    if (confirmed !== 'yes') return false
    if (typeof lark.chats === 'string' && lark.chats.includes('$')) {
      host.addNotice(
        'Existing chats use an environment expression. Add the group manually to preserve that setting.',
        'error',
      )
      return false
    }
    const chats: unknown[] = Array.isArray(lark.chats)
      ? [...lark.chats]
      : typeof lark.chats === 'string'
        ? lark.chats
            .split(',')
            .map((v: string) => v.trim())
            .filter(Boolean)
        : []
    if (
      !chats.some((entry) =>
        typeof entry === 'string'
          ? expand(entry).trim() === group.chatId
          : typeof object(entry).id === 'string' &&
            expand(object(entry).id as string).trim() === group.chatId,
      )
    )
      chats.push(group.chatId)
    extensionConfig.lark = {
      ...lark,
      appId: appId ? id.replace(/\$/g, () => '$$') : lark.appId,
      appSecret: secretInput
        ? secret.replace(/\$/g, () => '$$')
        : lark.appSecret,
      chats,
    }
    settings.extensionConfig = extensionConfig
    mkdirSync(host.agentDir, { recursive: true, mode: 0o700 })
    chmodSync(host.agentDir, 0o700)
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    })
    chmodSync(path, 0o600)
    try {
      await connection.send(
        group.chatId,
        'Vela is connected to this group; run `vela serve` and @ me.',
      )
    } catch (error) {
      const summary = `Configuration saved to ${path}, but sending the connection message failed: ${String(error).replaceAll(secret, '[redacted]')}. Check permissions at https://open.feishu.cn/app and retry.`
      host.addNotice(summary, 'error')
      host.setSummary(summary)
      return false
    }
    let override = ''
    let enabled = true
    const updateEnabled = (value: unknown) => {
      if (!Array.isArray(value)) return
      for (const entry of value) {
        if (entry === '-builtin:lark') enabled = false
        if (entry === '+builtin:lark' || entry === 'builtin:lark')
          enabled = true
      }
    }
    updateEnabled(settings.extensions)
    if (host.projectSettingsPath && existsSync(host.projectSettingsPath)) {
      const project = object(
        JSON.parse(readFileSync(host.projectSettingsPath, 'utf8')),
      )
      updateEnabled(project.extensions)
      const projectLark = object(object(project.extensionConfig).lark)
      const keys = ['appId', 'appSecret', 'chats'].filter(
        (key) => key in projectLark,
      )
      if (keys.length)
        override = ` Project settings ${host.projectSettingsPath} override user-level ${keys.join(', ')}; check the effective settings before starting.`
    }
    const disabled = enabled
      ? ''
      : ' Lark is disabled by extensions settings; remove -builtin:lark or add +builtin:lark before starting.'
    const summary = `Lark configured in ${path}. Connection message sent. Run vela serve, then mention the bot in the group. Card callback and other scopes were not checked.${override}${disabled}`
    host.addNotice(summary)
    host.setSummary(summary)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    host.addNotice(
      `Lark setup failed: ${message.replaceAll(secret, '[redacted]')}. Check permissions at https://open.feishu.cn/app`,
      'error',
    )
    connection?.stop()
    connection = undefined
    const retry = await host.select('Lark setup did not complete', [
      { value: 'retry', label: 'Retry setup' },
      { value: 'cancel', label: 'Cancel' },
    ])
    if (retry === 'retry' && !host.signal?.aborted) return larkSetup(host)
    return false
  } finally {
    connection?.stop()
  }
}
